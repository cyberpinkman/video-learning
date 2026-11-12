import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VideoLearningStore } from "../src/storage.ts";

let workdir = "";

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "video-learning-test-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

test("ingesting the same file twice reuses the existing video by content hash", async () => {
  const videoPath = join(workdir, "clip.mp4");
  writeFileSync(videoPath, Buffer.from("fake-video-bytes"));
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });

  const first = await store.ingestLocalFile({ path: videoPath, platform: "youtube", sourceUrl: "https://youtu.be/example" });
  const second = await store.ingestLocalFile({ path: videoPath, platform: "youtube", sourceUrl: "https://youtu.be/example" });

  expect(second.videoId).toBe(first.videoId);
  expect(second.created).toBe(false);
  expect(store.listVideos()).toHaveLength(1);
});

test("persisted local assets remain readable from another project directory", async () => {
  const originalCwd = process.cwd();
  const sourceDir = join(workdir, "source-project");
  const otherDir = join(workdir, "other-project");
  mkdirSync(sourceDir);
  mkdirSync(otherDir);
  writeFileSync(join(sourceDir, "clip.mp4"), "video evidence");
  writeFileSync(join(sourceDir, "audio.wav"), "audio evidence");
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });

  try {
    process.chdir(sourceDir);
    const absoluteSourceDir = process.cwd();
    const { videoId } = await store.ingestLocalFile({ path: "clip.mp4" });
    store.addAsset(videoId, { kind: "audio", path: "audio.wav" });
    process.chdir(otherDir);

    const assets = store.listAssets(videoId);
    for (const [kind, filename, content] of [
      ["original_video", "clip.mp4", "video evidence"],
      ["audio", "audio.wav", "audio evidence"],
    ] as const) {
      const asset = assets.find(item => item.kind === kind)!;
      expect(asset.path).toBe(join(absoluteSourceDir, filename));
      expect(readFileSync(asset.path, "utf8")).toBe(content);
    }
  } finally {
    process.chdir(originalCwd);
    store.close();
  }
});

test("acquisition attempts redact secrets before they are persisted", () => {
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });

  store.logAcquisitionAttempt({
    platform: "douyin",
    sourceUrl: "https://example.com/video?token=abc123&cookie=session",
    adapter: "playwright",
    strategy: "strong",
    status: "failed",
    usedAccount: true,
    usedProxy: true,
    message: "failed with cookie=secret and Authorization: Bearer abc.def.ghi via proxy 127.0.0.1:8080",
  });

  const [attempt] = store.listAcquisitionAttempts();
  const serialized = JSON.stringify(attempt);
  expect(serialized).not.toContain("abc123");
  expect(serialized).not.toContain("secret");
  expect(serialized).not.toContain("127.0.0.1:8080");
  expect(serialized).toContain("[REDACTED]");
});

test("video source URLs are redacted before they are persisted", async () => {
  const videoPath = join(workdir, "secret-url.mp4");
  writeFileSync(videoPath, Buffer.from("secret-url-video"));
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });

  const result = await store.ingestLocalFile({
    path: videoPath,
    platform: "youtube",
    sourceUrl: "https://example.com/watch?v=1&token=secret-token&cookie=session-secret",
  });

  const video = store.getVideo(result.videoId);
  expect(video?.sourceUrl).toContain("[REDACTED]");
  expect(video?.sourceUrl).not.toContain("secret-token");
  expect(video?.sourceUrl).not.toContain("session-secret");
});
