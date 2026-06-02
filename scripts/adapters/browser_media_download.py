#!/usr/bin/env python3
"""
Playwright media sniffer adapter.

This is a project-local wrapper inspired by the existing read-later Douyin
Playwright downloader. It is intentionally narrow: navigate with Chromium,
collect likely video URLs from DOM and network responses, download the best
candidate, then emit the JSON contract consumed by src/acquisition.ts.
"""

import argparse
import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from playwright.async_api import async_playwright


USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

PLATFORM_MARKERS = {
    "douyin": ("douyinvod", "douyin.com/aweme/v1/play", "snssdk.com/aweme/v1/play"),
    "xiaohongshu": ("sns-video", "xhscdn", "redcdn", "xiaohongshu.com"),
    "wechat_channels": ("wxvideo", "finder.video.qq.com", "mpvideo.qpic.cn", "weixin.qq.com"),
}

DOUYIN_NON_TARGET_PATTERNS = (
    "douyin-pc-web/uuu_",
    "douyin_pc_client.mp4",
    "bytednsdoc.com/obj/eden-cn",
    "effectcdn-tos",
    "byteeffecttos.com",
)


def detect_platform(url: str) -> str:
    lower = url.lower()
    if "douyin.com" in lower:
        return "douyin"
    if "xiaohongshu.com" in lower or "xhslink.com" in lower:
        return "xiaohongshu"
    if "channels.weixin.qq.com" in lower or "weixin.qq.com" in lower:
        return "wechat_channels"
    return "unknown"


def normalize_url(value: str) -> str:
    value = value.strip().strip('"').strip("'")
    value = value.replace("\\u002F", "/").replace("\\u0026", "&")
    value = value.replace("\\/", "/")
    return urllib.parse.unquote(value)


def is_likely_video_url(url: str, content_type: str, platform: str) -> bool:
    lower_url = url.lower()
    lower_type = content_type.lower()
    if is_blocked_platform_asset(lower_url, platform):
        return False
    if lower_type.startswith("image/") or lower_url.split("?", 1)[0].endswith((".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif")):
        return False
    if "video" in lower_type or "application/vnd.apple.mpegurl" in lower_type:
        return True
    if any(ext in lower_url for ext in (".mp4", ".m3u8", ".mov", ".m4v")):
        return True
    markers = PLATFORM_MARKERS.get(platform, ())
    return any(marker in lower_url for marker in markers)


def is_blocked_platform_asset(url: str, platform: str) -> bool:
    lower_url = url.lower()
    if platform == "douyin":
        return any(pattern in lower_url for pattern in DOUYIN_NON_TARGET_PATTERNS)
    return False


def candidate_media_kind(candidate: dict) -> str:
    url = candidate.get("url", "").lower()
    content_type = candidate.get("contentType", "").lower()
    if content_type.startswith("audio/") or "media-audio" in url or "/audio/" in url:
        return "audio"
    if content_type.startswith("video/") or "media-video" in url or "/video/" in url:
        return "video"
    if ".m3u8" in url or ".mp4" in url or ".mov" in url or ".m4v" in url:
        return "video"
    return "unknown"


def score_candidate(candidate: dict, platform: str) -> int:
    url = candidate["url"].lower()
    content_type = candidate.get("contentType", "").lower()
    if is_blocked_platform_asset(url, platform):
        return -10_000
    score = 0
    kind = candidate_media_kind(candidate)
    if "video" in content_type:
        score += 40
    if ".mp4" in url:
        score += 30
    if ".m3u8" in url:
        score += 20
    for marker in PLATFORM_MARKERS.get(platform, ()):
        if marker in url:
            score += 15
    if platform == "douyin":
        if "douyinvod" in url:
            score += 100
        if "douyin.com/aweme/v1/play" in url or "snssdk.com/aweme/v1/play" in url:
            score += 80
        if "media-video" in url:
            score += 50
        if kind == "audio":
            score -= 120
    if "watermark" in url or "playwm" in url:
        score -= 5
    return score


async def collect_dom_candidates(page, platform: str) -> list[dict]:
    return await page.evaluate(
        """(platform) => {
          const out = [];
          const push = (url, method) => {
            if (url && /^https?:\\/\\//.test(url)) out.push({ url, method, contentType: "" });
          };

          for (const video of document.querySelectorAll("video")) {
            push(video.currentSrc || video.src || video.getAttribute("src"), "video-element");
            for (const source of video.querySelectorAll("source")) {
              push(source.src || source.getAttribute("src"), "source-element");
            }
          }

          const html = document.documentElement.innerHTML;
          const patterns = [
            /"playAddr"\\s*:\\s*\\[?\\s*\\{[^}]*"src"\\s*:\\s*"([^"]+)"/g,
            /"play_addr"[^}]*"url_list"\\s*:\\s*\\["([^"]+)"/g,
            /"download_addr"[^}]*"url_list"\\s*:\\s*\\["([^"]+)"/g,
            /playApi["']?\\s*:\\s*["']([^"']+)/g,
            /(https?:\\\\?\\/\\\\?\\/[^"'\\s]+(?:douyinvod|sns-video|xhscdn|redcdn|wxvideo|mpvideo\\.qpic)[^"'\\s]+)/g,
            /(https?:\\\\?\\/\\\\?\\/[^"'\\s]+\\.(?:mp4|m3u8)(?:\\?[^"'\\s]*)?)/g
          ];
          for (const pattern of patterns) {
            for (const match of html.matchAll(pattern)) {
              push(match[1] || match[0], "html-regex");
            }
          }
          return out;
        }""",
        platform,
    )


async def extract_metadata(page, final_url: str) -> dict:
    data = await page.evaluate(
        """() => {
          const text = (el) => (el && (el.innerText || el.textContent) || "").replace(/\\s+/g, " ").trim();
          const meta = (name) => document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content || "";
          const title = text(document.querySelector("h1")) || meta("og:title") || document.title || "";
          const desc = meta("og:description") || meta("description") || "";
          let author = "";
          for (const link of document.querySelectorAll('a[href*="/user/"], a[href*="/profile/"]')) {
            const value = text(link).replace(/作者$/, "").trim();
            if (value && value.length < 80) {
              author = value;
              break;
            }
          }
          const bodyText = document.body?.innerText || "";
          const durationMatch = bodyText.match(/(\\d{1,2}:\\d{2})\\s*\\/\\s*(\\d{1,2}:\\d{2})/);
          return { title, author, description: desc, duration: durationMatch ? durationMatch[2] : "" };
        }"""
    )
    video_id = ""
    match = re.search(r"/video/(\d+)", final_url)
    if match:
        video_id = match.group(1)
    data["video_id"] = video_id
    enrich_metadata_from_description(data)
    return data


def enrich_metadata_from_description(data: dict) -> None:
    description = str(data.get("description") or "")
    match = re.search(r"\s-\s(.+?)于(\d{8})发布", description)
    if not match:
        return
    author, raw_date = match.groups()
    if author:
        data["author"] = author.strip()
    data["published_at"] = f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:8]}"


def parse_duration(value: str) -> int | None:
    if not value:
        return None
    parts = value.split(":")
    try:
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    except ValueError:
        return None
    return None


def download_with_ffmpeg(url: str, output_path: Path, referer: str) -> None:
    headers = f"Referer: {referer}\r\nUser-Agent: {USER_AGENT}\r\n"
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-headers",
        headers,
        "-i",
        url,
        "-c",
        "copy",
        "-y",
        str(output_path),
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=180)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "ffmpeg media download failed")


def download_direct(url: str, output_path: Path, referer: str, cookie_header: str) -> None:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Referer": referer,
            "Cookie": cookie_header,
        },
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        with output_path.open("wb") as fh:
            while True:
                chunk = response.read(1024 * 512)
                if not chunk:
                    break
                fh.write(chunk)


def probe_media_info(path: Path) -> dict:
    proc = subprocess.run([
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration,size:stream=codec_type",
        "-of",
        "json",
        str(path),
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=20)
    if proc.returncode != 0:
        return {"duration": 0.0, "has_video": False, "has_audio": False}
    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        return {"duration": 0.0, "has_video": False, "has_audio": False}
    streams = data.get("streams") or []
    try:
        duration = float((data.get("format") or {}).get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0.0
    return {
        "duration": duration,
        "has_video": any(stream.get("codec_type") == "video" for stream in streams),
        "has_audio": any(stream.get("codec_type") == "audio" for stream in streams),
    }


def probe_video_duration(path: Path) -> float:
    return float(probe_media_info(path).get("duration") or 0)


def validate_downloaded_video(path: Path) -> dict:
    if not path.exists():
        raise RuntimeError("output file missing")
    if path.stat().st_size < 100_000:
        raise RuntimeError(f"output too small: {path.stat().st_size} bytes")
    info = probe_media_info(path)
    duration = float(info.get("duration") or 0)
    if duration < 1 or not info.get("has_video"):
        raise RuntimeError(f"output is not a playable video: duration={duration}")
    return info


def validate_downloaded_audio(path: Path) -> dict:
    if not path.exists():
        raise RuntimeError("audio output missing")
    if path.stat().st_size < 10_000:
        raise RuntimeError(f"audio output too small: {path.stat().st_size} bytes")
    info = probe_media_info(path)
    duration = float(info.get("duration") or 0)
    if duration < 1 or not info.get("has_audio"):
        raise RuntimeError(f"output is not playable audio: duration={duration}")
    return info


def download_media_candidate(candidate: dict, output_path: Path, referer: str, cookie_header: str) -> None:
    if ".m3u8" in candidate["url"].lower():
        download_with_ffmpeg(candidate["url"], output_path, referer)
    else:
        download_direct(candidate["url"], output_path, referer, cookie_header)


def merge_audio_video(video_path: Path, audio_path: Path, output_path: Path) -> None:
    temp_output = output_path.parent / f"{output_path.stem}.merged{output_path.suffix}"
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(video_path),
        "-i",
        str(audio_path),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c",
        "copy",
        "-shortest",
        "-y",
        str(temp_output),
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120)
    if proc.returncode != 0:
        temp_output.unlink(missing_ok=True)
        raise RuntimeError(proc.stderr.strip() or "audio/video merge failed")
    validate_downloaded_video(temp_output)
    shutil.move(str(temp_output), str(output_path))


def candidate_temp_path(output_path: Path, candidate: dict, suffix: str) -> Path:
    candidate_hash = hashlib.sha256(candidate["url"].encode()).hexdigest()[:8]
    return output_path.parent / f"{output_path.stem}.{candidate_hash}.{suffix}.mp4"


def env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def env_int(name: str, fallback: int) -> int:
    try:
        return int(os.environ.get(name, ""))
    except ValueError:
        return fallback


async def cookie_header_for(context) -> str:
    cookies = await context.cookies()
    return "; ".join(f"{item['name']}={item['value']}" for item in cookies if item.get("name"))


async def write_debug_artifacts(page, candidates: list[dict]) -> None:
    debug_dir = os.environ.get("VIDEO_LEARNING_BROWSER_DEBUG_DIR")
    if not debug_dir:
        return
    out = Path(debug_dir).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    await page.screenshot(path=str(out / "page.png"), full_page=True)
    (out / "page.html").write_text(await page.content(), encoding="utf-8")
    sanitized = []
    for candidate in candidates:
        parsed = urllib.parse.urlsplit(candidate.get("url", ""))
        sanitized.append({
            **candidate,
            "url": urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "[query-redacted]" if parsed.query else "", "")),
        })
    (out / "candidates.json").write_text(json.dumps(sanitized, ensure_ascii=False, indent=2), encoding="utf-8")


async def sniff_and_download(url: str, output_dir: Path, timeout_ms: int, headful: bool) -> dict:
    platform = detect_platform(url)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{platform}-{hashlib.sha256(url.encode()).hexdigest()[:16]}.mp4"
    candidates: list[dict] = []

    async with async_playwright() as pw:
        profile_dir = os.environ.get("VIDEO_LEARNING_BROWSER_PROFILE_DIR")
        if profile_dir:
            context = await pw.chromium.launch_persistent_context(
                profile_dir,
                headless=not headful,
                user_agent=USER_AGENT,
                locale="zh-CN",
                viewport={"width": 1920, "height": 1080},
                args=["--no-sandbox", "--disable-setuid-sandbox"],
            )
            browser = None
        else:
            browser = await pw.chromium.launch(
                headless=not headful,
                args=["--no-sandbox", "--disable-setuid-sandbox"],
            )
            context = await browser.new_context(
                user_agent=USER_AGENT,
                locale="zh-CN",
                viewport={"width": 1920, "height": 1080},
            )

        page = await context.new_page()

        async def on_response(response):
            content_type = response.headers.get("content-type", "")
            response_url = response.url
            if is_likely_video_url(response_url, content_type, platform):
                candidates.append({"url": response_url, "method": "network-response", "contentType": content_type})

        page.on("response", on_response)
        try:
            settle_ms = env_int("VIDEO_LEARNING_BROWSER_SETTLE_MS", 5000)
            after_click_ms = env_int("VIDEO_LEARNING_BROWSER_AFTER_CLICK_MS", 3000)
            await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            await page.wait_for_timeout(settle_ms)
            final_url = page.url
            candidates.extend(await collect_dom_candidates(page, platform))
            metadata = await extract_metadata(page, final_url)
            await page.mouse.click(960, 540)
            await page.wait_for_timeout(after_click_ms)
            candidates.extend(await collect_dom_candidates(page, platform))
            await write_debug_artifacts(page, candidates)

            normalized = []
            seen = set()
            for candidate in candidates:
                candidate_url = normalize_url(candidate["url"])
                if not candidate_url.startswith("http") or candidate_url in seen:
                    continue
                if not is_likely_video_url(candidate_url, candidate.get("contentType", ""), platform):
                    continue
                seen.add(candidate_url)
                normalized.append({**candidate, "url": candidate_url})

            if not normalized:
                raise RuntimeError("no playable media URL found")

            normalized.sort(key=lambda item: score_candidate(item, platform), reverse=True)
            primary_candidates = [item for item in normalized if candidate_media_kind(item) != "audio"]
            audio_candidates = [item for item in normalized if candidate_media_kind(item) == "audio"]
            if not primary_candidates:
                primary_candidates = normalized
            cookie_header = await cookie_header_for(context)
            errors = []
            for candidate in primary_candidates[:8]:
                temp_video_path = candidate_temp_path(output_path, candidate, "video")
                try:
                    download_media_candidate(candidate, temp_video_path, final_url, cookie_header)
                    video_info = validate_downloaded_video(temp_video_path)
                    if not video_info.get("has_audio"):
                        for audio_candidate in audio_candidates[:6]:
                            temp_audio_path = candidate_temp_path(output_path, audio_candidate, "audio")
                            try:
                                download_media_candidate(audio_candidate, temp_audio_path, final_url, cookie_header)
                                validate_downloaded_audio(temp_audio_path)
                                merge_audio_video(temp_video_path, temp_audio_path, output_path)
                                break
                            except Exception as exc:
                                output_path.unlink(missing_ok=True)
                                errors.append(f"{audio_candidate.get('method')} audio: {exc}")
                            finally:
                                temp_audio_path.unlink(missing_ok=True)
                    if not output_path.exists():
                        shutil.move(str(temp_video_path), str(output_path))
                    validate_downloaded_video(output_path)
                    temp_video_path.unlink(missing_ok=True)
                    return {
                        "path": str(output_path),
                        "title": metadata.get("title") or None,
                        "author": metadata.get("author") or None,
                        "durationSec": parse_duration(metadata.get("duration") or ""),
                        "publishedAt": metadata.get("published_at") or None,
                        "source_url": final_url,
                        "adapter": "playwright-media-sniffer",
                        "platform": platform,
                        "method": candidate.get("method"),
                        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    }
                except Exception as exc:
                    if output_path.exists():
                        output_path.unlink(missing_ok=True)
                    if temp_video_path.exists():
                        temp_video_path.unlink(missing_ok=True)
                    errors.append(f"{candidate.get('method')}: {exc}")

            raise RuntimeError("; ".join(errors[-3:]) or "media download failed")
        finally:
            await context.close()
            if browser:
                await browser.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--out-dir", default=str(Path.cwd() / "downloads"))
    parser.add_argument("--timeout-ms", type=int, default=30_000)
    parser.add_argument("--headful", action="store_true")
    args = parser.parse_args()

    try:
        result = asyncio.run(sniff_and_download(
            args.url,
            Path(args.out_dir),
            args.timeout_ms,
            args.headful or env_flag("VIDEO_LEARNING_BROWSER_HEADFUL"),
        ))
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(f"[browser-media] {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
