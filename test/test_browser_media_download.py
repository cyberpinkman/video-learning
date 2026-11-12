import asyncio
import contextlib
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("browser_media_download", ROOT / "scripts/adapters/browser_media_download.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Clock:
    def __init__(self):
        self.t = 0.0

    def now(self):
        return self.t

    async def sleep(self, seconds):
        self.t += seconds


class Page:
    url = "https://www.douyin.com/video/123?token=private"

    def __init__(self, candidates=None):
        self.navigation_count = 0
        self.candidates = candidates

    async def goto(self, url, **kwargs):
        self.navigation_count += 1
        if self.candidates is not None:
            self.candidates.append({"url": "https://cdn.example/early-ad.mp4", "method": "network-response", "contentType": "video/mp4"})
        return type("Response", (), {"status": 200})()


def state(url=None, blocking=None):
    return {"title": "Public video", "video_count": int(bool(url)), "visible_video_count": int(bool(url)),
            "ready_state": 4 if url else None, "video_error_codes": [], "active_urls": [url] if url else [],
            "has_blob_player": False, "blocking": blocking or {}}


class ReadinessTests(unittest.IsolatedAsyncioTestCase):
    async def test_waits_for_visible_target_not_early_ad_or_audio(self):
        clock, diag = Clock(), {}
        candidates = [
            {"url": "https://cdn.example/ad.mp4", "method": "network-response", "contentType": "video/mp4"},
            {"url": "https://cdn.example/audio.mp4", "method": "network-response", "contentType": "audio/mp4"},
        ]
        async def inspect(_):
            return state("https://cdn.example/target.mp4" if clock.t >= 9 else None)
        with patch.object(MODULE, "inspect_player", inspect):
            selected = await MODULE.wait_for_media(Page(), candidates, "douyin", 14, diag, "123", clock.now, clock.sleep)
        self.assertGreaterEqual(clock.t, 10)
        self.assertEqual(selected[0]["url"], "https://cdn.example/target.mp4")
        self.assertNotIn("ad.mp4", json.dumps(selected))
        self.assertEqual(diag["media_identity"], "active_player_url")

    async def test_unknown_empty_player_uses_one_full_deadline_without_retry(self):
        clock, diag, candidates = Clock(), {}, []
        page = Page(candidates)
        async def inspect(_):
            return state()
        with patch.object(MODULE, "inspect_player", inspect):
            with self.assertRaises(MODULE.AcquisitionError) as caught:
                await MODULE.discover_media(page, page.url, candidates, "douyin", 30000, diag, 10000, clock.now, clock.sleep)
        self.assertEqual(caught.exception.code, "no_media_candidates")
        self.assertFalse(caught.exception.retryable)
        self.assertEqual(page.navigation_count, 1)
        self.assertAlmostEqual(clock.t, 10)
        self.assertEqual(len(diag["attempts"]), 1)

    async def test_observed_transient_document_failure_has_at_most_one_recovery(self):
        clock, diag, candidates = Clock(), {}, []
        class UnavailablePage(Page):
            async def goto(self, *args, **kwargs):
                self.navigation_count += 1
                return type("Response", (), {"status": 503})()
        page = UnavailablePage()
        async def inspect(_):
            return state()
        with patch.object(MODULE, "inspect_player", inspect):
            with self.assertRaises(MODULE.AcquisitionError) as caught:
                await MODULE.discover_media(page, page.url, candidates, "douyin", 30000, diag, 5000, clock.now, clock.sleep)
        self.assertEqual(caught.exception.code, "network_failed")
        self.assertTrue(caught.exception.retryable)
        self.assertEqual(page.navigation_count, 2)
        self.assertAlmostEqual(clock.t, 10)

    async def test_healthy_slow_player_gets_entire_first_budget(self):
        clock, diag, candidates = Clock(), {}, []
        page = Page()
        async def inspect(_):
            return state("https://cdn.example/target.mp4" if clock.t >= 20 else None)
        with patch.object(MODULE, "inspect_player", inspect):
            await MODULE.discover_media(page, page.url, candidates, "douyin", 30000, diag, 25000, clock.now, clock.sleep)
        self.assertEqual(page.navigation_count, 1)
        self.assertGreaterEqual(clock.t, 21)

    async def test_explicit_blocker_is_not_retried(self):
        clock, diag, candidates = Clock(), {}, []
        page = Page()
        async def inspect(_):
            return state(blocking={"auth_required": True})
        with patch.object(MODULE, "inspect_player", inspect):
            with self.assertRaises(MODULE.AcquisitionError) as caught:
                await MODULE.discover_media(page, page.url, candidates, "douyin", 30000, diag, 10000, clock.now, clock.sleep)
        self.assertEqual(caught.exception.code, "auth_required")
        self.assertFalse(caught.exception.retryable)
        self.assertEqual(page.navigation_count, 1)

    async def test_rejects_explicit_target_redirect_mismatch(self):
        async def inspect(_):
            return state("https://cdn.example/target.mp4")
        with patch.object(MODULE, "inspect_player", inspect):
            with self.assertRaises(MODULE.AcquisitionError) as caught:
                await MODULE.wait_for_media(Page(), [], "douyin", MODULE.time.monotonic() + 5, {}, "456")
        self.assertEqual(caught.exception.code, "target_mismatch")

    def test_diagnostics_projection_never_contains_private_urls_or_credentials(self):
        diag = {}
        player = state("https://private:secret@cdn.example/video.mp4?token=topsecret")
        player["title"] = "video token=topsecret https://user:secret@example.com/video/123?sessionid=hidden"
        MODULE.record_player(diag, player, "https://private:secret@example.com/video/123?cookie=hidden#secret")
        serialized = json.dumps(diag)
        for secret in ("topsecret", "hidden", "user:secret", "private:secret", "active_urls"):
            self.assertNotIn(secret, serialized)
        self.assertEqual(diag["final_url"], "https://example.com/video/123")
        error = MODULE.AcquisitionError("no_media_candidates", "media_readiness", "Cause unknown", True)
        self.assertEqual(error.envelope()["error"]["code"], "no_media_candidates")

    def test_platform_promotional_assets_and_audio_do_not_prove_video_readiness(self):
        self.assertEqual(MODULE.normalize_candidates([{"url": "https://example.com/douyin_pc_client.mp4"}], "douyin"), [])
        self.assertEqual(MODULE.candidate_media_kind({"url": "https://cdn.example/audio.mp4", "contentType": "audio/mp4"}), "audio")

    def test_failure_classification_requires_explicit_evidence(self):
        self.assertEqual(MODULE.classify_readiness_failure({"page_title": "登录 抖音"}).code, "no_media_candidates")
        self.assertEqual(MODULE.classify_readiness_failure({"network": {"failed_requests": 2}}).code, "no_media_candidates")
        self.assertEqual(MODULE.classify_readiness_failure({"network": {"active_media_failed_requests": 2}}).code, "network_failed")
        self.assertEqual(MODULE.classify_readiness_failure({"network": {"active_media_http_errors_by_status": {"403": 1}}}).code, "network_failed")
        self.assertFalse(MODULE.classify_readiness_failure({"network": {"active_media_http_errors_by_status": {"403": 1}}}).retryable)


class AssetOwnershipTests(unittest.TestCase):
    def test_short_audio_cannot_truncate_and_publish_a_long_video(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "current-run.mp4"
            def download(_, path, *args):
                path.write_bytes(b"media")
            candidates = [{"url": "https://example.com/video.mp4", "contentType": "video/mp4"},
                          {"url": "https://example.com/audio.mp4", "contentType": "audio/mp4"}]
            diag = {}
            with patch.object(MODULE, "download_media_candidate", download), patch.object(MODULE, "validate_downloaded_video", return_value={"has_video": True, "has_audio": False, "duration": 46}), patch.object(MODULE, "validate_downloaded_audio", return_value={"has_audio": True, "duration": 3}), patch.object(MODULE, "merge_audio_video") as merge:
                with self.assertRaises(MODULE.AcquisitionError) as caught:
                    MODULE.publish_candidates(candidates, output, "", "", diag)
            self.assertEqual(caught.exception.code, "incomplete_media")
            merge.assert_not_called()
            self.assertIn("duration_mismatch", json.dumps(diag))
            self.assertFalse(output.exists())

    def test_advertised_audio_failure_does_not_publish_silent_success(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "current-run.mp4"
            def download(_, path, *args):
                path.write_bytes(b"media")
            candidates = [{"url": "https://example.com/video.mp4", "contentType": "video/mp4"},
                          {"url": "https://example.com/audio.mp4", "contentType": "audio/mp4"}]
            with patch.object(MODULE, "download_media_candidate", download), patch.object(MODULE, "validate_downloaded_video", return_value={"has_video": True, "has_audio": False, "duration": 3}), patch.object(MODULE, "validate_downloaded_audio", side_effect=ValueError("invalid audio")):
                with self.assertRaises(MODULE.AcquisitionError) as caught:
                    MODULE.publish_candidates(candidates, output, "", "", {})
            self.assertEqual(caught.exception.code, "incomplete_media")
            self.assertFalse(output.exists())
            self.assertEqual(list(Path(folder).glob("*.mp4")), [])

    def test_new_download_never_reuses_or_deletes_existing_asset(self):
        for should_fail in (False, True):
            with self.subTest(should_fail=should_fail), tempfile.TemporaryDirectory() as folder:
                old = Path(folder) / "douyin-existing.mp4"
                old.write_bytes(b"old-library-asset")
                output = Path(folder) / "douyin-new-run.mp4"
                def download(_, path, *args):
                    if should_fail:
                        raise OSError("private credential must not leak")
                    path.write_bytes(b"new-video")
                info = {"has_video": True, "has_audio": True, "duration": 3}
                with patch.object(MODULE, "download_media_candidate", download), patch.object(MODULE, "validate_downloaded_video", return_value=info):
                    if should_fail:
                        with self.assertRaises(MODULE.AcquisitionError):
                            MODULE.publish_candidates([{"url": "https://example.com/target.mp4"}], output, "", "", {})
                    else:
                        MODULE.publish_candidates([{"url": "https://example.com/target.mp4"}], output, "", "", {})
                        self.assertEqual(output.read_bytes(), b"new-video")
                self.assertEqual(old.read_bytes(), b"old-library-asset")
                self.assertEqual(list(Path(folder).glob("*.video.mp4")), [])


@unittest.skipUnless(os.environ.get("VIDEO_LEARNING_RUN_BROWSER_TESTS") == "1", "enable local Chromium integration explicitly")
class BrowserBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_generic_login_chrome_is_distinct_from_playback_gate(self):
        async with MODULE.async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True)
            try:
                page = await browser.new_page()
                for body, expected in [
                    ('<button>登录</button><div role="dialog">登录后免费畅享高清视频</div>', False),
                    ('<main>请登录后观看</main>', True),
                ]:
                    await page.set_content(body)
                    result = await MODULE.inspect_player(page)
                    self.assertEqual(result["blocking"]["auth_required"], expected)
            finally:
                await browser.close()

    async def test_delayed_player_old_sampling_fails_new_readiness_succeeds(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            media = root / "fixture.mp4"
            subprocess.run([shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "3", "-c:v", "libx264", "-crf", "18", "-c:a", "aac", "-movflags", "+faststart", str(media)], check=True)
            data = media.read_bytes()
            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *_):
                    pass
                def do_GET(self):
                    if self.path.startswith("/clip"):
                        payload, mime = data, "video/mp4"
                    else:
                        payload = b'<html><head><title>Late media fixture</title></head><body><button>Login</button><script>setTimeout(()=>{const v=document.createElement("video");v.width=640;v.height=360;v.muted=true;v.autoplay=true;v.src="/clip.mp4?token=fixture-secret";document.body.append(v);},9000)</script></body></html>'
                        mime = "text/html"
                    self.send_response(200); self.send_header("Content-Type", mime); self.send_header("Content-Length", str(len(payload))); self.end_headers()
                    with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                        self.wfile.write(payload)
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            url = f"http://127.0.0.1:{server.server_port}/video/123"
            clean_env = {k:v for k,v in os.environ.items() if not k.startswith("VIDEO_LEARNING_")}
            clean_env["VIDEO_LEARNING_BROWSER_READY_TIMEOUT_MS"] = "20000"
            try:
                with patch.dict(os.environ, clean_env, clear=True):
                    # Optional comparison source is provided by the caller, never tied to an incident path.
                    baseline = BASELINE_ADAPTER
                    if baseline:
                        spec = importlib.util.spec_from_file_location("baseline_browser_adapter", baseline)
                        old = importlib.util.module_from_spec(spec); spec.loader.exec_module(old)
                        with self.assertRaisesRegex(RuntimeError, "no playable media URL found"):
                            await old.sniff_and_download(url, root / "old-downloads", 30000, False)
                    downloads = root / "downloads"
                    downloads.mkdir()
                    legacy_path = downloads / f"unknown-{MODULE.hashlib.sha256(url.encode()).hexdigest()[:16]}.mp4"
                    legacy_path.write_bytes(b"preexisting-library-asset-must-be-preserved")
                    result = await MODULE.sniff_and_download(url, root / "downloads", 30000, False)
                    self.assertNotEqual(Path(result["path"]), legacy_path)
                    self.assertEqual(legacy_path.read_bytes(), b"preexisting-library-asset-must-be-preserved")
                    self.assertEqual(Path(result["path"]).read_bytes(), data)
                    with patch.dict(os.environ, {"VIDEO_LEARNING_BROWSER_READY_TIMEOUT_MS": "1000"}):
                        with self.assertRaises(MODULE.AcquisitionError) as failed:
                            await MODULE.sniff_and_download(url, downloads, 30000, False)
                    failure_diag = json.loads(Path(failed.exception.diagnostics_path).read_text())
                    self.assertEqual(failure_diag["code"], "no_media_candidates")
                    self.assertEqual(failure_diag["navigation_attempts"], 1)
                    self.assertFalse(failed.exception.retryable)
                    self.assertEqual(legacy_path.read_bytes(), b"preexisting-library-asset-must-be-preserved")
                self.assertTrue(Path(result["path"]).is_file())
                diagnostic = Path(result["diagnostics_path"])
                parsed = json.loads(diagnostic.read_text())
                self.assertEqual(parsed["code"], "success")
                self.assertEqual(parsed["media_identity"], "active_player_url")
                self.assertEqual(parsed["navigation_attempts"], 1)
                self.assertTrue(parsed["downloaded_media"]["has_audio"])
                self.assertNotIn("fixture-secret", diagnostic.read_text())
                self.assertFalse(list(diagnostic.parent.glob("*.html")))
            finally:
                server.shutdown(); server.server_close(); thread.join()


BASELINE_ADAPTER = os.environ.get("VIDEO_LEARNING_BASELINE_ADAPTER")

if __name__ == "__main__":
    unittest.main()
