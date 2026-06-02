import { createHash } from "node:crypto";
import type { ContentAnalysisContent, ContentAnalysisProvider, TranscriptSegmentRecord } from "./types.ts";
import { timeRange } from "./time.ts";

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

export interface ContentAnalysisResult {
  provider: ContentAnalysisProvider;
  model: string;
  transcriptHash: string;
  content: ContentAnalysisContent;
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

export function hashTranscript(transcript: TranscriptSegmentRecord[]): string {
  const payload = transcript.map(segment => [segment.startSec, segment.endSec, segment.speaker, segment.text]).join("\n");
  return createHash("sha256").update(payload).digest("hex");
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values.map(item => item.trim()).filter(Boolean)) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function segmentWords(text: string): string[] {
  const latin = text.match(/[A-Za-z0-9_]{2,}/g) ?? [];
  const chinese = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  return [...latin, ...chinese].slice(0, 12);
}

function transcriptLine(segment: Pick<TranscriptSegmentRecord, "startSec" | "endSec" | "speaker" | "text">): string {
  return `${timeRange(segment.startSec, segment.endSec)} ${segment.speaker ?? "S1"}: ${segment.text}`;
}

function transcriptText(transcript: TranscriptSegmentRecord[]): string {
  return transcript.map(transcriptLine).join("\n");
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item).trim()).filter(Boolean);
}

function normalizeStructure(value: unknown): ContentAnalysisContent["structure"] {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    const obj = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return {
      startSec: typeof obj.startSec === "number" ? obj.startSec : undefined,
      endSec: typeof obj.endSec === "number" ? obj.endSec : undefined,
      summary: String(obj.summary ?? "").trim(),
      evidence: String(obj.evidence ?? "").trim(),
    };
  }).filter(item => (item.summary || item.evidence) && hasTimestampEvidence(item.evidence));
}

function normalizeContent(value: unknown, fallback: ContentAnalysisContent): ContentAnalysisContent {
  if (!value || typeof value !== "object") return fallback;
  const obj = value as Record<string, unknown>;
  const confidence = String(obj.confidence ?? fallback.confidence);
  const modelStructure = normalizeStructure(obj.structure);
  if (modelStructure.length === 0 && fallback.structure.length > 0) {
    return {
      ...fallback,
      evidenceNotes: unique([
        ...fallback.evidenceNotes,
        "模型输出缺少 transcript 时间段证据，已使用本地转写结构。",
      ]),
    };
  }
  return {
    topic: String(obj.topic ?? fallback.topic).trim(),
    audience: String(obj.audience ?? fallback.audience).trim(),
    hook: String(obj.hook ?? fallback.hook).trim(),
    structure: modelStructure.length > 0 ? modelStructure : fallback.structure,
    arguments: normalizeStringArray(obj.arguments).length > 0 ? normalizeStringArray(obj.arguments) : fallback.arguments,
    quotes: normalizeStringArray(obj.quotes).length > 0 ? normalizeStringArray(obj.quotes) : fallback.quotes,
    keywords: normalizeStringArray(obj.keywords).length > 0 ? normalizeStringArray(obj.keywords) : fallback.keywords,
    reusableFramework: String(obj.reusableFramework ?? fallback.reusableFramework).trim(),
    risks: normalizeStringArray(obj.risks).length > 0 ? normalizeStringArray(obj.risks) : fallback.risks,
    confidence: ["high", "medium", "low", "unknown"].includes(confidence) ? confidence as ContentAnalysisContent["confidence"] : fallback.confidence,
    evidenceNotes: normalizeStringArray(obj.evidenceNotes).length > 0 ? normalizeStringArray(obj.evidenceNotes) : fallback.evidenceNotes,
  };
}

function hasTimestampEvidence(value: string): boolean {
  return /\[\d{2}:\d{2}\.\d{3}-\d{2}:\d{2}\.\d{3}\]/.test(value);
}

export function localContentAnalysis(transcript: TranscriptSegmentRecord[], note = "模型增强不可用，仅做低置信度本地整理。"): ContentAnalysisContent {
  const first = transcript[0];
  const text = transcript.map(segment => segment.text).join(" ").trim();
  const keywords = unique([
    ...transcript.flatMap(segment => segment.keywords ?? []),
    ...transcript.flatMap(segment => segmentWords(segment.text)),
  ]).slice(0, 12);
  const structure = transcript.slice(0, 12).map(segment => ({
    startSec: segment.startSec,
    endSec: segment.endSec,
    summary: segment.text.slice(0, 80),
    evidence: timeRange(segment.startSec, segment.endSec),
  }));
  return {
    topic: keywords[0] ?? (text ? text.slice(0, 24) : "证据不足"),
    audience: "未知",
    hook: first ? first.text.slice(0, 120) : "未检测到转写内容",
    structure,
    arguments: transcript.slice(0, 8).map(segment => segment.text.slice(0, 120)),
    quotes: transcript.slice(0, 5).map(segment => segment.text).filter(Boolean),
    keywords,
    reusableFramework: transcript.length > 0 ? "按转写整理：开场信息 -> 论点展开 -> 收尾提示" : "证据不足，需补充可转写音频或字幕。",
    risks: ["机器转写需人工复核", "不得把口播推断为画面事实"],
    confidence: transcript.length > 0 ? "low" : "unknown",
    evidenceNotes: transcript.length > 0 ? ["仅基于语音转写/字幕证据", note] : ["证据不足：未检测到转写内容", note],
  };
}

function resolveProvider(): ContentAnalysisProvider | null {
  const textProvider = process.env.VIDEO_LEARNING_TEXT_PROVIDER?.trim().toLowerCase();
  if (textProvider && ["off", "none", "false", "0", "disabled"].includes(textProvider)) return null;
  if (textProvider === "openai" || textProvider === "dashscope") return textProvider;

  const visionProvider = process.env.VIDEO_LEARNING_VISION_PROVIDER?.trim().toLowerCase();
  if (visionProvider && ["off", "none", "false", "0", "disabled"].includes(visionProvider)) return null;
  if ((visionProvider === "dashscope" || visionProvider === "qwen" || visionProvider === "aliyun") && process.env.DASHSCOPE_API_KEY) return "dashscope";
  if (visionProvider === "openai" && process.env.OPENAI_API_KEY) return "openai";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.DASHSCOPE_API_KEY) return "dashscope";
  return null;
}

function modelFor(provider: ContentAnalysisProvider): string {
  if (provider === "openai") return process.env.VIDEO_LEARNING_TEXT_MODEL || process.env.VIDEO_LEARNING_VISION_MODEL || "gpt-4.1-mini";
  if (provider === "dashscope") return process.env.VIDEO_LEARNING_TEXT_MODEL || process.env.VIDEO_LEARNING_VISION_MODEL || "qwen3.6-plus";
  return "fallback";
}

function contentPrompt(transcript: TranscriptSegmentRecord[]): string {
  return [
    "你是短视频内容策略分析师。只基于下面带时间戳的语音转写/字幕证据做内容分析。",
    "禁止分析或推断画面、镜头、景别、构图、运镜、画面字幕、道具、人物外观和拍摄方式。",
    "所有关键结论必须在 structure.evidence 或 evidenceNotes 中引用 transcript 时间段。",
    "只返回 JSON，不要 Markdown。",
    "JSON 形状：{\"topic\":\"...\",\"audience\":\"...\",\"hook\":\"...\",\"structure\":[{\"startSec\":0,\"endSec\":3,\"summary\":\"...\",\"evidence\":\"[00:00.000-00:03.000] ...\"}],\"arguments\":[\"...\"],\"quotes\":[\"...\"],\"keywords\":[\"...\"],\"reusableFramework\":\"...\",\"risks\":[\"...\"],\"confidence\":\"high|medium|low|unknown\",\"evidenceNotes\":[\"...\"]}",
    "",
    "Transcript:",
    transcriptText(transcript),
  ].join("\n");
}

function mergePrompt(transcript: TranscriptSegmentRecord[], summaries: ContentAnalysisContent[]): string {
  return [
    "你是短视频内容策略分析师。下面是同一个视频的分块内容分析，请合并成一份最终内容分析。",
    "只允许使用分块分析和原始 transcript 时间段作为证据，禁止推断画面、镜头或拍摄方式。",
    "所有 structure.evidence 必须包含 transcript 时间段，格式如 [00:00.000-00:03.000]。",
    "只返回 JSON，不要 Markdown。",
    "JSON 形状：{\"topic\":\"...\",\"audience\":\"...\",\"hook\":\"...\",\"structure\":[{\"startSec\":0,\"endSec\":3,\"summary\":\"...\",\"evidence\":\"[00:00.000-00:03.000] ...\"}],\"arguments\":[\"...\"],\"quotes\":[\"...\"],\"keywords\":[\"...\"],\"reusableFramework\":\"...\",\"risks\":[\"...\"],\"confidence\":\"high|medium|low|unknown\",\"evidenceNotes\":[\"...\"]}",
    "",
    "Chunk summaries:",
    JSON.stringify(summaries, null, 2),
    "",
    "Original transcript:",
    transcriptText(transcript),
  ].join("\n");
}

function textChunkChars(): number {
  const parsed = Number(process.env.VIDEO_LEARNING_TEXT_CHUNK_CHARS ?? "12000");
  if (!Number.isFinite(parsed) || parsed <= 0) return 12000;
  return Math.max(100, Math.floor(parsed));
}

function chunkTranscript(transcript: TranscriptSegmentRecord[], maxChars: number): TranscriptSegmentRecord[][] {
  const chunks: TranscriptSegmentRecord[][] = [];
  let current: TranscriptSegmentRecord[] = [];
  let currentChars = 0;
  for (const segment of transcript) {
    const lineChars = transcriptLine(segment).length + 1;
    if (current.length > 0 && currentChars + lineChars > maxChars) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(segment);
    currentChars += lineChars;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function requestTimeoutMs(): number {
  const parsed = Number(process.env.VIDEO_LEARNING_CLOUD_REQUEST_TIMEOUT_MS ?? "120000");
  if (!Number.isFinite(parsed) || parsed <= 0) return 120000;
  return Math.floor(parsed);
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

async function analyzeOpenAiPrompt(prompt: string, model: string, fallback: ContentAnalysisContent): Promise<ContentAnalysisContent> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const response = await fetchWithTimeout(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    }),
  });
  if (!response.ok) throw new Error(`OpenAI Responses API failed: ${response.status} ${await response.text()}`);
  const parsed = jsonFromText(outputText(await response.json() as ResponsesApiOutput));
  return normalizeContent(parsed, fallback);
}

async function analyzeDashScopePrompt(prompt: string, model: string, fallback: ContentAnalysisContent): Promise<ContentAnalysisContent> {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("DASHSCOPE_API_KEY is not configured");
  const baseUrl = process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) throw new Error(`DashScope chat completions failed: ${response.status} ${await response.text()}`);
  const parsed = jsonFromText(chatOutputText(await response.json() as ChatCompletionsOutput));
  return normalizeContent(parsed, fallback);
}

async function analyzeWithProvider(provider: ContentAnalysisProvider, model: string, prompt: string, fallback: ContentAnalysisContent): Promise<ContentAnalysisContent> {
  return provider === "openai"
    ? await analyzeOpenAiPrompt(prompt, model, fallback)
    : await analyzeDashScopePrompt(prompt, model, fallback);
}

export async function analyzeContentFromTranscript(transcript: TranscriptSegmentRecord[]): Promise<ContentAnalysisResult> {
  const transcriptHash = hashTranscript(transcript);
  const provider = resolveProvider();
  if (!provider || transcript.length === 0) {
    return {
      provider: "local",
      model: "fallback",
      transcriptHash,
      content: localContentAnalysis(transcript),
    };
  }
  const model = modelFor(provider);
  try {
    const chunks = chunkTranscript(transcript, textChunkChars());
    const fallback = localContentAnalysis(transcript, "文本模型响应不完整，已用本地字段补齐。");
    const content = chunks.length > 1
      ? await analyzeWithProvider(
          provider,
          model,
          mergePrompt(transcript, await Promise.all(chunks.map(chunk => analyzeWithProvider(
            provider,
            model,
            contentPrompt(chunk),
            localContentAnalysis(chunk, "文本模型响应不完整，已用本地字段补齐。"),
          )))),
          fallback,
        )
      : await analyzeWithProvider(provider, model, contentPrompt(transcript), fallback);
    return { provider, model, transcriptHash, content };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      provider: "local",
      model: "fallback",
      transcriptHash,
      content: localContentAnalysis(transcript, `模型增强不可用：${message}`),
    };
  }
}
