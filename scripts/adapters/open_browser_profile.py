#!/usr/bin/env python3
import argparse
import asyncio
from pathlib import Path

from playwright.async_api import async_playwright


USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


async def open_profile(url: str, profile_dir: Path) -> None:
    profile_dir.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as pw:
        context = await pw.chromium.launch_persistent_context(
            str(profile_dir),
            headless=False,
            user_agent=USER_AGENT,
            locale="zh-CN",
            viewport={"width": 1280, "height": 900},
            args=["--no-sandbox", "--disable-setuid-sandbox"],
        )
        page = context.pages[0] if context.pages else await context.new_page()
        await page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        print()
        print(f"Profile: {profile_dir}")
        print("在打开的 Chromium 窗口里完成登录/扫码，并播放目标视频一次。")
        print("完成后回到这个终端按 Enter；profile 会保存在上面的目录。")
        await asyncio.to_thread(input)
        await context.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--profile-dir", default=str(Path.home() / ".video-learning" / "browser-profiles" / "wechat-channels"))
    args = parser.parse_args()
    asyncio.run(open_profile(args.url, Path(args.profile_dir).expanduser()))


if __name__ == "__main__":
    main()
