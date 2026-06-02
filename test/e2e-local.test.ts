import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VideoLearningStore } from "../src/storage.ts";
import { createToolHandlers } from "../src/tools.ts";

let workdir = "";
let oldOpenAiKey: string | undefined;
let oldSttEngine: string | undefined;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "video-learning-e2e-"));
  oldOpenAiKey = process.env.OPENAI_API_KEY;
  oldSttEngine = process.env.VIDEO_LEARNING_STT_ENGINE;
  delete process.env.OPENAI_API_KEY;
  process.env.VIDEO_LEARNING_STT_ENGINE = "off";
});

afterEach(() => {
  if (oldOpenAiKey) process.env.OPENAI_API_KEY = oldOpenAiKey;
  if (oldSttEngine === undefined) delete process.env.VIDEO_LEARNING_STT_ENGINE;
  else process.env.VIDEO_LEARNING_STT_ENGINE = oldSttEngine;
  rmSync(workdir, { recursive: true, force: true });
});

test("local mp4 E2E ingests, processes with worker, analyzes, and returns a full recreation report", async () => {
  const videoPath = join(workdir, "target.mp4");
  const ffmpeg = Bun.spawn({
    cmd: [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=6:size=320x180:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=6",
      "-shortest",
      "-pix_fmt",
      "yuv420p",
      videoPath,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await ffmpeg.exited).toBe(0);

  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });
  const tools = createToolHandlers({ store, workspaceDir: workdir });

  const ingest = await tools.ingest_video_file({ path: videoPath, platform: "local" });
  const analysis = await tools.deep_analyze_single({ video_id: ingest.video_id, depth: "standard" });
  const report = await tools.get_deep_analyze_single_report({ video_id: ingest.video_id, format: "full" });

  expect(analysis.status).toBe("analyzed");
  expect(store.listShots(ingest.video_id).length).toBeGreaterThan(0);
  expect(report.report).toContain("## 前 3 秒 Hook 拆解");
  expect(report.report).toContain("## 复拍方案");
});
