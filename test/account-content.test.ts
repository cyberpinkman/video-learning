import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeAccountContent } from "../src/account-content.ts";
import { generateAccountContentReport } from "../src/account-content-report.ts";
import { VideoLearningStore } from "../src/storage.ts";
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
];
const oldEnv = new Map<string, string | undefined>();

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "video-learning-account-content-"));
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

function createVideo(store: VideoLearningStore, input: { title: string; author: string | null; hash: string; text?: string }) {
  const videoId = store.createVideoRecord({
    platform: "douyin",
    sourceUrl: null,
    title: input.title,
    author: input.author,
    publishedAt: null,
    durationSec: 12,
    contentHash: input.hash,
    status: "analyzed",
  });
  if (input.text) {
    store.replaceTranscript(videoId, [
      { startSec: 0, endSec: 3, speaker: "S1", text: input.text, wordsPerMinute: 180, keywords: ["选题", "痛点"] },
    ]);
  }
  return videoId;
}

function saveSingleAnalysis(store: VideoLearningStore, videoId: string, title: string): string {
  return store.saveContentAnalysis(videoId, {
    provider: "local",
    model: "fallback",
    transcriptHash: `${videoId}-transcript`,
    contentJson: {
      topic: `${title}选题`,
      audience: "新手创作者",
      hook: "先用痛点开场",
      structure: [{ startSec: 0, endSec: 3, summary: "痛点开场", evidence: "[00:00.000-00:03.000]" }],
      arguments: [`${title}核心论点`],
      quotes: [`${title}关键表达`],
      keywords: ["选题", "痛点", title],
      reusableFramework: "痛点-方法-总结",
      risks: ["机器转写需复核"],
      confidence: "low",
      evidenceNotes: [`${videoId} [00:00.000-00:03.000]`],
    },
  });
}

test("content-analyze-account auto-runs missing single analyses and stores account summary", async () => {
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });
  const tools = createToolHandlers({ store, workspaceDir: workdir });
  const first = createVideo(store, { title: "第一条", author: "同一作者", hash: "account-a", text: "第一条先讲选题痛点" });
  const second = createVideo(store, { title: "第二条", author: "同一作者", hash: "account-b", text: "第二条给出解决方法" });
  const existingSingle = saveSingleAnalysis(store, first, "第一条");

  const result = await tools.content_analyze_account({ video_ids: [first, second] });
  const report = await tools.get_content_analyze_account_report({ account_analysis_id: result.account_analysis_id, format: "full" });

  expect(result.status).toBe("account_content_analyzed");
  expect(result.video_ids).toEqual([first, second]);
  expect(store.listContentAnalyses(first)).toHaveLength(1);
  expect(store.listContentAnalyses(second)).toHaveLength(1);
  expect(store.getAccountContentAnalysis(result.account_analysis_id)?.singleAnalysisIds).toContain(existingSingle);
  expect(report.report).toContain("## 账号定位");
  expect(report.report).toContain("## 内容支柱");
  expect(report.report).not.toContain("逐镜头表");
  expect(report.report).not.toContain("景别");
  expect(report.report).not.toContain("复拍方案");
});

test("content-analyze-account rejects empty input, missing videos, empty author, and mixed authors", async () => {
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });
  const tools = createToolHandlers({ store, workspaceDir: workdir });
  const noAuthor = createVideo(store, { title: "无作者", author: null, hash: "no-author", text: "无作者内容" });
  const first = createVideo(store, { title: "作者一", author: "作者一", hash: "author-one", text: "作者一内容" });
  const second = createVideo(store, { title: "作者二", author: "作者二", hash: "author-two", text: "作者二内容" });

  await expect(tools.content_analyze_account({ video_ids: [] })).rejects.toThrow("至少需要 1 个 video_id");
  await expect(tools.content_analyze_account({ video_ids: ["vid_missing"] })).rejects.toThrow("Video not found");
  await expect(tools.content_analyze_account({ video_ids: [noAuthor] })).rejects.toThrow("作者为空");
  await expect(tools.content_analyze_account({ video_ids: [first, second] })).rejects.toThrow("作者不一致");
});

test("content-analyze-account rejects existing single analyses without transcript evidence", async () => {
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });
  const tools = createToolHandlers({ store, workspaceDir: workdir });
  const videoId = createVideo(store, { title: "空转写", author: "同一作者", hash: "empty-transcript" });
  store.saveContentAnalysis(videoId, {
    provider: "local",
    model: "fallback",
    transcriptHash: "empty",
    contentJson: {
      topic: "证据不足",
      audience: "未知",
      hook: "未检测到转写内容",
      structure: [],
      arguments: [],
      quotes: [],
      keywords: [],
      reusableFramework: "证据不足，需补充可转写音频或字幕。",
      risks: ["机器转写需人工复核"],
      confidence: "unknown",
      evidenceNotes: ["证据不足：未检测到转写内容"],
    },
  });

  await expect(tools.content_analyze_account({ video_ids: [videoId] })).rejects.toThrow(`视频 ${videoId} 缺少转写证据`);
});

test("account model prompt uses only single content evidence and transcript references", async () => {
  process.env.VIDEO_LEARNING_TEXT_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "openai-key";
  let requestBody: any = null;
  globalThis.fetch = (async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      output_text: JSON.stringify({
        positioning: { claim: "新手创作者教学账号", evidence: "vid_a [00:00.000-00:03.000]", videos: ["vid_a"] },
        audience: { claim: "短视频新手", evidence: "vid_b [00:00.000-00:03.000]", videos: ["vid_b"] },
        contentPillars: [{ name: "选题教学", evidence: "vid_a [00:00.000-00:03.000]", videos: ["vid_a"] }],
        hookPatterns: [{ pattern: "痛点开场", evidence: "vid_a [00:00.000-00:03.000]", videos: ["vid_a"] }],
        argumentPatterns: [{ pattern: "痛点-方法", evidence: "vid_b [00:00.000-00:03.000]", videos: ["vid_b"] }],
        keywords: [{ claim: "选题", evidence: "vid_a [00:00.000-00:03.000]", videos: ["vid_a"] }],
        representativeVideos: [{ videoId: "vid_a", reason: "选题主题代表", evidence: "vid_a [00:00.000-00:03.000]" }],
        reusableTemplates: [{ claim: "痛点-方法-总结", evidence: "vid_b [00:00.000-00:03.000]", videos: ["vid_b"] }],
        opportunities: [{ claim: "补充系列化选题", evidence: "vid_a [00:00.000-00:03.000]", videos: ["vid_a"] }],
        risks: [{ claim: "转写需复核", evidence: "vid_a [00:00.000-00:03.000]", videos: ["vid_a"] }],
        confidence: "high",
        evidenceNotes: ["仅基于 single 内容分析"],
      }),
    }), { status: 200 });
  }) as typeof fetch;

  const result = await analyzeAccountContent({
    author: "同一作者",
    videos: [
      {
        video: { id: "vid_a", title: "第一条", author: "同一作者", platform: "douyin", sourceUrl: null, publishedAt: null, durationSec: 12, contentHash: "a", status: "analyzed", createdAt: "", updatedAt: "" },
        analysisId: "cnt_a",
        content: saveableContent("第一条"),
        transcriptSegments: [{ startSec: 0, endSec: 3, text: "第一条先讲选题痛点" }],
      },
      {
        video: { id: "vid_b", title: "第二条", author: "同一作者", platform: "douyin", sourceUrl: null, publishedAt: null, durationSec: 12, contentHash: "b", status: "analyzed", createdAt: "", updatedAt: "" },
        analysisId: "cnt_b",
        content: saveableContent("第二条"),
        transcriptSegments: [{ startSec: 0, endSec: 3, text: "第二条给出解决方法" }],
      },
    ],
  });

  const prompt = requestBody.input[0].content[0].text;
  expect(prompt).toContain("第一条");
  expect(prompt).toContain("vid_a");
  expect(prompt).toContain("[00:00.000-00:03.000]");
  expect(prompt).not.toContain("keyframe");
  expect(prompt).not.toContain("image_url");
  expect(prompt).not.toContain("shotSize");
  expect(result.provider).toBe("openai");
  expect(result.content.positioning.claim).toBe("新手创作者教学账号");
});

test("account model representative evidence must reference the same video", async () => {
  process.env.VIDEO_LEARNING_TEXT_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "openai-key";
  globalThis.fetch = (async (_url, _init) => {
    return new Response(JSON.stringify({
      output_text: JSON.stringify({
        positioning: "新手创作者教学账号",
        audience: "短视频新手",
        contentPillars: [{ name: "选题教学", evidence: "vid_a [00:00.000-00:03.000]", videos: ["vid_a"] }],
        hookPatterns: [{ pattern: "痛点开场", evidence: "vid_a [00:00.000-00:03.000]", videos: ["vid_a"] }],
        argumentPatterns: [{ pattern: "痛点-方法", evidence: "vid_b [00:00.000-00:03.000]", videos: ["vid_b"] }],
        keywords: ["选题", "痛点"],
        representativeVideos: [{ videoId: "vid_a", reason: "选题主题代表", evidence: "vid_b [00:00.000-00:03.000]" }],
        reusableTemplates: ["痛点-方法-总结"],
        opportunities: ["补充系列化选题"],
        risks: ["转写需复核"],
        confidence: "high",
        evidenceNotes: ["仅基于 single 内容分析"],
      }),
    }), { status: 200 });
  }) as typeof fetch;

  const result = await analyzeAccountContent({
    author: "同一作者",
    videos: [
      {
        video: { id: "vid_a", title: "第一条", author: "同一作者", platform: "douyin", sourceUrl: null, publishedAt: null, durationSec: 12, contentHash: "a", status: "analyzed", createdAt: "", updatedAt: "" },
        analysisId: "cnt_a",
        content: saveableContent("第一条"),
        transcriptSegments: [{ startSec: 0, endSec: 3, text: "第一条先讲选题痛点" }],
      },
      {
        video: { id: "vid_b", title: "第二条", author: "同一作者", platform: "douyin", sourceUrl: null, publishedAt: null, durationSec: 12, contentHash: "b", status: "analyzed", createdAt: "", updatedAt: "" },
        analysisId: "cnt_b",
        content: saveableContent("第二条"),
        transcriptSegments: [{ startSec: 0, endSec: 3, text: "第二条给出解决方法" }],
      },
    ],
  });

  expect(result.content.representativeVideos).not.toContainEqual(expect.objectContaining({ videoId: "vid_a", evidence: expect.stringContaining("vid_b") }));
});

test("account model output without evidence falls back to local low-confidence summary", async () => {
  process.env.VIDEO_LEARNING_TEXT_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "openai-key";
  globalThis.fetch = (async (_url, _init) => {
    return new Response(JSON.stringify({
      output_text: JSON.stringify({
        positioning: "无证据账号定位",
        audience: "创作者",
        contentPillars: [{ name: "无证据支柱", evidence: "", videos: [] }],
        hookPatterns: [{ pattern: "无证据 hook", evidence: "", videos: [] }],
        argumentPatterns: [],
        keywords: ["无证据"],
        representativeVideos: [],
        reusableTemplates: ["无证据模板"],
        opportunities: [],
        risks: [],
        confidence: "high",
        evidenceNotes: ["没有证据"],
      }),
    }), { status: 200 });
  }) as typeof fetch;

  const result = await analyzeAccountContent({
    author: "同一作者",
    videos: [{
      video: { id: "vid_a", title: "第一条", author: "同一作者", platform: "douyin", sourceUrl: null, publishedAt: null, durationSec: 12, contentHash: "a", status: "analyzed", createdAt: "", updatedAt: "" },
      analysisId: "cnt_a",
      content: saveableContent("第一条"),
      transcriptSegments: [{ startSec: 0, endSec: 3, text: "第一条先讲选题痛点" }],
    }],
  });

  expect(result.provider).toBe("openai");
  expect(result.content.positioning.claim).toContain("同一作者");
  expect(result.content.confidence).toBe("low");
  expect(result.content.evidenceNotes.join("\n")).toContain("账号模型输出缺少参与视频证据");
});

test("local account fallback summarizes pillars, keywords, and representative videos", async () => {
  const result = await analyzeAccountContent({
    author: "同一作者",
    videos: [
      {
        video: { id: "vid_a", title: "第一条", author: "同一作者", platform: "douyin", sourceUrl: null, publishedAt: null, durationSec: 12, contentHash: "a", status: "analyzed", createdAt: "", updatedAt: "" },
        analysisId: "cnt_a",
        content: saveableContent("第一条"),
        transcriptSegments: [{ startSec: 0, endSec: 3, text: "第一条先讲选题痛点" }],
      },
      {
        video: { id: "vid_b", title: "第二条", author: "同一作者", platform: "douyin", sourceUrl: null, publishedAt: null, durationSec: 12, contentHash: "b", status: "analyzed", createdAt: "", updatedAt: "" },
        analysisId: "cnt_b",
        content: saveableContent("第二条"),
        transcriptSegments: [{ startSec: 0, endSec: 3, text: "第二条给出解决方法" }],
      },
    ],
  });

  expect(result.provider).toBe("local");
  expect(result.content.contentPillars.length).toBeGreaterThan(0);
  expect(result.content.keywords.map(item => item.claim)).toContain("选题");
  expect(result.content.representativeVideos.map(item => item.videoId)).toContain("vid_a");
});

function saveableContent(title: string) {
  return {
    topic: `${title}选题`,
    audience: "新手创作者",
    hook: "先用痛点开场",
    structure: [{ startSec: 0, endSec: 3, summary: "痛点开场", evidence: "[00:00.000-00:03.000]" }],
    arguments: [`${title}核心论点`],
    quotes: [`${title}关键表达`],
    keywords: ["选题", "痛点", title],
    reusableFramework: "痛点-方法-总结",
    risks: ["机器转写需复核"],
    confidence: "low" as const,
    evidenceNotes: ["仅基于转写"],
  };
}
