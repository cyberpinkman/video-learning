import { readFileSync } from "node:fs";
import type { ShotInput } from "./types.ts";

interface ResponsesApiOutput {
  output_text?: string;
  output?: Array<{
    content?: Array<{ text?: string; type?: string }>;
  }>;
}

interface ChatCompletionsOutput {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string; type?: string }>;
    };
  }>;
}

function outputText(data: ResponsesApiOutput): string {
  if (typeof data.output_text === "string") return data.output_text;
  return data.output?.flatMap(item => item.content ?? []).map(item => item.text ?? "").join("\n").trim() ?? "";
}

function chatOutputText(data: ChatCompletionsOutput): string {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(item => item.text ?? "").join("\n").trim();
  return "";
}

function jsonFromText(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced?.[1] ?? text;
  return JSON.parse(raw);
}

function imageDataUrl(path: string): string {
  const b64 = readFileSync(path).toString("base64");
  return `data:image/jpeg;base64,${b64}`;
}

function openAiImageContent(path: string): { type: "input_image"; image_url: string; detail: "low" } {
  return { type: "input_image", image_url: imageDataUrl(path), detail: "low" };
}

function qwenImageContent(path: string): { type: "image_url"; image_url: { url: string } } {
  return { type: "image_url", image_url: { url: imageDataUrl(path) } };
}

interface ShotSample {
  shot: ShotInput;
  index: number;
}

type VisionProvider = "openai" | "dashscope";

function resolveProvider(): VisionProvider | null {
  const configured = process.env.VIDEO_LEARNING_VISION_PROVIDER?.toLowerCase();
  if (configured && ["off", "none", "false", "0", "disabled"].includes(configured)) return null;
  if (configured === "qwen" || configured === "dashscope" || configured === "aliyun") return "dashscope";
  if (configured === "openai") return "openai";
  const model = process.env.VIDEO_LEARNING_VISION_MODEL?.toLowerCase() ?? "";
  if (model.startsWith("qwen")) return "dashscope";
  if (process.env.DASHSCOPE_API_KEY && !process.env.OPENAI_API_KEY) return "dashscope";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.DASHSCOPE_API_KEY) return "dashscope";
  return null;
}

function timeRange(startSec?: number, endSec?: number): string {
  const start = Number.isFinite(startSec) ? startSec!.toFixed(3) : "0.000";
  const end = Number.isFinite(endSec) ? endSec!.toFixed(3) : "0.000";
  return `${start}-${end}s`;
}

function visionPrompt(samples: ShotSample[]): string {
  const shotList = samples.map((sample, localIndex) => {
    return `- imageOrder ${localIndex}: shotIndex ${sample.index}, time ${timeRange(sample.shot.startSec, sample.shot.endSec)}`;
  }).join("\n");
  return [
    "你是短视频导演和剪辑分析师。分析这些关键帧，并只返回 JSON。",
    "JSON 形状：{\"shots\":[{\"shotIndex\":0,\"visualSummary\":\"...\",\"shotSize\":\"...\",\"cameraMotion\":\"...\",\"composition\":\"...\",\"subtitles\":\"...\",\"audioRole\":\"...\",\"purpose\":\"...\"}]}",
    "要求：结论必须可复拍，描述画面、景别、构图、运镜、字幕和镜头功能；不要泛泛评价。",
    "shotIndex 必须使用下面列出的全局 shotIndex，不要从 0 重新编号。",
    "如果能读到画面字幕，把字幕写入 subtitles；读不到就填空字符串。",
    "本批次镜头和图片顺序：",
    shotList,
  ].join("\n");
}

type ShotPatch = Partial<ShotInput> & { shotIndex?: number };

function normalizeShotPayload(parsed: unknown): { shots?: ShotPatch[] } {
  if (Array.isArray(parsed)) {
    if (parsed.every(item => item && typeof item === "object" && "shotIndex" in item)) {
      return { shots: parsed as ShotPatch[] };
    }
    for (const item of parsed) {
      const nested = normalizeShotPayload(item);
      if (Array.isArray(nested.shots)) return nested;
    }
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj.shots)) return { shots: obj.shots as ShotPatch[] };
  if (obj.data) return normalizeShotPayload(obj.data);
  if (obj.result) return normalizeShotPayload(obj.result);
  return {};
}

function mergeShotAnalysis(shots: ShotInput[], parsed: unknown, samples?: ShotSample[]): ShotInput[] {
  const payload = normalizeShotPayload(parsed);
  if (!Array.isArray(payload.shots)) return shots;
  const merged = [...shots];
  const allowedGlobalIndexes = samples ? new Set(samples.map(sample => sample.index)) : null;
  for (const item of payload.shots) {
    const rawIndex = item.shotIndex;
    if (typeof rawIndex !== "number") continue;
    const targetIndex = allowedGlobalIndexes?.has(rawIndex)
      ? rawIndex
      : samples && rawIndex >= 0 && rawIndex < samples.length
        ? samples[rawIndex]?.index
        : rawIndex;
    if (targetIndex === undefined) continue;
    if (allowedGlobalIndexes && !allowedGlobalIndexes.has(targetIndex)) continue;
    const target = merged[targetIndex];
    if (!target) continue;
    merged[targetIndex] = {
      ...target,
      visualSummary: item.visualSummary || target.visualSummary,
      shotSize: item.shotSize || target.shotSize,
      cameraMotion: item.cameraMotion || target.cameraMotion,
      composition: item.composition || target.composition,
      subtitles: item.subtitles || target.subtitles,
      audioRole: item.audioRole || target.audioRole,
      purpose: item.purpose || target.purpose,
    };
  }
  return merged;
}

function parseFrameLimit(value: string | undefined): number {
  const raw = (value ?? "12").trim().toLowerCase();
  if (["all", "full", "complete", "全部", "完整"].includes(raw)) return Number.POSITIVE_INFINITY;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 12;
  if (parsed <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor(parsed);
}

function parseBatchSize(value: string | undefined): number {
  const parsed = Number(value ?? "8");
  if (!Number.isFinite(parsed) || parsed <= 0) return 8;
  return Math.min(Math.floor(parsed), 16);
}

function requestTimeoutMs(): number {
  const parsed = Number(process.env.VIDEO_LEARNING_CLOUD_REQUEST_TIMEOUT_MS ?? "120000");
  if (!Number.isFinite(parsed) || parsed <= 0) return 120000;
  return Math.floor(parsed);
}

function chunkSamples(samples: ShotSample[], batchSize: number): ShotSample[][] {
  const chunks: ShotSample[][] = [];
  for (let index = 0; index < samples.length; index += batchSize) {
    chunks.push(samples.slice(index, index + batchSize));
  }
  return chunks;
}

export async function maybeEnrichShotsWithCloud(shots: ShotInput[]): Promise<ShotInput[]> {
  const provider = resolveProvider();
  if (!provider) return shots;
  const maxFrames = parseFrameLimit(process.env.VIDEO_LEARNING_CLOUD_FRAME_LIMIT);
  const batchSize = parseBatchSize(process.env.VIDEO_LEARNING_CLOUD_BATCH_SIZE);
  const samples = shots
    .map((shot, index) => ({ shot, index }))
    .filter(sample => sample.shot.keyframePath)
    .slice(0, maxFrames);
  if (samples.length === 0) return shots;

  let enriched = shots;
  const batches = chunkSamples(samples, batchSize);
  for (const [batchIndex, batch] of batches.entries()) {
    const indexes = batch.map(sample => sample.index).join(",");
    console.error(`[video-learning] cloud vision batch ${batchIndex + 1}/${batches.length}: shots ${indexes}`);
    try {
      enriched = provider === "dashscope"
        ? await enrichWithDashScope(enriched, batch)
        : await enrichWithOpenAI(enriched, batch);
      console.error(`[video-learning] cloud vision batch ${batchIndex + 1}/${batches.length}: done`);
    } catch (error) {
      console.error(`[video-learning] cloud vision enrichment skipped for shots ${indexes}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return enriched;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs());
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function enrichWithOpenAI(shots: ShotInput[], samples: ShotSample[]): Promise<ShotInput[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return shots;
  const model = process.env.VIDEO_LEARNING_VISION_MODEL || "gpt-4.1-mini";
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "low" }> = [
    { type: "input_text", text: visionPrompt(samples) },
    ...samples.map(sample => openAiImageContent(sample.shot.keyframePath!)),
  ];
  const response = await fetchWithTimeout(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content }],
    }),
  });
  if (!response.ok) throw new Error(`OpenAI Responses API failed: ${response.status} ${await response.text()}`);
  const data = await response.json() as ResponsesApiOutput;
  const parsed = jsonFromText(outputText(data));
  return mergeShotAnalysis(shots, parsed, samples);
}

async function enrichWithDashScope(shots: ShotInput[], samples: ShotSample[]): Promise<ShotInput[]> {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) return shots;
  const model = process.env.VIDEO_LEARNING_VISION_MODEL || "qwen3.6-plus";
  const baseUrl = process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
    { type: "text", text: visionPrompt(samples) },
    ...samples.map(sample => qwenImageContent(sample.shot.keyframePath!)),
  ];
  const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) throw new Error(`DashScope chat completions failed: ${response.status} ${await response.text()}`);
  const data = await response.json() as ChatCompletionsOutput;
  const parsed = jsonFromText(chatOutputText(data));
  return mergeShotAnalysis(shots, parsed, samples);
}
