import type { AccountContentAnalysisContent, ContentAnalysisContent, ContentAnalysisProvider, TranscriptSegmentRecord, VideoRecord } from "./types.ts";
import { timeRange } from "./time.ts";
import { apiKeyForTextProvider, baseUrlForTextProvider, endpointUrl, resolveTextProviderChain, type RemoteTextProvider, type TextProviderChoice } from "./text-provider.ts";

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

export interface AccountContentVideoInput {
  video: VideoRecord;
  analysisId: string;
  content: ContentAnalysisContent;
  transcriptSegments: Array<Pick<TranscriptSegmentRecord, "startSec" | "endSec" | "text">>;
}

export interface AccountContentAnalysisResult {
  provider: ContentAnalysisProvider;
  model: string;
  content: AccountContentAnalysisContent;
}

export interface AnalyzeAccountContentInput {
  author: string;
  videos: AccountContentVideoInput[];
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values.map(item => item.trim()).filter(Boolean)) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const withoutThinking = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const raw = fenced?.[1] ?? withoutThinking;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  }
  return JSON.parse(raw);
}

function hasTimestampEvidence(value: string): boolean {
  if (!/\[\d{2}:\d{2}\.\d{3}-\d{2}:\d{2}\.\d{3}\]/.test(value)) return false;
  return true;
}

function evidenceReferencesVideo(value: string, videoId: string): boolean {
  const token = escapeRegExp(videoId);
  return new RegExp(`(^|[^A-Za-z0-9_])${token}([^A-Za-z0-9_]|$)`).test(value);
}

function referencedVideoIds(value: string, allowedVideoIds: Set<string>): string[] {
  if (!hasTimestampEvidence(value)) return [];
  return [...allowedVideoIds].filter(videoId => evidenceReferencesVideo(value, videoId));
}

function hasVideoEvidence(value: string, allowedVideoIds: Set<string>): boolean {
  return referencedVideoIds(value, allowedVideoIds).length > 0;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item).trim()).filter(Boolean);
}

function claimText(item: AccountContentAnalysisContent["contentPillars"][number]): string {
  return item.claim || item.name || item.pattern || item.reason || "";
}

function normalizeEvidenceClaim(value: unknown, fallback: AccountContentAnalysisContent["positioning"], allowedVideoIds: Set<string>): AccountContentAnalysisContent["positioning"] {
  const obj = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const evidence = String(obj.evidence ?? "").trim();
  const videos = unique([
    ...normalizeStringArray(obj.videos).filter(videoId => allowedVideoIds.has(videoId)),
    ...referencedVideoIds(evidence, allowedVideoIds),
  ]);
  const claim = String(obj.claim ?? obj.name ?? obj.pattern ?? obj.reason ?? "").trim();
  if (!claim || videos.length === 0 || !hasVideoEvidence(evidence, allowedVideoIds)) return fallback;
  return { claim, evidence, videos };
}

function normalizeEvidenceItems(value: unknown, allowedVideoIds: Set<string>): AccountContentAnalysisContent["contentPillars"] {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    const obj = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const evidence = String(obj.evidence ?? "").trim();
    const referenced = referencedVideoIds(evidence, allowedVideoIds);
    const videos = unique([
      ...normalizeStringArray(obj.videos).filter(videoId => referenced.includes(videoId)),
      ...referenced,
    ]);
    return {
      claim: obj.claim === undefined ? undefined : String(obj.claim).trim(),
      name: obj.name === undefined ? undefined : String(obj.name).trim(),
      pattern: obj.pattern === undefined ? undefined : String(obj.pattern).trim(),
      reason: obj.reason === undefined ? undefined : String(obj.reason).trim(),
      evidence,
      videos,
    };
  }).filter(item => claimText(item) && item.videos.length > 0 && hasVideoEvidence(item.evidence, allowedVideoIds));
}

function normalizeRepresentativeVideos(value: unknown, allowedVideoIds: Set<string>): AccountContentAnalysisContent["representativeVideos"] {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    const obj = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return {
      videoId: String(obj.videoId ?? "").trim(),
      reason: String(obj.reason ?? "").trim(),
      evidence: String(obj.evidence ?? "").trim(),
    };
  }).filter(item => allowedVideoIds.has(item.videoId) && item.reason && hasTimestampEvidence(item.evidence) && evidenceReferencesVideo(item.evidence, item.videoId));
}

function normalizeAccountContent(value: unknown, fallback: AccountContentAnalysisContent, allowedVideoIds: Set<string>): AccountContentAnalysisContent {
  if (!value || typeof value !== "object") return fallback;
  const obj = value as Record<string, unknown>;
  const positioning = normalizeEvidenceClaim(obj.positioning, fallback.positioning, allowedVideoIds);
  const audience = normalizeEvidenceClaim(obj.audience, fallback.audience, allowedVideoIds);
  const contentPillars = normalizeEvidenceItems(obj.contentPillars, allowedVideoIds);
  const hookPatterns = normalizeEvidenceItems(obj.hookPatterns, allowedVideoIds);
  if (contentPillars.length === 0 || hookPatterns.length === 0) {
    return {
      ...fallback,
      evidenceNotes: unique([
        ...fallback.evidenceNotes,
        "账号模型输出缺少参与视频证据，已使用本地低置信度聚合。",
      ]),
    };
  }
  const confidence = String(obj.confidence ?? fallback.confidence);
  return {
    positioning,
    audience,
    contentPillars,
    hookPatterns,
    argumentPatterns: normalizeEvidenceItems(obj.argumentPatterns, allowedVideoIds),
    keywords: normalizeEvidenceItems(obj.keywords, allowedVideoIds).length > 0 ? normalizeEvidenceItems(obj.keywords, allowedVideoIds) : fallback.keywords,
    representativeVideos: normalizeRepresentativeVideos(obj.representativeVideos, allowedVideoIds),
    reusableTemplates: normalizeEvidenceItems(obj.reusableTemplates, allowedVideoIds).length > 0 ? normalizeEvidenceItems(obj.reusableTemplates, allowedVideoIds) : fallback.reusableTemplates,
    opportunities: normalizeEvidenceItems(obj.opportunities, allowedVideoIds).length > 0 ? normalizeEvidenceItems(obj.opportunities, allowedVideoIds) : fallback.opportunities,
    risks: normalizeEvidenceItems(obj.risks, allowedVideoIds).length > 0 ? normalizeEvidenceItems(obj.risks, allowedVideoIds) : fallback.risks,
    confidence: ["high", "medium", "low", "unknown"].includes(confidence) ? confidence as AccountContentAnalysisContent["confidence"] : fallback.confidence,
    evidenceNotes: normalizeStringArray(obj.evidenceNotes).length > 0 ? normalizeStringArray(obj.evidenceNotes) : fallback.evidenceNotes,
  };
}

function firstEvidence(input: AccountContentVideoInput): string {
  const segment = input.transcriptSegments[0];
  if (segment) return `${input.video.id} ${timeRange(segment.startSec, segment.endSec)}`;
  const structure = input.content.structure[0];
  if (structure) return `${input.video.id} ${structure.evidence}`;
  return input.video.id;
}

function firstVideoIds(input: AccountContentVideoInput): string[] {
  return [input.video.id];
}

function evidenceItem(claim: string, input: AccountContentVideoInput): AccountContentAnalysisContent["contentPillars"][number] {
  return {
    claim,
    evidence: firstEvidence(input),
    videos: firstVideoIds(input),
  };
}

function itemByKeyword(keyword: string, input: AnalyzeAccountContentInput): AccountContentAnalysisContent["contentPillars"][number] {
  const video = input.videos.find(item => item.content.keywords.includes(keyword)) ?? input.videos[0];
  return video ? evidenceItem(keyword, video) : { claim: keyword, evidence: "", videos: [] };
}

export function localAccountContentAnalysis(input: AnalyzeAccountContentInput, note = "模型增强不可用，仅做低置信度本地账号聚合。"): AccountContentAnalysisContent {
  const keywords = unique(input.videos.flatMap(item => item.content.keywords)).slice(0, 16);
  const pillars = input.videos.slice(0, 8).map(item => ({
    name: item.content.topic || item.video.title,
    evidence: firstEvidence(item),
    videos: firstVideoIds(item),
  }));
  const firstVideo = input.videos[0];
  const firstEvidenceItem = firstVideo ? evidenceItem(`${input.author} 的内容围绕 ${keywords.slice(0, 3).join("、") || "已分析视频主题"} 展开。`, firstVideo) : { claim: "证据不足", evidence: "", videos: [] };
  return {
    positioning: firstEvidenceItem,
    audience: firstVideo ? evidenceItem(unique(input.videos.map(item => item.content.audience).filter(value => value && value !== "未知")).join("、") || "未知", firstVideo) : { claim: "未知", evidence: "", videos: [] },
    contentPillars: pillars,
    hookPatterns: input.videos.slice(0, 6).map(item => ({
      pattern: item.content.hook || "口播开场",
      evidence: firstEvidence(item),
      videos: firstVideoIds(item),
    })),
    argumentPatterns: input.videos.slice(0, 6).map(item => ({
      pattern: item.content.reusableFramework || "按转写整理内容结构",
      evidence: firstEvidence(item),
      videos: firstVideoIds(item),
    })),
    keywords: keywords.map(keyword => itemByKeyword(keyword, input)).filter(item => item.evidence),
    representativeVideos: input.videos.slice(0, 6).map(item => ({
      videoId: item.video.id,
      reason: item.content.topic || item.video.title,
      evidence: firstEvidence(item),
    })),
    reusableTemplates: unique(input.videos.map(item => item.content.reusableFramework)).slice(0, 8).map(template => evidenceItem(template, input.videos.find(item => item.content.reusableFramework === template) ?? input.videos[0])).filter(item => item.evidence),
    opportunities: firstVideo ? [
      evidenceItem("围绕高频关键词扩展系列选题", firstVideo),
      evidenceItem("复用已验证的 hook 和内容结构做同主题变体", firstVideo),
    ] : [],
    risks: firstVideo ? unique(["机器转写需人工复核", "账号级结论仅基于本次传入视频", ...input.videos.flatMap(item => item.content.risks)]).slice(0, 10).map(risk => evidenceItem(risk, firstVideo)) : [],
    confidence: input.videos.length > 0 ? "low" : "unknown",
    evidenceNotes: [`仅基于 ${input.videos.length} 条视频的 content-analyze-single 结果`, note],
  };
}

function compactVideos(input: AnalyzeAccountContentInput): unknown[] {
  return input.videos.map(item => ({
    videoId: item.video.id,
    title: item.video.title,
    author: item.video.author,
    publishedAt: item.video.publishedAt,
    durationSec: item.video.durationSec,
    contentAnalysisId: item.analysisId,
    topic: item.content.topic,
    audience: item.content.audience,
    hook: item.content.hook,
    structure: item.content.structure,
    arguments: item.content.arguments,
    keywords: item.content.keywords,
    reusableFramework: item.content.reusableFramework,
    representativeTranscriptEvidence: item.transcriptSegments.slice(0, 3).map(segment => ({
      time: timeRange(segment.startSec, segment.endSec),
      text: segment.text,
    })),
  }));
}

function accountPrompt(input: AnalyzeAccountContentInput): string {
  return [
    "你是短视频账号内容策略分析师。只基于下面多条视频的 content-analyze-single 结果和 transcript 时间段证据，做账号级内容策略总结。",
    "禁止分析或推断画面、镜头、景别、构图、运镜、视觉字幕、道具、人物外观和拍摄方式。",
    "所有账号级结论字段都必须包含参与视频 videoId 和 transcript 时间段证据，例如 vid_x [00:00.000-00:03.000]。",
    "positioning/audience 是 {claim,evidence,videos}；keywords/reusableTemplates/opportunities/risks 是 {claim,evidence,videos} 数组。",
    "只返回 JSON，不要 Markdown。",
    "JSON 形状：{\"positioning\":{\"claim\":\"...\",\"evidence\":\"vid_x [00:00.000-00:03.000]\",\"videos\":[\"vid_x\"]},\"audience\":{\"claim\":\"...\",\"evidence\":\"vid_x [00:00.000-00:03.000]\",\"videos\":[\"vid_x\"]},\"contentPillars\":[{\"name\":\"...\",\"evidence\":\"vid_x [00:00.000-00:03.000]\",\"videos\":[\"vid_x\"]}],\"hookPatterns\":[{\"pattern\":\"...\",\"evidence\":\"vid_x [00:00.000-00:03.000]\",\"videos\":[\"vid_x\"]}],\"argumentPatterns\":[{\"pattern\":\"...\",\"evidence\":\"vid_x [00:00.000-00:03.000]\",\"videos\":[\"vid_x\"]}],\"keywords\":[{\"claim\":\"...\",\"evidence\":\"vid_x [00:00.000-00:03.000]\",\"videos\":[\"vid_x\"]}],\"representativeVideos\":[{\"videoId\":\"vid_x\",\"reason\":\"...\",\"evidence\":\"vid_x [00:00.000-00:03.000]\"}],\"reusableTemplates\":[{\"claim\":\"...\",\"evidence\":\"vid_x [00:00.000-00:03.000]\",\"videos\":[\"vid_x\"]}],\"opportunities\":[{\"claim\":\"...\",\"evidence\":\"vid_x [00:00.000-00:03.000]\",\"videos\":[\"vid_x\"]}],\"risks\":[{\"claim\":\"...\",\"evidence\":\"vid_x [00:00.000-00:03.000]\",\"videos\":[\"vid_x\"]}],\"confidence\":\"high|medium|low|unknown\",\"evidenceNotes\":[\"...\"]}",
    "",
    `Author: ${input.author}`,
    "Videos:",
    JSON.stringify(compactVideos(input), null, 2),
  ].join("\n");
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

async function analyzeOpenAiPrompt(prompt: string, model: string, fallback: AccountContentAnalysisContent, allowedVideoIds: Set<string>): Promise<AccountContentAnalysisContent> {
  const apiKey = apiKeyForTextProvider("openai");
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  const response = await fetchWithTimeout(endpointUrl(baseUrlForTextProvider("openai"), "/responses"), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    }),
  });
  if (!response.ok) throw new Error(`OpenAI Responses API failed: ${response.status} ${await response.text()}`);
  return normalizeAccountContent(jsonFromText(outputText(await response.json() as ResponsesApiOutput)), fallback, allowedVideoIds);
}

async function analyzeDashScopePrompt(prompt: string, model: string, fallback: AccountContentAnalysisContent, allowedVideoIds: Set<string>): Promise<AccountContentAnalysisContent> {
  const apiKey = apiKeyForTextProvider("dashscope");
  if (!apiKey) throw new Error("DASHSCOPE_API_KEY is not configured");
  const response = await fetchWithTimeout(endpointUrl(baseUrlForTextProvider("dashscope"), "/chat/completions"), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) throw new Error(`DashScope chat completions failed: ${response.status} ${await response.text()}`);
  return normalizeAccountContent(jsonFromText(chatOutputText(await response.json() as ChatCompletionsOutput)), fallback, allowedVideoIds);
}

async function analyzeChatCompletionsPrompt(provider: Exclude<RemoteTextProvider, "openai" | "dashscope">, prompt: string, model: string, fallback: AccountContentAnalysisContent, allowedVideoIds: Set<string>): Promise<AccountContentAnalysisContent> {
  const apiKey = apiKeyForTextProvider(provider);
  if (!apiKey) throw new Error(`${provider} API key is not configured`);
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: prompt }],
    stream: false,
  };
  if (provider === "glm") body.thinking = { type: "disabled" };
  const response = await fetchWithTimeout(endpointUrl(baseUrlForTextProvider(provider), "/chat/completions"), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${provider} chat completions failed: ${response.status} ${await response.text()}`);
  return normalizeAccountContent(jsonFromText(chatOutputText(await response.json() as ChatCompletionsOutput)), fallback, allowedVideoIds);
}

async function analyzeWithProvider(choice: TextProviderChoice, prompt: string, fallback: AccountContentAnalysisContent, allowedVideoIds: Set<string>): Promise<AccountContentAnalysisContent> {
  if (choice.provider === "openai") return await analyzeOpenAiPrompt(prompt, choice.model, fallback, allowedVideoIds);
  if (choice.provider === "dashscope") return await analyzeDashScopePrompt(prompt, choice.model, fallback, allowedVideoIds);
  return await analyzeChatCompletionsPrompt(choice.provider, prompt, choice.model, fallback, allowedVideoIds);
}

export async function analyzeAccountContent(input: AnalyzeAccountContentInput): Promise<AccountContentAnalysisResult> {
  const fallback = localAccountContentAnalysis(input);
  const providerChoices = resolveTextProviderChain();
  if (providerChoices.length === 0 || input.videos.length === 0) {
    return { provider: "local", model: "fallback", content: fallback };
  }
  const allowedVideoIds = new Set(input.videos.map(item => item.video.id));
  const prompt = accountPrompt(input);
  const errors: string[] = [];
  for (const choice of providerChoices) {
    try {
      const content = await analyzeWithProvider(choice, prompt, fallback, allowedVideoIds);
      return { provider: choice.provider, model: choice.model, content };
    } catch (error) {
      errors.push(`${choice.provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    provider: "local",
    model: "fallback",
    content: localAccountContentAnalysis(input, `模型增强不可用：${errors.join("；") || "所有文本模型调用失败"}`),
  };
}
