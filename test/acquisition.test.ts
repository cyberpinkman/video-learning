import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireVideo } from "../src/acquisition.ts";
import { VideoLearningStore } from "../src/storage.ts";
import { adapterCommandError, compactAcquisitionAttempts } from "../src/acquisition-diagnostics.ts";

let workdir = "";

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "video-learning-acq-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

test("YouTube acquisition uses yt-dlp output and logs a redacted successful attempt", async () => {
  const outputPath = join(workdir, "downloaded.mp4");
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });

  const result = await acquireVideo({
    url: "https://youtube.com/watch?v=abc&token=secret-token",
    platform: "youtube",
    strategy: "normal",
    workspaceDir: workdir,
    store,
    commandRunner: async command => {
      expect(command[0].endsWith("yt-dlp")).toBe(true);
      writeFileSync(outputPath, Buffer.from("downloaded-video"));
      return { exitCode: 0, stdout: JSON.stringify({ filepath: outputPath, title: "Downloaded title", uploader: "Uploader", duration: 360 }), stderr: "" };
    },
  });

  expect(result.status).toBe("success");
  expect(result.video_id).toBeTruthy();
  expect(store.listVideos()[0]?.title).toBe("Downloaded title");
  const attempts = store.listAcquisitionAttempts();
  expect(attempts).toHaveLength(1);
  expect(JSON.stringify(attempts)).not.toContain("secret-token");
});

test("YouTube acquisition honors injected yt-dlp command", async () => {
  const outputPath = join(workdir, "downloaded-from-local-venv.mp4");
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });

  const result = await acquireVideo({
    url: "https://youtube.com/watch?v=local",
    platform: "youtube",
    strategy: "normal",
    workspaceDir: workdir,
    store,
    adapterCommands: {
      "yt-dlp": [join(workdir, ".venv", "bin", "yt-dlp")],
    },
    commandRunner: async command => {
      expect(command[0]).toBe(join(workdir, ".venv", "bin", "yt-dlp"));
      writeFileSync(outputPath, Buffer.from("downloaded-video"));
      return { exitCode: 0, stdout: JSON.stringify({ filepath: outputPath, title: "Local yt-dlp", duration: 301 }), stderr: "" };
    },
  });

  expect(result.status).toBe("success");
  expect(store.listVideos()[0]?.title).toBe("Local yt-dlp");
});

test("acquisition records failed adapters before falling back to a successful adapter", async () => {
  const outputPath = join(workdir, "fallback.mp4");
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });
  let calls = 0;

  const result = await acquireVideo({
    url: "https://www.tiktok.com/@a/video/1",
    platform: "tiktok",
    strategy: "strong",
    workspaceDir: workdir,
    store,
    adapterCommands: {
      "tiktok-api": ["fake-tiktok"],
    },
    commandRunner: async command => {
      calls += 1;
      if (calls === 1) return { exitCode: 1, stdout: "", stderr: "blocked" };
      expect(command[0].endsWith("yt-dlp")).toBe(true);
      writeFileSync(outputPath, Buffer.from("fallback-video"));
      return { exitCode: 0, stdout: JSON.stringify({ filepath: outputPath, title: "Fallback title", duration: 420 }), stderr: "" };
    },
  });

  expect(result.status).toBe("success");
  expect(store.listAcquisitionAttempts().map(attempt => attempt.status)).toEqual(["failed", "success"]);
});

test("platform-specific adapters use the built-in browser sniffer before unconfigured optional fallbacks", async () => {
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });
  let calls = 0;

  const result = await acquireVideo({
    url: "https://www.douyin.com/video/123",
    platform: "douyin",
    strategy: "strong",
    workspaceDir: workdir,
    store,
    commandRunner: async () => {
      calls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    adapterCommands: {},
  });

  expect(result.status).toBe("failed");
  expect(calls).toBe(1);
  expect(store.listVideos()).toHaveLength(0);
  expect(store.listAcquisitionAttempts().map(attempt => attempt.status)).toEqual(["failed", "skipped", "skipped"]);
});

test("configured platform adapters parse generic downloader JSON output after browser sniffer fallback", async () => {
  const outputPath = join(workdir, "douyin.mp4");
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });
  let calls = 0;

  const result = await acquireVideo({
    url: "https://www.douyin.com/video/456",
    platform: "douyin",
    strategy: "strong",
    workspaceDir: workdir,
    store,
    adapterCommands: {
      "douyin-tiktok-download-api": ["fake-douyin"],
    },
    commandRunner: async command => {
      calls += 1;
      if (calls === 1) {
        expect(command.some(part => part.includes("browser_media_download.py"))).toBe(true);
        return { exitCode: 1, stdout: "", stderr: "browser sniffer failed" };
      }
      expect(command).toEqual(["fake-douyin", "https://www.douyin.com/video/456"]);
      writeFileSync(outputPath, Buffer.from("douyin-video"));
      return { exitCode: 0, stdout: JSON.stringify({ path: outputPath, title: "抖音标题", author: "作者", durationSec: 301 }), stderr: "" };
    },
  });

  expect(result.status).toBe("success");
  expect(store.listVideos()[0]?.title).toBe("抖音标题");
  expect(store.listAcquisitionAttempts().map(attempt => attempt.status)).toEqual(["failed", "success"]);
});

test("structured adapter evidence survives acquisition and storage without credentials", async () => {
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });
  const diagnosticsPath = join(workdir, "diagnostics", "run", "diagnostics.json");
  const result = await acquireVideo({
    url: "https://www.douyin.com/video/123",
    platform: "douyin",
    workspaceDir: workdir,
    store,
    commandRunner: async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "adapter log\n" + JSON.stringify({ error: {
        code: "no_media_candidates", phase: "media_readiness", message: "Readiness deadline exhausted",
        retryable: true, diagnostics_path: diagnosticsPath,
        next_actions: ["inspect_diagnostics"],
        details: { final_url: "https://www.douyin.com/video/123?signature=private-signature#private-fragment", cookies: "private-cookie", nested: { authorization: "private-auth" } },
      } }),
    }),
  });
  expect(result.status).toBe("failed");
  expect(result.attempts[0]).toMatchObject({
    adapter: "playwright-media-sniffer", status: "failed",
    error: { code: "no_media_candidates", phase: "media_readiness", retryable: true, diagnostics_path: diagnosticsPath, next_actions: ["inspect_diagnostics"] },
  });
  const stored = JSON.parse(store.listAcquisitionAttempts()[0]!.message);
  expect(stored.error.diagnostics_path).toBe(diagnosticsPath);
  expect(stored.error.details.final_url).toBe("https://www.douyin.com/video/123");
  expect(compactAcquisitionAttempts(result.attempts)[0]).toMatchObject({ error: { code: "no_media_candidates", diagnostics_path: diagnosticsPath } });
  for (const secret of ["private-signature", "private-fragment", "private-cookie", "private-auth"]) {
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain(secret);
  }
});

test("successful adapters retain the diagnostic pointer alongside the acquired asset", async () => {
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });
  const path = join(workdir, "verified.mp4");
  const diagnosticsPath = join(workdir, "diagnostics", "success", "diagnostics.json");
  writeFileSync(path, "verified-video");
  const result = await acquireVideo({
    url: "https://www.douyin.com/video/456", platform: "douyin", workspaceDir: workdir, store,
    commandRunner: async () => ({ exitCode: 0, stdout: JSON.stringify({ path, diagnostics_path: diagnosticsPath }), stderr: "" }),
  });
  expect(result.status).toBe("success");
  expect(result.attempts[0]).toMatchObject({ status: "success", diagnostics_path: diagnosticsPath });
  expect(JSON.parse(store.listAcquisitionAttempts()[0]!.message).diagnostics_path).toBe(diagnosticsPath);
});

test("legacy adapter failures remain readable but do not leak transport credentials", () => {
  const stderr = [
    "Navigation failed",
    "Cookie: sessionid=private-session; sid_guard=private-guard",
    "Authorization: Bearer private-bearer",
    "GET https://private-user:private-pass@example.com/media?signature=private-signature#private-fragment",
    JSON.stringify({ unexpected: true, cookies: "private-cookie", token: "private-token" }),
  ].join("\n");
  const error = adapterCommandError(stderr, "", "legacy");
  expect(error.message).toContain("Navigation failed");
  expect(error.message).toContain("https://example.com/media");
  expect(error.message).not.toContain("private-");
});
