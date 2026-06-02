import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VideoLearningStore } from "../src/storage.ts";
import { createToolHandlers, resolveWorkerPython } from "../src/tools.ts";

let workdir = "";
let oldSttEngine: string | undefined;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "video-learning-tools-"));
  oldSttEngine = process.env.VIDEO_LEARNING_STT_ENGINE;
  process.env.VIDEO_LEARNING_STT_ENGINE = "off";
});

afterEach(() => {
  if (oldSttEngine === undefined) delete process.env.VIDEO_LEARNING_STT_ENGINE;
  else process.env.VIDEO_LEARNING_STT_ENGINE = oldSttEngine;
  rmSync(workdir, { recursive: true, force: true });
});

test("MCP-facing tool handlers can ingest, analyze, and return a shooting brief", async () => {
  const videoPath = join(workdir, "sample.mp4");
  writeFileSync(videoPath, Buffer.from("not-a-real-video-but-good-enough-for-store"));
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });
  const tools = createToolHandlers({ store, workspaceDir: workdir, allowStubProcessing: true });

  const ingest = await tools.ingest_video_file({ path: videoPath, platform: "local" });
  const analysis = await tools.analyze_video({ video_id: ingest.video_id, depth: "standard" });
  const report = await tools.get_video_report({ video_id: ingest.video_id, format: "shooting_brief" });

  expect(analysis.status).toBe("analyzed");
  expect(report.report).toContain("复拍方案");
  expect(report.report).toContain("逐镜头表");
});

test("worker python resolver prefers the project virtualenv", () => {
  const projectRoot = join(workdir, "project");
  const pythonPath = join(projectRoot, ".venv", "bin", "python");
  mkdirSync(join(projectRoot, ".venv", "bin"), { recursive: true });
  writeFileSync(pythonPath, "#!/usr/bin/env sh\nexit 0\n");
  chmodSync(pythonPath, 0o755);

  expect(resolveWorkerPython({ projectRoot })).toBe(pythonPath);
});

test("tool analysis writes artifacts under a video-specific directory", async () => {
  const pathA = join(workdir, "a.mp4");
  const pathB = join(workdir, "b.mp4");
  for (const [path, frequency] of [[pathA, "440"], [pathB, "880"]] as const) {
    const ffmpeg = Bun.spawn({
      cmd: [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=3:size=320x180:rate=24",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${frequency}:duration=3`,
        "-shortest",
        "-pix_fmt",
        "yuv420p",
        path,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await ffmpeg.exited).toBe(0);
  }
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });
  const tools = createToolHandlers({ store, workspaceDir: workdir });
  const first = await tools.ingest_video_file({ path: pathA, platform: "local" });
  const second = await tools.ingest_video_file({ path: pathB, platform: "local" });

  await tools.analyze_video({ video_id: first.video_id, depth: "standard" });
  await tools.analyze_video({ video_id: second.video_id, depth: "standard" });

  const firstKeyframe = store.listShots(first.video_id)[0].keyframePath;
  const secondKeyframe = store.listShots(second.video_id)[0].keyframePath;
  expect(firstKeyframe).toContain(first.video_id);
  expect(secondKeyframe).toContain(second.video_id);
  expect(firstKeyframe).not.toBe(secondKeyframe);
});

test("report formats and compare output expose distinct behavior", async () => {
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });
  const target = store.createVideoRecord({
    platform: "local",
    sourceUrl: null,
    title: "Target",
    author: null,
    publishedAt: null,
    durationSec: 120,
    contentHash: "target",
    status: "analyzed",
  });
  const reference = store.createVideoRecord({
    platform: "local",
    sourceUrl: null,
    title: "Reference",
    author: null,
    publishedAt: null,
    durationSec: 60,
    contentHash: "reference",
    status: "analyzed",
  });
  store.replaceShots(target, [
    { startSec: 0, endSec: 2, visualSummary: "目标 hook", shotSize: "近景", cameraMotion: "固定", composition: "居中", subtitles: "目标", audioRole: "口播", purpose: "hook" },
  ]);
  store.replaceShots(reference, [
    { startSec: 0, endSec: 4, visualSummary: "参考 hook", shotSize: "中景", cameraMotion: "推进", composition: "三分法", subtitles: "参考", audioRole: "口播", purpose: "hook" },
  ]);
  const tools = createToolHandlers({ store, workspaceDir: workdir, allowStubProcessing: true });

  const full = await tools.get_video_report({ video_id: target, format: "full" });
  const brief = await tools.get_video_report({ video_id: target, format: "shooting_brief" });
  const compare = await tools.compare_videos({ target_id: target, reference_ids: [reference] });

  expect(brief.report).not.toBe(full.report);
  expect(brief.report).not.toContain("## 全片结构");
  expect(compare.report).toContain("平均镜头时长差");
});
