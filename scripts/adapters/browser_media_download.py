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
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeoutError


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
          const author = meta("author") || meta("article:author") || "";
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


def media_durations_match(video_duration: float, audio_duration: float) -> bool:
    return abs(video_duration - audio_duration) <= max(1.0, video_duration * 0.03)


def merge_audio_video(video_path: Path, audio_path: Path, output_path: Path, expected_duration: float | None = None) -> None:
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
        "-y",
        str(temp_output),
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120)
    if proc.returncode != 0:
        temp_output.unlink(missing_ok=True)
        raise RuntimeError(proc.stderr.strip() or "audio/video merge failed")
    try:
        merged_info = validate_downloaded_video(temp_output)
        expected = expected_duration if expected_duration is not None else probe_video_duration(video_path)
        if expected > 0 and not media_durations_match(expected, merged_info["duration"]):
            raise RuntimeError("Merged media duration differs from the complete source video")
        shutil.move(str(temp_output), str(output_path))
    finally:
        temp_output.unlink(missing_ok=True)


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


def resolve_profile_dir(platform: str) -> str | None:
    if platform == "douyin":
        return os.environ.get("VIDEO_LEARNING_DOUYIN_BROWSER_PROFILE_DIR") or os.environ.get("VIDEO_LEARNING_BROWSER_PROFILE_DIR")
    return os.environ.get("VIDEO_LEARNING_BROWSER_PROFILE_DIR")


def resolve_proxy(platform: str) -> dict[str, str] | None:
    server = os.environ.get(f"VIDEO_LEARNING_{platform.upper()}_PROXY") or os.environ.get("VIDEO_LEARNING_BROWSER_PROXY")
    if not server:
        return None
    return {"server": server}


async def cookie_header_for(context) -> str:
    cookies = await context.cookies()
    return "; ".join(f"{item['name']}={item['value']}" for item in cookies if item.get("name"))


class AcquisitionError(RuntimeError):
    def __init__(self, code: str, phase: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code, self.phase, self.retryable = code, phase, retryable
        self.diagnostics_path = None
        self.details = {}

    def envelope(self) -> dict:
        actions = {
            "auth_required": ["Open the configured browser profile and complete the site's playback login."],
            "challenge": ["Open the site manually and resolve its access challenge."],
            "media_unavailable": ["Check whether the requested video is still available."],
            "target_mismatch": ["Check the requested video URL and the redirected page."],
            "network_failed": ["Inspect the network summary and site connectivity."],
            "navigation_timeout": ["Inspect the navigation and network summaries."],
            "no_media_candidates": ["Inspect the page and player summary; the cause is not established."],
        }
        return {"error": {"code": self.code, "phase": self.phase, "message": str(self),
                          "retryable": self.retryable, "diagnostics_path": self.diagnostics_path,
                          "next_actions": actions.get(self.code, ["Inspect the structured diagnostics."]),
                          "details": self.details}}


def safe_url(value: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme not in {"http", "https"}:
            return parsed.scheme + ":" if parsed.scheme else ""
        host = parsed.hostname or ""
        if parsed.port:
            host += f":{parsed.port}"
        return urllib.parse.urlunsplit((parsed.scheme, host, parsed.path, "", ""))
    except ValueError:
        return ""


def safe_title(value: str) -> str:
    value = re.sub(r"https?://[^\s<>]+", lambda m: safe_url(m.group()), value)
    value = re.sub(r"(?i)(token|cookie|authorization|password|sessionid|secret)(\s*[=:]\s*)[^\s;,]+", r"\1\2[redacted]", value)
    return value[:200]


def target_video_id(url: str) -> str | None:
    match = re.search(r"/(?:video|share/video)/(\d+)(?:/|$)", urllib.parse.urlsplit(url).path)
    return match.group(1) if match else None


def profile_source(platform: str) -> str:
    if platform == "douyin" and os.environ.get("VIDEO_LEARNING_DOUYIN_BROWSER_PROFILE_DIR"):
        return "platform_profile"
    return "generic_profile" if os.environ.get("VIDEO_LEARNING_BROWSER_PROFILE_DIR") else "ephemeral"


def normalize_candidates(candidates: list[dict], platform: str) -> list[dict]:
    out, seen = [], set()
    for candidate in candidates:
        value = normalize_url(candidate.get("url", ""))
        if not value.startswith(("http://", "https://")) or value in seen:
            continue
        if not is_likely_video_url(value, candidate.get("contentType", ""), platform):
            continue
        seen.add(value)
        out.append({**candidate, "url": value})
    return out


async def inspect_player(page) -> dict:
    # Private URLs stay in memory. Only the explicit safe fields are persisted below.
    return await page.evaluate(r"""() => {
      const visible = el => {
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'
          && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
      };
      const all = Array.from(document.querySelectorAll('video'));
      const shown = all.filter(visible).sort((a,b) => {
        const x=a.getBoundingClientRect(), y=b.getBoundingClientRect();
        return y.width*y.height-x.width*x.height;
      });
      const active = shown[0];
      if (active && active.paused) {
        active.muted = true;
        const play = active.play();
        if (play && play.catch) play.catch(() => {});
      }
      const activeUrls = active ? [active.currentSrc, active.src, ...Array.from(active.querySelectorAll('source')).map(s=>s.src)].filter(Boolean) : [];
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],main,[role="main"],[role="alert"]')).filter(visible);
      // Generic login buttons or an optional login modal are not proof of a playback gate.
      const regions = dialogs.length ? dialogs : [document.body].filter(Boolean);
      const lines = regions.flatMap(el => (el.innerText || '').split(/\n/).map(x=>x.trim()).filter(Boolean));
      const auth = lines.some(x => /^(请先登录后观看|请登录后观看|登录后才能观看|登录后即可观看本视频|Sign in to watch this video|Log in to watch this video)[。.!！]?$/.test(x));
      const unavailable = lines.some(x => /^(视频已删除|视频不存在|该视频已删除|该视频不存在|该视频暂时无法观看|This video is unavailable|Video unavailable|This video has been removed)[。.!！]?$/.test(x));
      const challengeWidgets = Array.from(document.querySelectorAll('iframe[src*="captcha"],[id*="captcha"],[class*="captcha"],[id*="verify"]')).filter(visible);
      const challenge = challengeWidgets.length > 0 && lines.some(x => /拖动滑块|完成验证|安全验证|Verify you are human|Complete the security check/i.test(x));
      return {title: document.title || '', video_count: all.length, visible_video_count: shown.length,
        ready_state: active ? active.readyState : null, video_error_codes: all.map(v=>v.error && v.error.code).filter(Boolean),
        active_urls: activeUrls, has_blob_player: activeUrls.some(x=>x.startsWith('blob:')),
        blocking: {auth_required: auth, challenge, media_unavailable: unavailable}};
    }""")


def record_player(diag: dict, state: dict, page_url: str) -> None:
    diag.update({"final_url": safe_url(page_url), "page_title": safe_title(state.get("title", "")),
                 "target_video_id": target_video_id(page_url), "player": {
                     k: state.get(k) for k in ("video_count", "visible_video_count", "ready_state", "video_error_codes")}})
    diag["blocking_evidence"] = [key for key, value in state.get("blocking", {}).items() if value]


def classify_readiness_failure(diag: dict) -> AcquisitionError:
    evidence = diag.get("blocking_evidence", [])
    for code, message in [("challenge", "An explicit visible access challenge blocks playback."),
                          ("auth_required", "An explicit playback login gate is visible."),
                          ("media_unavailable", "The page explicitly reports that the requested video is unavailable.")]:
        if code in evidence:
            return AcquisitionError(code, "media_readiness", message)
    network = diag.get("network", {})
    if network.get("active_media_failed_requests", 0) or network.get("main_document_error", False) or network.get("active_media_http_errors_by_status"):
        statuses = [int(s) for s in network.get("active_media_http_errors_by_status", {})]
        if network.get("main_document_status"):
            statuses.append(network["main_document_status"])
        types = set(network.get("active_media_failure_types", {}))
        if network.get("main_document_failure_type"):
            types.add(network["main_document_failure_type"])
        transient = any(s in {408, 429} or s >= 500 for s in statuses) or bool(types & {
            "net::ERR_TIMED_OUT", "net::ERR_CONNECTION_RESET", "net::ERR_CONNECTION_CLOSED", "net::ERR_NETWORK_CHANGED"})
        return AcquisitionError("network_failed", "media_readiness", "Media did not become ready and relevant network failures were observed.", transient)
    return AcquisitionError("no_media_candidates", "media_readiness", "No media associated with the visible player became ready before the deadline; cause unknown.")


def readiness_budget_ms() -> int:
    # Keep legacy timing knobs as a bounded total-budget hint, rather than blind sleeps.
    legacy = env_int("VIDEO_LEARNING_BROWSER_SETTLE_MS", 5000) + env_int("VIDEO_LEARNING_BROWSER_AFTER_CLICK_MS", 3000)
    return max(1000, min(60000, env_int("VIDEO_LEARNING_BROWSER_READY_TIMEOUT_MS", max(25000, legacy))))


async def wait_for_media(page, candidates: list[dict], platform: str, deadline: float, diag: dict,
                         expected_id: str | None = None, now=time.monotonic, sleep=asyncio.sleep,
                         observations: dict | None = None) -> list[dict]:
    stable_since, last_signature = None, None
    while now() < deadline:
        remaining_ms = max(1, int((deadline - now()) * 1000))
        try:
            state = await asyncio.wait_for(inspect_player(page), remaining_ms / 1000)
            candidates.extend({"url": url, "method": "active-video-element", "contentType": ""}
                              for url in state.get("active_urls", []) if url.startswith(("http://", "https://")))
            record_player(diag, state, page.url)
            current_id = target_video_id(page.url)
            diag["target_route_verified"] = bool(expected_id and current_id == expected_id)
            if expected_id and current_id and expected_id != current_id:
                raise AcquisitionError("target_mismatch", "media_readiness", "Navigation resolved to a different video ID.")
            active = {normalize_url(url) for url in state.get("active_urls", [])}
            if observations is not None:
                net = diag["network"]
                active_failure_types = {}
                for url, code in observations["failed_media_urls"]:
                    if url in active:
                        active_failure_types[code] = active_failure_types.get(code, 0) + 1
                net["active_media_failure_types"] = active_failure_types
                net["active_media_failed_requests"] = sum(active_failure_types.values())
                active_errors = {}
                for url, status in observations["media_http_errors"]:
                    if url in active:
                        active_errors[str(status)] = active_errors.get(str(status), 0) + 1
                net["active_media_http_errors_by_status"] = active_errors
            normalized = normalize_candidates(candidates, platform)
            primary = [c for c in normalized if candidate_media_kind(c) != "audio"]
            associated = [c for c in primary if c["url"] in active]
            diag["candidates"] = {"observed": len(candidates), "unique": len(normalized), "primary": len(primary), "player_associated": len(associated)}
            # A visible HTTP player is the primary identity boundary. MSE/blob playback can
            # only provide a weaker network association, which is explicitly reported.
            usable = associated or (primary if state.get("has_blob_player") and (state.get("ready_state") or 0) >= 2 else [])
            if usable and state.get("visible_video_count", 0) > 0 and (state.get("ready_state") or 0) >= 1:
                signature = tuple(sorted(c["url"] for c in normalized))
                if signature != last_signature:
                    stable_since, last_signature = now(), signature
                # Allow separately requested audio to arrive before selecting a video.
                if now() - stable_since >= 1.0:
                    diag["media_identity"] = "active_player_url" if associated else "unverified_network_for_blob_player"
                    audio = [c for c in normalized if candidate_media_kind(c) == "audio"]
                    return sorted(usable, key=lambda c: score_candidate(c, platform), reverse=True) + audio
            else:
                stable_since, last_signature = None, None
            if diag.get("blocking_evidence") and not usable:
                raise classify_readiness_failure(diag)
        except AcquisitionError:
            raise
        except asyncio.TimeoutError:
            break
        except Exception as exc:
            diag["player_inspection_errors"] = diag.get("player_inspection_errors", 0) + 1
            diag["last_inspection_error_type"] = type(exc).__name__
        await sleep(min(0.25, max(0, deadline - now())))
    raise classify_readiness_failure(diag)


async def discover_media(page, url: str, candidates: list[dict], platform: str, timeout_ms: int, diag: dict,
                         budget_ms: int | None = None, now=time.monotonic, sleep=asyncio.sleep,
                         observations: dict | None = None) -> list[dict]:
    started = now()
    budget = (readiness_budget_ms() if budget_ms is None else budget_ms) / 1000
    recovery_budget = min(10.0, budget)
    deadline = started + budget + recovery_budget
    expected = target_video_id(url)
    for attempt in range(2):
        diag["navigation_attempts"] = attempt + 1
        attempt_deadline = started + budget if attempt == 0 else min(deadline, now() + recovery_budget)
        candidates.clear()
        diag["candidates"] = {"observed": 0, "unique": 0, "primary": 0, "player_associated": 0}
        if observations is not None:
            observations["failed_media_urls"].clear()
            observations["media_http_errors"].clear()
        diag["blocking_evidence"] = []
        diag["network"] = {"responses_by_status": {}, "responses_by_resource_type": {}, "failed_requests": 0,
                           "failure_types": {}, "main_document_error": False, "media_http_errors_by_status": {}}
        try:
            diag["phase"] = "navigation"
            remaining = max(1, int((attempt_deadline - now()) * 1000))
            response = await page.goto(url, wait_until="domcontentloaded", timeout=min(timeout_ms, remaining))
            if not expected:
                expected = target_video_id(page.url)
            diag["expected_video_id"] = expected
            if response and response.status >= 400:
                diag["network"]["main_document_error"] = True
                diag["network"]["main_document_status"] = response.status
            diag["phase"] = "media_readiness"
            return await wait_for_media(page, candidates, platform, attempt_deadline, diag, expected, now, sleep, observations)
        except PlaywrightTimeoutError:
            error = AcquisitionError("navigation_timeout", "navigation", "Navigation did not complete before its deadline.", True)
        except AcquisitionError as exc:
            error = exc
        except Exception as exc:
            diag["navigation_error_type"] = type(exc).__name__
            has_network_evidence = bool(diag.get("network", {}).get("main_document_error"))
            if has_network_evidence:
                error = classify_readiness_failure(diag)
                error.phase = "navigation"
            else:
                error = AcquisitionError("adapter_failed", "navigation", "Navigation failed before the player could be inspected.")
        diag.setdefault("attempts", []).append({"attempt": attempt + 1, "code": error.code, "phase": error.phase,
                                                "elapsed_ms": int((now() - started) * 1000),
                                                "network": diag.get("network", {}), "candidates": diag.get("candidates", {})})
        # Recovery is driven by the typed discovery outcome, never exception-message matching.
        if not error.retryable or attempt == 1 or deadline - now() < 1.0:
            raise error
    raise AssertionError("bounded recovery exhausted")


async def write_debug_artifacts(page, run_dir: Path) -> None:
    # Raw HTML can contain credentials. Debug mode only adds a screenshot, never HTML or URLs.
    if not os.environ.get("VIDEO_LEARNING_BROWSER_DEBUG_DIR") or page is None:
        return
    try:
        await page.screenshot(path=str(run_dir / "page.png"), full_page=True, timeout=3000)
    except Exception:
        pass


def safe_download_error(exc: Exception, stage: str) -> dict:
    result = {"stage": stage, "type": type(exc).__name__}
    if isinstance(exc, AcquisitionError):
        result["code"] = exc.code
    if isinstance(exc, urllib.error.HTTPError):
        result["http_status"] = exc.code
    elif isinstance(exc, urllib.error.URLError):
        result["reason_type"] = type(exc.reason).__name__
        if isinstance(getattr(exc.reason, "errno", None), int):
            result["errno"] = exc.reason.errno
    return result


def publish_candidates(normalized: list[dict], output_path: Path, referer: str, cookie_header: str, diag: dict) -> dict:
    primary = [item for item in normalized if candidate_media_kind(item) != "audio"]
    audio_candidates = [item for item in normalized if candidate_media_kind(item) == "audio"]
    errors = []
    incomplete_error = None
    for candidate in primary[:8]:
        temp_video_path = candidate_temp_path(output_path, candidate, "video")
        try:
            diag["phase"] = "download"
            download_media_candidate(candidate, temp_video_path, referer, cookie_header)
            diag["phase"] = "validation"
            video_info = validate_downloaded_video(temp_video_path)
            if not video_info.get("has_audio"):
                diag["phase"] = "audio"
                for audio_candidate in audio_candidates[:6]:
                    temp_audio_path = candidate_temp_path(output_path, audio_candidate, "audio")
                    try:
                        download_media_candidate(audio_candidate, temp_audio_path, referer, cookie_header)
                        audio_info = validate_downloaded_audio(temp_audio_path)
                        if not media_durations_match(video_info["duration"], audio_info["duration"]):
                            raise AcquisitionError("duration_mismatch", "audio", "The separate audio duration does not match the complete video.")
                        merge_audio_video(temp_video_path, temp_audio_path, output_path, video_info["duration"])
                        break
                    except Exception as exc:
                        output_path.unlink(missing_ok=True)
                        errors.append(safe_download_error(exc, "audio"))
                    finally:
                        temp_audio_path.unlink(missing_ok=True)
                if audio_candidates and not output_path.exists():
                    incomplete_error = AcquisitionError("incomplete_media", "audio", "A separate audio stream was discovered, but no audio candidate could be downloaded and merged.")
                    raise incomplete_error
            if not output_path.exists():
                # output_path is unique to this invocation; existing library assets are never touched.
                temp_video_path.replace(output_path)
            diag["downloaded_media"] = validate_downloaded_video(output_path)
            diag["download_errors"] = errors[-12:]
            return candidate
        except Exception as exc:
            output_path.unlink(missing_ok=True)
            errors.append(safe_download_error(exc, diag["phase"]))
        finally:
            temp_video_path.unlink(missing_ok=True)
    diag["download_errors"] = errors[-12:]
    if incomplete_error:
        raise incomplete_error
    raise AcquisitionError("download_failed", "download", "The discovered media candidates could not be downloaded and validated.")


async def sniff_and_download(url: str, output_dir: Path, timeout_ms: int, headful: bool) -> dict:
    started = time.monotonic()
    platform = detect_platform(url)
    run_id = uuid.uuid4().hex[:12]
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{platform}-{hashlib.sha256(url.encode()).hexdigest()[:16]}-{run_id}.mp4"
    debug_root = os.environ.get("VIDEO_LEARNING_BROWSER_DEBUG_DIR")
    run_dir = (Path(debug_root).expanduser().resolve() if debug_root else output_dir.parent / "diagnostics") / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    diagnostics_path = run_dir / "diagnostics.json"
    diag = {"schema_version": 1, "run_id": run_id, "phase": "browser_launch", "code": "running",
            "final_url": safe_url(url), "page_title": "", "target_video_id": target_video_id(url),
            "profile_source": profile_source(platform), "navigation_attempts": 0,
            "candidates": {"observed": 0, "unique": 0, "primary": 0, "player_associated": 0}}
    candidates = []
    observations = {"failed_media_urls": [], "media_http_errors": []}
    page = context = browser = None
    error = None
    result = None
    try:
        async with async_playwright() as pw:
            try:
                profile_dir, proxy = resolve_profile_dir(platform), resolve_proxy(platform)
                launch = {"headless": not headful, "proxy": proxy, "args": ["--no-sandbox", "--disable-setuid-sandbox"]}
                settings = {"user_agent": USER_AGENT, "locale": "zh-CN", "viewport": {"width": 1920, "height": 1080}}
                if profile_dir:
                    context = await pw.chromium.launch_persistent_context(profile_dir, **launch, **settings)
                else:
                    browser = await pw.chromium.launch(**launch)
                    context = await browser.new_context(**settings)
                page = await context.new_page()

                def on_response(response):
                    net = diag.setdefault("network", {})
                    counts = net.setdefault("responses_by_status", {})
                    status = str(response.status)
                    counts[status] = counts.get(status, 0) + 1
                    resource_type = response.request.resource_type
                    resources = net.setdefault("responses_by_resource_type", {}).setdefault(resource_type, {})
                    resources[status] = resources.get(status, 0) + 1
                    content_type = response.headers.get("content-type", "")
                    if response.status >= 400 and is_likely_video_url(response.url, content_type, platform):
                        errors_by_status = net.setdefault("media_http_errors_by_status", {})
                        errors_by_status[status] = errors_by_status.get(status, 0) + 1
                        if len(observations["media_http_errors"]) < 100:
                            observations["media_http_errors"].append((normalize_url(response.url), response.status))
                    if 200 <= response.status < 300 and is_likely_video_url(response.url, content_type, platform):
                        candidates.append({"url": response.url, "method": "network-response", "contentType": content_type})

                def on_request_failed(request):
                    net = diag.setdefault("network", {})
                    net["failed_requests"] = net.get("failed_requests", 0) + 1
                    # Error strings may embed private URLs; retain only the browser's code.
                    match = re.search(r"net::ERR_[A-Z_]+", request.failure or "")
                    code = match.group() if match else "request_failed"
                    if request.is_navigation_request() and request.frame == page.main_frame:
                        net["main_document_error"] = True
                        net["main_document_failure_type"] = code
                    if request.resource_type == "media" or is_likely_video_url(request.url, "", platform):
                        if len(observations["failed_media_urls"]) < 100:
                            observations["failed_media_urls"].append((normalize_url(request.url), code))
                    counts = net.setdefault("failure_types", {})
                    counts[code] = counts.get(code, 0) + 1

                page.on("response", on_response)
                page.on("requestfailed", on_request_failed)
                normalized = await discover_media(page, url, candidates, platform, timeout_ms, diag, observations=observations)
                diag["phase"] = "metadata"
                metadata = await extract_metadata(page, page.url)
                cookie_header = await cookie_header_for(context)
                selected = await asyncio.to_thread(publish_candidates, normalized, output_path, page.url, cookie_header, diag)
                diag.update({"phase": "complete", "code": "success", "selected_method": selected.get("method")})
                result = {"path": str(output_path), "title": metadata.get("title") or None,
                          "author": metadata.get("author") or None, "durationSec": diag["downloaded_media"].get("duration") or parse_duration(metadata.get("duration") or ""),
                          "publishedAt": metadata.get("published_at") or None, "source_url": safe_url(page.url),
                          "adapter": "playwright-media-sniffer", "platform": platform, "method": selected.get("method"),
                          "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                          "diagnostics_path": str(diagnostics_path)}
            finally:
                if page is not None:
                    diag["final_url"] = safe_url(page.url)
                    await write_debug_artifacts(page, run_dir)
                if context is not None:
                    try:
                        await context.close()
                    except Exception:
                        diag["cleanup_error"] = "context_close_failed"
                if browser is not None:
                    try:
                        await browser.close()
                    except Exception:
                        diag["cleanup_error"] = "browser_close_failed"
    except AcquisitionError as exc:
        error = exc
    except Exception as exc:
        diag["exception_type"] = type(exc).__name__
        error = AcquisitionError("adapter_failed", diag["phase"], "The browser adapter failed; inspect the safe diagnostics.")
    finally:
        if error:
            diag.update({"phase": error.phase, "code": error.code, "retryable": error.retryable})
        diag["elapsed_ms"] = int((time.monotonic() - started) * 1000)
        diagnostics_path.write_text(json.dumps(diag, ensure_ascii=False, indent=2), encoding="utf-8")
    if error:
        error.diagnostics_path = str(diagnostics_path)
        error.details = {"navigation_attempts": diag["navigation_attempts"], "candidates": diag["candidates"],
                         "blocking_evidence": diag.get("blocking_evidence", [])}
        raise error
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--out-dir", default=str(Path.cwd() / "downloads"))
    parser.add_argument("--timeout-ms", type=int, default=30_000)
    parser.add_argument("--headful", action="store_true")
    args = parser.parse_args()
    try:
        result = asyncio.run(sniff_and_download(args.url, Path(args.out_dir), args.timeout_ms,
                                                args.headful or env_flag("VIDEO_LEARNING_BROWSER_HEADFUL")))
        print(json.dumps(result, ensure_ascii=False))
    except AcquisitionError as exc:
        print(json.dumps(exc.envelope(), ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
    except Exception:
        error = AcquisitionError("adapter_failed", "initialization", "Unable to initialize the browser adapter.")
        print(json.dumps(error.envelope(), ensure_ascii=False), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
