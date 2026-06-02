import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VideoLearningStore } from "../src/storage.ts";
import { analyzeContentFromTranscript } from "../src/content.ts";
import { generateContentReport } from "../src/content-report.ts";
import { createToolHandlers } from "../src/tools.ts";

let workdir = "";
let originalFetch: typeof globalThis.fetch;
const envKeys = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_BASE_URL",
  "VIDEO_LEARNING_TEXT_PROVIDER",
  "VIDEO_LEARNING_TEXT_MODEL",
  "VIDEO_LEARNING_VISION_PROVIDER",
  "VIDEO_LEARNING_VISION_MODEL",
  "VIDEO_LEARNING_STT_ENGINE",
];
const oldEnv = new Map<string, string | undefined>();

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "video-learning-content-"));
  originalFetch = globalThis.fetch;
  oldEnv.clear();
  for (const key of envKeys) {
    oldEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    const value = oldEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(workdir, { recursive: true, force: true });
});

test("text model content analysis sends only timestamped transcript evidence", async () => {
  process.env.VIDEO_LEARNING_TEXT_PROVIDER = "openai";
  process.env.VIDEO_LEARNING_TEXT_MODEL = "gpt-test";
  process.env.OPENAI_API_KEY = "openai-key";
  let requestBody: any = null;
  globalThis.fetch = (async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      output_text: JSON.stringify({
        topic: "短视频选题",
        audience: "新手创作者",
        hook: "先提出痛点",
        structure: [{ startSec: 0, endSec: 3, summary: "痛点开场", evidence: "[00:00.000-00:03.000]" }],
        arguments: ["提出痛点", "给出方法"],
        quotes: ["你是不是也卡在这里"],
        keywords: ["选题", "痛点"],
        reusableFramework: "痛点-方法-总结",
        risks: ["转写需复核"],
        confidence: "high",
        evidenceNotes: ["仅基于 1 段转写"],
      }),
    }), { status: 200 });
  }) as typeof fetch;

  const result = await analyzeContentFromTranscript([
    { id: "trn_1", videoId: "vid_1", segmentIndex: 0, startSec: 0, endSec: 3, speaker: "S1", text: "你是不是也卡在这里，今天教你做短视频选题", wordsPerMinute: 260, keywords: ["选题"] },
  ]);

  const textPayload = requestBody.input[0].content[0].text;
  expect(textPayload).toContain("[00:00.000-00:03.000]");
  expect(textPayload).toContain("你是不是也卡在这里");
  expect(textPayload).not.toContain("keyframe");
  expect(textPayload).not.toContain("image_url");
  expect(result.provider).toBe("openai");
  expect(result.model).toBe("gpt-test");
  expect(result.content.topic).toBe("短视频选题");
});

test("content analysis falls back to low-confidence local report without API key", async () => {
  const result = await analyzeContentFromTranscript([
    { id: "trn_1", videoId: "vid_1", segmentIndex: 0, startSec: 0, endSec: 2, speaker: "S1", text: "先讲用户痛点", wordsPerMinute: 180, keywords: ["痛点"] },
  ]);

  expect(result.provider).toBe("local");
  expect(result.model).toBe("fallback");
  expect(result.content.confidence).toBe("low");
  expect(result.content.evidenceNotes.join("\n")).toContain("模型增强不可用");
});

test("text model content analysis drops unsupported model structure and keeps transcript evidence", async () => {
  process.env.VIDEO_LEARNING_TEXT_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "openai-key";
  globalThis.fetch = (async (_url, _init) => {
    return new Response(JSON.stringify({
      output_text: JSON.stringify({
        topic: "模型无证据主题",
        audience: "创作者",
        hook: "模型无证据 hook",
        structure: [{ summary: "没有时间戳证据的结构项" }],
        arguments: ["模型无证据论点"],
        quotes: ["模型无证据表达"],
        keywords: ["模型"],
        reusableFramework: "模型框架",
        risks: ["模型风险"],
        confidence: "high",
        evidenceNotes: ["没有时间戳"],
      }),
    }), { status: 200 });
  }) as typeof fetch;

  const result = await analyzeContentFromTranscript([
    { id: "trn_1", videoId: "vid_1", segmentIndex: 0, startSec: 0, endSec: 2, speaker: "S1", text: "先讲用户痛点", wordsPerMinute: 180, keywords: ["痛点"] },
  ]);

  expect(result.provider).toBe("openai");
  expect(result.content.structure).toHaveLength(1);
  expect(result.content.structure[0].summary).toBe("先讲用户痛点");
  expect(result.content.structure[0].evidence).toBe("[00:00.000-00:02.000]");
  expect(result.content.confidence).toBe("low");
  expect(result.content.evidenceNotes.join("\n")).toContain("缺少 transcript 时间段证据");
});

test("long transcript content analysis chunks model requests before final merge", async () => {
  process.env.VIDEO_LEARNING_TEXT_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "openai-key";
  process.env.VIDEO_LEARNING_TEXT_CHUNK_CHARS = "120";
  const requestBodies: any[] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requestBodies.push(body);
    const prompt = body.input[0].content[0].text;
    const isFinal = prompt.includes("Chunk summaries:");
    return new Response(JSON.stringify({
      output_text: JSON.stringify({
        topic: isFinal ? "合并主题" : "分块主题",
        audience: "创作者",
        hook: "先讲用户痛点",
        structure: [{ startSec: 0, endSec: 2, summary: isFinal ? "合并结构" : "分块结构", evidence: "[00:00.000-00:02.000]" }],
        arguments: [isFinal ? "合并论点" : "分块论点"],
        quotes: ["先讲用户痛点"],
        keywords: ["痛点"],
        reusableFramework: isFinal ? "合并框架" : "分块框架",
        risks: ["转写需复核"],
        confidence: "medium",
        evidenceNotes: ["引用 [00:00.000-00:02.000]"],
      }),
    }), { status: 200 });
  }) as typeof fetch;
  const transcript = Array.from({ length: 8 }, (_, index) => ({
    id: `trn_${index}`,
    videoId: "vid_1",
    segmentIndex: index,
    startSec: index * 2,
    endSec: index * 2 + 1.5,
    speaker: "S1",
    text: `第 ${index + 1} 段内容，持续讲用户痛点和解决路径，确保文本长度足够触发分块请求。`,
    wordsPerMinute: 180,
    keywords: ["痛点"],
  }));

  const result = await analyzeContentFromTranscript(transcript);

  expect(requestBodies.length).toBeGreaterThan(1);
  expect(requestBodies.at(-1).input[0].content[0].text).toContain("Chunk summaries:");
  expect(result.content.topic).toBe("合并主题");
});

test("content report never emits shot or recreation sections", () => {
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });
  const videoId = store.createVideoRecord({
    platform: "local",
    sourceUrl: null,
    title: "内容分析目标",
    author: "creator",
    publishedAt: null,
    durationSec: 30,
    contentHash: "content-hash",
    status: "analyzed",
  });
  store.replaceTranscript(videoId, [
    { startSec: 0, endSec: 2, speaker: "S1", text: "先讲用户痛点", wordsPerMinute: 180, keywords: ["痛点"] },
  ]);
  store.saveContentAnalysis(videoId, {
    provider: "local",
    model: "fallback",
    transcriptHash: "hash",
    contentJson: {
      topic: "用户痛点",
      audience: "新手",
      hook: "先讲用户痛点",
      structure: [{ startSec: 0, endSec: 2, summary: "开场痛点", evidence: "00:00-00:02" }],
      arguments: ["痛点"],
      quotes: ["先讲用户痛点"],
      keywords: ["痛点"],
      reusableFramework: "痛点-方法",
      risks: ["转写需复核"],
      confidence: "low",
      evidenceNotes: ["仅基于转写"],
    },
  });

  const report = generateContentReport(store, videoId, "full");

  expect(report).toContain("## 内容 Hook");
  expect(report).toContain("## 内容结构");
  expect(report).toContain("[00:00.000-00:02.000]");
  expect(report).not.toContain("逐镜头表");
  expect(report).not.toContain("景别");
  expect(report).not.toContain("复拍方案");
});

test("content-analyze-single updates transcript but preserves existing deep shots", async () => {
  process.env.VIDEO_LEARNING_STT_ENGINE = "off";
  const videoPath = join(workdir, "with-content.mp4");
  const vttPath = join(workdir, "with-content.vtt");
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
      "-pix_fmt",
      "yuv420p",
      videoPath,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await ffmpeg.exited).toBe(0);
  writeFileSync(vttPath, "WEBVTT\n\n00:00.000 --> 00:02.000\n只分析口播内容\n");
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });
  const tools = createToolHandlers({ store, workspaceDir: workdir });
  const ingest = await tools.ingest_video_file({ path: videoPath, platform: "local" });
  store.replaceShots(ingest.video_id, [
    { startSec: 0, endSec: 1, visualSummary: "已有深度拉片镜头", shotSize: "近景", cameraMotion: "固定", composition: "居中", subtitles: "", audioRole: "", purpose: "hook" },
  ]);

  const analysis = await tools.content_analyze_single({ video_id: ingest.video_id });
  const report = await tools.get_content_analyze_single_report({ video_id: ingest.video_id, format: "full" });

  expect(analysis.status).toBe("content_analyzed");
  expect(store.listTranscript(ingest.video_id)[0].text).toBe("只分析口播内容");
  expect(store.listShots(ingest.video_id)).toHaveLength(1);
  expect(store.listContentAnalyses(ingest.video_id)).toHaveLength(1);
  expect(report.report).toContain("## 内容结构");
  expect(report.report).not.toContain("逐镜头表");
});

test("content-analyze-single refuses to invent transcript when no video or transcript evidence exists", async () => {
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });
  const tools = createToolHandlers({ store, workspaceDir: workdir });
  const videoId = store.createVideoRecord({
    platform: "local",
    sourceUrl: null,
    title: "缺少原始素材",
    author: null,
    publishedAt: null,
    durationSec: null,
    contentHash: "missing-assets",
    status: "ingested",
  });

  await expect(tools.content_analyze_single({ video_id: videoId })).rejects.toThrow("缺少原视频资产或可复用转写证据");
  expect(store.listTranscript(videoId)).toEqual([]);
  expect(store.listContentAnalyses(videoId)).toEqual([]);
});

test("content-analyze-single can reuse existing transcript when the original video is unavailable", async () => {
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });
  const tools = createToolHandlers({ store, workspaceDir: workdir });
  const videoId = store.createVideoRecord({
    platform: "local",
    sourceUrl: null,
    title: "已有转写",
    author: null,
    publishedAt: null,
    durationSec: 3,
    contentHash: "existing-transcript",
    status: "ingested",
  });
  store.replaceTranscript(videoId, [
    { startSec: 0, endSec: 2, speaker: "S1", text: "已有真实转写证据", wordsPerMinute: 180, keywords: ["转写"] },
  ]);

  const result = await tools.content_analyze_single({ video_id: videoId });

  expect(result.status).toBe("content_analyzed");
  expect(store.listTranscript(videoId)[0].text).toBe("已有真实转写证据");
  expect(store.listContentAnalyses(videoId)).toHaveLength(1);
});

test(".env.example leaves text provider unset so vision settings can be reused", () => {
  const envExample = readFileSync(join(import.meta.dir, "..", ".env.example"), "utf8");

  expect(envExample).not.toMatch(/^VIDEO_LEARNING_TEXT_PROVIDER=/m);
  expect(envExample).not.toMatch(/^VIDEO_LEARNING_TEXT_MODEL=/m);
  expect(envExample).toContain("# VIDEO_LEARNING_TEXT_PROVIDER=openai");
});
