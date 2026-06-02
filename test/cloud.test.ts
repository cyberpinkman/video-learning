import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { maybeEnrichShotsWithCloud } from "../src/cloud.ts";

let workdir = "";
let originalFetch: typeof globalThis.fetch;
let oldEnv: Record<string, string | undefined> = {};

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_BASE_URL",
  "VIDEO_LEARNING_VISION_PROVIDER",
  "VIDEO_LEARNING_VISION_MODEL",
  "VIDEO_LEARNING_CLOUD_FRAME_LIMIT",
  "VIDEO_LEARNING_CLOUD_BATCH_SIZE",
  "VIDEO_LEARNING_CLOUD_REQUEST_TIMEOUT_MS",
];

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "video-learning-cloud-"));
  originalFetch = globalThis.fetch;
  oldEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const value = oldEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(workdir, { recursive: true, force: true });
});

test("DashScope Qwen vision enrichment uses OpenAI-compatible chat completions", async () => {
  const imagePath = join(workdir, "frame.jpg");
  await Bun.write(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  process.env.DASHSCOPE_API_KEY = "dashscope-key";
  process.env.VIDEO_LEARNING_VISION_PROVIDER = "dashscope";
  process.env.VIDEO_LEARNING_VISION_MODEL = "qwen3.6-plus";

  let requestBody: any = null;
  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer dashscope-key");
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            shots: [{
              shotIndex: 0,
              visualSummary: "主体在室内面对镜头讲解，背景简洁。",
              shotSize: "近景",
              cameraMotion: "固定",
              composition: "居中构图",
              subtitles: "大字标题",
              audioRole: "口播",
              purpose: "建立信任和信息入口",
            }],
          }),
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const enriched = await maybeEnrichShotsWithCloud([
    { startSec: 0, endSec: 2, keyframePath: imagePath, visualSummary: "证据不足" },
  ]);

  expect(requestBody.model).toBe("qwen3.6-plus");
  expect(requestBody.response_format).toEqual({ type: "json_object" });
  expect(requestBody.messages[0].content[0].type).toBe("text");
  expect(requestBody.messages[0].content[1].type).toBe("image_url");
  expect(requestBody.messages[0].content[1].image_url.url).toStartWith("data:image/jpeg;base64,");
  expect(enriched[0].visualSummary).toBe("主体在室内面对镜头讲解，背景简洁。");
  expect(enriched[0].shotSize).toBe("近景");
});

test("DashScope enrichment accepts array-wrapped JSON payloads returned by Qwen", async () => {
  const imagePath = join(workdir, "frame-array-wrapped.jpg");
  await Bun.write(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  process.env.DASHSCOPE_API_KEY = "dashscope-key";
  process.env.VIDEO_LEARNING_VISION_PROVIDER = "dashscope";
  process.env.VIDEO_LEARNING_VISION_MODEL = "qwen3.6-plus";

  globalThis.fetch = (async (_url, _init) => {
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify([{
            shots: [{
              shotIndex: 0,
              visualSummary: "数组包裹的视觉描述",
              shotSize: "全身镜头",
            }],
          }]),
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const enriched = await maybeEnrichShotsWithCloud([
    { startSec: 0, endSec: 2, keyframePath: imagePath, visualSummary: "证据不足" },
  ]);

  expect(enriched[0].visualSummary).toBe("数组包裹的视觉描述");
  expect(enriched[0].shotSize).toBe("全身镜头");
});

test("DashScope enrichment batches all frames and maps local indexes back to global shots", async () => {
  const imagePaths = await Promise.all(Array.from({ length: 3 }, async (_, index) => {
    const imagePath = join(workdir, `frame-batch-${index}.jpg`);
    await Bun.write(imagePath, Buffer.from([0xff, 0xd8, index, 0xd9]));
    return imagePath;
  }));
  process.env.DASHSCOPE_API_KEY = "dashscope-key";
  process.env.VIDEO_LEARNING_VISION_PROVIDER = "dashscope";
  process.env.VIDEO_LEARNING_VISION_MODEL = "qwen3.6-plus";
  process.env.VIDEO_LEARNING_CLOUD_FRAME_LIMIT = "all";
  process.env.VIDEO_LEARNING_CLOUD_BATCH_SIZE = "2";

  const requestBodies: any[] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requestBodies.push(body);
    const batchNumber = requestBodies.length;
    const content = batchNumber === 1
      ? { shots: [{ shotIndex: 0, visualSummary: "第一批第一帧" }, { shotIndex: 1, visualSummary: "第一批第二帧" }] }
      : { shots: [{ shotIndex: 0, visualSummary: "第二批局部索引应映射到全局第三帧" }] };
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const enriched = await maybeEnrichShotsWithCloud(imagePaths.map((imagePath, index) => ({
    startSec: index,
    endSec: index + 1,
    keyframePath: imagePath,
    visualSummary: "证据不足",
  })));

  expect(requestBodies).toHaveLength(2);
  expect(requestBodies[1].messages[0].content[0].text).toContain("shotIndex 2");
  expect(enriched.map(shot => shot.visualSummary)).toEqual([
    "第一批第一帧",
    "第一批第二帧",
    "第二批局部索引应映射到全局第三帧",
  ]);
});

test("vision provider can be explicitly disabled even when a Qwen model is configured", async () => {
  const imagePath = join(workdir, "frame-disabled.jpg");
  await Bun.write(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  process.env.DASHSCOPE_API_KEY = "dashscope-key";
  process.env.VIDEO_LEARNING_VISION_PROVIDER = "off";
  process.env.VIDEO_LEARNING_VISION_MODEL = "qwen3.6-plus";
  let called = false;
  globalThis.fetch = (async (_url, _init) => {
    called = true;
    return new Response("{}");
  }) as typeof fetch;

  const enriched = await maybeEnrichShotsWithCloud([
    { startSec: 0, endSec: 2, keyframePath: imagePath, visualSummary: "证据不足" },
  ]);

  expect(called).toBe(false);
  expect(enriched[0].visualSummary).toBe("证据不足");
});

test("OpenAI vision enrichment keeps the existing Responses API path", async () => {
  const imagePath = join(workdir, "frame-openai.jpg");
  await Bun.write(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  process.env.OPENAI_API_KEY = "openai-key";
  process.env.VIDEO_LEARNING_VISION_PROVIDER = "openai";
  process.env.VIDEO_LEARNING_VISION_MODEL = "gpt-4.1-mini";

  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("gpt-4.1-mini");
    expect(body.input[0].content[1].type).toBe("input_image");
    return new Response(JSON.stringify({
      output_text: JSON.stringify({
        shots: [{ shotIndex: 0, visualSummary: "OpenAI 视觉描述" }],
      }),
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const enriched = await maybeEnrichShotsWithCloud([
    { startSec: 0, endSec: 2, keyframePath: imagePath, visualSummary: "证据不足" },
  ]);

  expect(enriched[0].visualSummary).toBe("OpenAI 视觉描述");
});
