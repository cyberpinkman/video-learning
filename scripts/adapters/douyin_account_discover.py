#!/usr/bin/env python3
"""
Douyin account video discovery adapter.

This script only discovers account works metadata. It does not download media,
run STT, call LLMs, or write project data. The TypeScript CLI persists the final
JSON result in SQLite.
"""

import argparse
import asyncio
import json
import os
import re
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from playwright.async_api import async_playwright


USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

LOGIN_COOKIE_NAMES = {
    "sid_guard",
    "sessionid",
    "sessionid_ss",
    "uid_tt",
    "uid_tt_ss",
    "sid_tt",
    "sso_uid_tt",
    "sso_uid_tt_ss",
}


def parse_expected_count(text: str) -> int | None:
    match = re.search(r"作品\s*([0-9,]+)", text)
    if not match:
        return None
    try:
        return int(match.group(1).replace(",", ""))
    except ValueError:
        return None


def parse_account_id(url: str) -> str | None:
    match = re.search(r"/user/([^/?#]+)", url)
    return urllib.parse.unquote(match.group(1)) if match else None


def parse_author(title: str, text: str) -> str | None:
    title = title.strip()
    suffix = "的抖音 - 抖音"
    if title.endswith(suffix):
        author = title[: -len(suffix)].strip()
        if author:
            return author
    for line in text.splitlines():
        line = line.strip()
        if line and len(line) < 80 and not line.startswith(("作品", "粉丝", "获赞")):
            if "抖音" not in line and "开启读屏" not in line:
                return line
    return None


def env_flag(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off"}


def env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    return parsed if parsed > 0 else default


def resolve_profile_dir() -> str:
    configured = os.environ.get("VIDEO_LEARNING_DOUYIN_BROWSER_PROFILE_DIR") or os.environ.get("VIDEO_LEARNING_BROWSER_PROFILE_DIR")
    if configured:
        return configured
    return str(Path.home() / ".video-learning" / "browser-profiles" / "douyin")


def iso_from_timestamp(value: Any) -> str | None:
    if not isinstance(value, (int, float)) or value <= 0:
        return None
    seconds = value / 1000 if value > 10_000_000_000 else value
    return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def summarize_aweme(item: dict[str, Any]) -> dict[str, Any] | None:
    aweme_id = str(item.get("aweme_id") or item.get("awemeId") or item.get("awemeIdStr") or item.get("itemId") or "").strip()
    if not aweme_id:
        return None
    aweme_type = item.get("aweme_type") or item.get("awemeType") or item.get("AwemeType")
    is_note = bool(item.get("image_post_info") or item.get("images") or aweme_type in (68, "68"))
    video = item.get("video") if isinstance(item.get("video"), dict) else {}
    duration_ms = video.get("duration") if isinstance(video, dict) else item.get("duration")
    author = item.get("author") if isinstance(item.get("author"), dict) else {}
    author_name = author.get("nickname") if isinstance(author, dict) else None
    return {
        "platformVideoId": aweme_id,
        "url": f"https://www.douyin.com/{'note' if is_note else 'video'}/{aweme_id}",
        "type": "note" if is_note else "video",
        "description": str(item.get("desc") or item.get("title") or item.get("preview_title") or "")[:500],
        "author": author_name or item.get("nickname"),
        "publishedAt": iso_from_timestamp(item.get("create_time") or item.get("createTime")),
        "durationSec": float(duration_ms) / 1000 if isinstance(duration_ms, (int, float)) else None,
    }


def dedupe_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        key = str(item.get("platformVideoId") or item.get("url") or "")
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


def build_post_url(sec_user_id: str, cursor: int | str) -> str:
    params = {
        "device_platform": "webapp",
        "aid": "6383",
        "channel": "channel_pc_web",
        "sec_user_id": sec_user_id,
        "max_cursor": str(cursor),
        "locate_query": "false",
        "show_live_replay_strategy": "1",
        "need_time_list": "1",
        "time_list_query": "0",
        "whale_cut_token": "",
        "cut_version": "1",
        "count": "18",
        "publish_video_strategy_type": "2",
        "update_version_code": "170400",
        "pc_client_type": "1",
        "pc_libra_divert": "Mac",
        "support_h265": "0",
        "support_dash": "0",
        "cpu_core_num": "8",
        "version_code": "290100",
        "version_name": "29.1.0",
        "cookie_enabled": "true",
        "screen_width": "1365",
        "screen_height": "900",
        "browser_language": "zh-CN",
        "browser_platform": "MacIntel",
        "browser_name": "Chrome",
        "browser_version": "131.0.0.0",
        "browser_online": "true",
        "engine_name": "Blink",
        "engine_version": "131.0.0.0",
        "os_name": "Mac OS",
        "os_version": "10.15.7",
        "webid": "",
        "msToken": "",
    }
    return "https://www.douyin.com/aweme/v1/web/aweme/post/?" + urllib.parse.urlencode(params)


def discovery_status(author: str | None, account_id: str | None, expected_count: int | None, discovered_count: int, auth_required: bool) -> str:
    if auth_required or not author or not account_id or expected_count is None:
        return "failed"
    return "success" if discovered_count == expected_count else "partial"


async def auth_state(context) -> dict[str, Any]:
    cookies = await context.cookies("https://www.douyin.com")
    names = sorted({str(cookie.get("name") or "") for cookie in cookies})
    return {
        "cookieCount": len(names),
        "hasLoginCookie": any(name in LOGIN_COOKIE_NAMES for name in names),
        "loginCookieNames": [name for name in names if name in LOGIN_COOKIE_NAMES],
    }


async def wait_for_login_if_visible(context, page, initial: dict[str, Any], headless: bool) -> dict[str, Any]:
    if headless or initial.get("hasLoginCookie"):
        return initial
    wait_ms = env_int("VIDEO_LEARNING_DOUYIN_LOGIN_WAIT_MS", 180_000)
    deadline = time.monotonic() + (wait_ms / 1000)
    try:
        await page.bring_to_front()
    except Exception:
        pass
    while time.monotonic() < deadline:
        current = await auth_state(context)
        if current.get("hasLoginCookie"):
            return current
        await page.wait_for_timeout(1000)
    return await auth_state(context)


async def signed_fetch(page, url: str) -> dict[str, Any]:
    return await page.evaluate(
        """async (url) => {
          let finalUrl = url;
          let signError = null;
          try {
            const signed = window.byted_acrawler?.frontierSign?.({ url });
            if (signed?.["X-Bogus"]) finalUrl += "&X-Bogus=" + encodeURIComponent(signed["X-Bogus"]);
          } catch (error) {
            signError = String(error);
          }
          const res = await fetch(finalUrl, { credentials: "include" });
          const text = await res.text();
          let parsed = null;
          try { parsed = JSON.parse(text); } catch (error) {}
          return {
            status: res.status,
            bytes: new TextEncoder().encode(text).length,
            parsed,
            signError,
          };
        }""",
        url,
    )


async def collect_frontend_module_items(page, sec_user_id: str, expected_count: int | None) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    max_pages = 20
    if isinstance(expected_count, int) and expected_count > 0:
        max_pages = max(4, min(40, (expected_count // 18) + 4))
    data = await page.evaluate(
        """async ({ secUserId, maxPages }) => {
          const out = { items: [], pages: [], moduleError: null, requestLayer: "pc-webpack-fetchUserPost" };
          let req = null;
          try {
            window.webpackChunkdouyin_web.push([[Math.floor(Math.random() * 1e9)], {}, r => { req = r; }]);
          } catch (error) {
            out.moduleError = String(error);
            return out;
          }
          try {
            const mod = req(674026);
            const seen = new Set();
            let cursor = 0;
            const summarize = (item) => {
              const id = String(item?.awemeId || item?.aweme_id || item?.itemId || item?.id || "");
              if (!id) return null;
              const awemeType = item?.awemeType ?? item?.aweme_type ?? item?.AwemeType;
              const isNote = awemeType === 68 || awemeType === "68" || !!item?.image_post_info || !!item?.images;
              const duration = item?.video?.duration ?? item?.duration ?? item?.Duration;
              const createTime = item?.createTime ?? item?.create_time;
              const seconds = typeof createTime === "number" && createTime > 0 ? (createTime > 10000000000 ? createTime / 1000 : createTime) : null;
              return {
                platformVideoId: id,
                url: `https://www.douyin.com/${isNote ? "note" : "video"}/${id}`,
                type: isNote ? "note" : "video",
                description: String(item?.desc || item?.title || item?.previewTitle || item?.preview_title || "").slice(0, 500),
                author: item?.author?.nickname || item?.nickname || null,
                publishedAt: seconds ? new Date(seconds * 1000).toISOString() : null,
                durationSec: typeof duration === "number" ? (duration > 1000 ? duration / 1000 : duration) : null,
              };
            };
            for (let index = 0; index < maxPages; index++) {
              let result = null;
              let error = null;
              try {
                result = await mod.fetchUserPost({
                  userId: secUserId,
                  maxCursor: cursor,
                  count: 18,
                  needTimeList: index === 0,
                  timeListQuery: false,
                });
              } catch (err) {
                error = String(err);
              }
              const list = Array.isArray(result?.data) ? result.data : [];
              let newItems = 0;
              for (const raw of list) {
                const item = summarize(raw);
                if (!item || seen.has(item.platformVideoId)) continue;
                seen.add(item.platformVideoId);
                out.items.push(item);
                newItems += 1;
              }
              out.pages.push({
                page: index + 1,
                statusCode: result?.statusCode ?? null,
                statusMsg: result?.statusMsg ?? result?.statusMessage ?? null,
                items: list.length,
                newItems,
                hasMore: result?.hasMore ?? null,
                cursor: result?.cursor ?? result?.maxCursor ?? null,
                notLoginModule: result?.notLoginModule ? Object.keys(result.notLoginModule) : null,
                error,
              });
              const nextCursor = result?.cursor ?? result?.maxCursor;
              if (error || !result?.hasMore || !nextCursor || nextCursor === cursor) break;
              cursor = nextCursor;
              await new Promise(resolve => setTimeout(resolve, 700));
            }
          } catch (error) {
            out.moduleError = String(error);
          }
          return out;
        }""",
        {"secUserId": sec_user_id, "maxPages": max_pages},
    )
    raw_items = data.get("items") if isinstance(data, dict) else []
    items = [item for item in raw_items if isinstance(item, dict)]
    pages = data.get("pages") if isinstance(data, dict) and isinstance(data.get("pages"), list) else []
    diagnostics = {
        "requestLayer": data.get("requestLayer") if isinstance(data, dict) else "pc-webpack-fetchUserPost",
        "moduleError": data.get("moduleError") if isinstance(data, dict) else None,
    }
    return items, pages, diagnostics


async def collect_api_items(page, sec_user_id: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    items: list[dict[str, Any]] = []
    pages: list[dict[str, Any]] = []
    cursor: int | str = 0
    for index in range(8):
        result = await signed_fetch(page, build_post_url(sec_user_id, cursor))
        parsed = result.get("parsed") if isinstance(result.get("parsed"), dict) else {}
        aweme_list = parsed.get("aweme_list") if isinstance(parsed, dict) else []
        if not isinstance(aweme_list, list):
            aweme_list = []
        before = len(items)
        for aweme in aweme_list:
            if isinstance(aweme, dict):
                summary = summarize_aweme(aweme)
                if summary:
                    items.append(summary)
        next_cursor = parsed.get("max_cursor") if isinstance(parsed, dict) else None
        pages.append({
            "page": index + 1,
            "status": result.get("status"),
            "bytes": result.get("bytes"),
            "items": len(aweme_list),
            "newItems": len(items) - before,
            "hasMore": parsed.get("has_more") if isinstance(parsed, dict) else None,
            "maxCursor": next_cursor,
            "statusCode": parsed.get("status_code") if isinstance(parsed, dict) else None,
            "signError": result.get("signError"),
        })
        if not parsed.get("has_more") or not next_cursor or next_cursor == cursor:
            break
        cursor = next_cursor
        await page.wait_for_timeout(900)
    return items, pages


async def collect_dom_items(page) -> tuple[list[dict[str, Any]], int]:
    data = await page.evaluate(
        """() => {
          const links = [...document.querySelectorAll("a[href]")]
            .map((a) => a.href)
            .filter((href) => /douyin\\.com\\/(video|note)\\//.test(href));
          return [...new Set(links)];
        }"""
    )
    items: list[dict[str, Any]] = []
    for url in data:
        match = re.search(r"/(video|note)/(\d{16,22})", str(url))
        if not match:
            continue
        kind, aweme_id = match.groups()
        items.append({
            "platformVideoId": aweme_id,
            "url": f"https://www.douyin.com/{kind}/{aweme_id}",
            "type": kind,
            "description": "",
            "author": None,
            "publishedAt": None,
            "durationSec": None,
        })
    return items, len(data)


async def discover(account_url: str, timeout_ms: int) -> dict[str, Any]:
    async with async_playwright() as pw:
        headless = env_flag("VIDEO_LEARNING_DOUYIN_ACCOUNT_DISCOVER_HEADLESS", True)
        profile_dir = resolve_profile_dir()
        context = await pw.chromium.launch_persistent_context(
            profile_dir,
            headless=headless,
            user_agent=USER_AGENT,
            locale="zh-CN",
            viewport={"width": 1365, "height": 900},
            args=["--no-sandbox", "--disable-setuid-sandbox"],
        )
        browser = None

        page = await context.new_page()
        try:
            await page.goto(account_url, wait_until="domcontentloaded", timeout=timeout_ms)
            await page.wait_for_timeout(8000)
            final_url = page.url
            title = await page.title()
            text = await page.evaluate("document.body?.innerText || ''")
            account_id = parse_account_id(final_url)
            expected_count = parse_expected_count(text)
            author = parse_author(title, text)
            profile_items: list[dict[str, Any]] = []
            profile_pages: list[dict[str, Any]] = []
            frontend_diagnostics: dict[str, Any] = {}
            auth = await wait_for_login_if_visible(context, page, await auth_state(context), headless)
            if auth.get("hasLoginCookie"):
                target_url = final_url if parse_account_id(final_url) else account_url
                try:
                    await page.goto(target_url, wait_until="domcontentloaded", timeout=timeout_ms)
                except Exception:
                    try:
                        await page.close()
                    except Exception:
                        pass
                    page = await context.new_page()
                    await page.goto(target_url, wait_until="domcontentloaded", timeout=timeout_ms)
                await page.wait_for_timeout(4000)
                final_url = page.url
                title = await page.title()
                text = await page.evaluate("document.body?.innerText || ''")
                account_id = parse_account_id(final_url)
                expected_count = parse_expected_count(text)
                author = parse_author(title, text)
            if account_id:
                profile_items, profile_pages, frontend_diagnostics = await collect_frontend_module_items(page, account_id, expected_count)
            api_items: list[dict[str, Any]] = []
            api_pages: list[dict[str, Any]] = []
            if account_id and not profile_items:
                api_items, api_pages = await collect_api_items(page, account_id)
            for _ in range(8):
                await page.mouse.wheel(0, 1800)
                await page.wait_for_timeout(500)
            dom_items, dom_link_count = await collect_dom_items(page)
            items = dedupe_items([*profile_items, *api_items])
            if author:
                for item in items:
                    item["author"] = item.get("author") or author
            auth_required = bool(expected_count and not items and not auth["hasLoginCookie"])
            status = discovery_status(author, account_id, expected_count, len(items), auth_required)
            return {
                "platform": "douyin",
                "accountUrl": final_url,
                "accountId": account_id,
                "author": author,
                "expectedCount": expected_count,
                "status": status,
                "items": items,
                "diagnostics": {
                    "title": title,
                    "auth": auth,
                    "headless": headless,
                    "profileDir": profile_dir,
                    "authRequired": auth_required,
                    "authMessage": "抖音账号作品接口需要有效登录 cookie；当前浏览器 profile 未检测到 sid_guard/sessionid。" if auth_required else None,
                    "domLinkCount": dom_link_count,
                    "domItemsIgnored": len(dom_items),
                    "frontendPages": profile_pages,
                    "frontend": frontend_diagnostics,
                    "apiPages": api_pages,
                    "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                },
            }
        finally:
            await context.close()
            if browser:
                await browser.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("account_url")
    parser.add_argument("--timeout-ms", type=int, default=120_000)
    args = parser.parse_args()
    result = asyncio.run(discover(args.account_url, args.timeout_ms))
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
