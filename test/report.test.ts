import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VideoLearningStore } from "../src/storage.ts";
import { generateRecreationReport } from "../src/report.ts";

let workdir = "";

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "video-learning-report-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

test("full reports include timestamped evidence and concrete recreation sections", () => {
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });
  const videoId = store.createVideoRecord({
    platform: "local",
    sourceUrl: null,
    title: "目标视频",
    author: "creator",
    publishedAt: null,
    durationSec: 420,
    contentHash: "hash-1",
    status: "analyzed",
  });
  store.replaceShots(videoId, [
    {
      startSec: 0,
      endSec: 2.8,
      keyframePath: "/tmp/keyframes/0001.jpg",
      visualSummary: "近景开场，主体直视镜头，屏幕上方出现大字标题。",
      shotSize: "近景",
      cameraMotion: "固定",
      composition: "居中构图",
      subtitles: "3秒讲清楚你为什么拍不好",
      audioRole: "强钩子口播",
      purpose: "建立痛点和承诺",
    },
    {
      startSec: 2.8,
      endSec: 8.4,
      keyframePath: "/tmp/keyframes/0002.jpg",
      visualSummary: "切到错误示范 B-roll，手持镜头轻微晃动。",
      shotSize: "中景",
      cameraMotion: "轻微推进",
      composition: "三分法",
      subtitles: "第一个错误：只拍结果",
      audioRole: "解释",
      purpose: "展开第一个论点",
    },
  ]);
  store.replaceTranscript(videoId, [
    { startSec: 0, endSec: 2.8, speaker: "S1", text: "三秒讲清楚你为什么拍不好", wordsPerMinute: 257, keywords: ["拍摄", "问题"] },
  ]);

  const report = generateRecreationReport(store, videoId, "full");

  expect(report).toContain("## 前 3 秒 Hook 拆解");
  expect(report).toContain("## 逐镜头表");
  expect(report).toContain("[00:00.000-00:02.800]");
  expect(report).toContain("## 节奏指标");
  expect(report).toContain("## 复拍方案");
  expect(report).toContain("## 风险提示");
  expect(report).toContain("拍摄顺序");
  expect(report).not.toContain("风格很强");
});

test("reports mark insufficient evidence instead of pretending visual inference is complete", () => {
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });
  const videoId = store.createVideoRecord({
    platform: "local",
    sourceUrl: null,
    title: "证据不足视频",
    author: null,
    publishedAt: null,
    durationSec: 300,
    contentHash: "hash-insufficient",
    status: "analyzed",
  });
  store.replaceShots(videoId, [
    {
      startSec: 0,
      endSec: 5,
      keyframePath: "/tmp/keyframes/0001.jpg",
      visualSummary: "证据不足：仅完成关键帧抽取，尚未经过视觉模型分析。",
      shotSize: "",
      cameraMotion: "",
      composition: "",
      subtitles: "",
      audioRole: "",
      purpose: "",
    },
  ]);

  const report = generateRecreationReport(store, videoId, "full");

  expect(report).toContain("## 证据状态");
  expect(report).toContain("证据不足");
  expect(report).toContain("视觉模型");
  expect(report).toContain("先补充视觉分析");
  expect(report).not.toContain("同景别，稳定拍摄");
});
