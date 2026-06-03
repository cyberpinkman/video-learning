import type { ContentAnalysisProvider } from "./types.ts";

export type RemoteTextProvider = Exclude<ContentAnalysisProvider, "local">;

export interface TextProviderChoice {
  provider: RemoteTextProvider;
  model: string;
}

const OFF_VALUES = new Set(["off", "none", "false", "0", "disabled"]);

function splitProviders(value: string | undefined): string[] {
  return value?.split(/[,\s>]+/).map(item => item.trim().toLowerCase()).filter(Boolean) ?? [];
}

function normalizeProvider(value: string): RemoteTextProvider | null {
  if (value === "openai") return "openai";
  if (value === "dashscope" || value === "qwen" || value === "aliyun") return "dashscope";
  if (value === "glm" || value === "zai" || value === "zhipu" || value === "bigmodel") return "glm";
  if (value === "minimax" || value === "minimax-cn" || value === "minimaxi") return "minimax";
  return null;
}

function hasGlmKey(): boolean {
  return Boolean(process.env.GLM_API_KEY || process.env.ZAI_API_KEY || process.env.BIGMODEL_API_KEY || process.env.ZHIPUAI_API_KEY);
}

function hasMiniMaxKey(): boolean {
  return Boolean(process.env.MINIMAX_API_KEY || process.env.MINIMAX_CN_API_KEY);
}

function uniqueProviders(values: RemoteTextProvider[]): RemoteTextProvider[] {
  const out: RemoteTextProvider[] = [];
  const seen = new Set<RemoteTextProvider>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function modelFor(provider: RemoteTextProvider, fallback: boolean): string {
  const explicit = fallback ? process.env.VIDEO_LEARNING_TEXT_FALLBACK_MODEL : process.env.VIDEO_LEARNING_TEXT_MODEL;
  if (provider === "openai") return explicit || process.env.VIDEO_LEARNING_VISION_MODEL || "gpt-4.1-mini";
  if (provider === "dashscope") return explicit || process.env.VIDEO_LEARNING_VISION_MODEL || "qwen3.6-plus";
  if (provider === "glm") return explicit || process.env.VIDEO_LEARNING_GLM_MODEL || process.env.GLM_MODEL || "glm-5.1";
  return explicit || process.env.VIDEO_LEARNING_MINIMAX_MODEL || process.env.MINIMAX_MODEL || "MiniMax-M2.7-highspeed";
}

export function resolveTextProviderChain(): TextProviderChoice[] {
  const textProviderRaw = process.env.VIDEO_LEARNING_TEXT_PROVIDER?.trim().toLowerCase();
  if (textProviderRaw && OFF_VALUES.has(textProviderRaw)) return [];

  if (textProviderRaw) {
    const primary = splitProviders(textProviderRaw).map(normalizeProvider).filter(item => item !== null);
    const fallback = splitProviders(process.env.VIDEO_LEARNING_TEXT_FALLBACK_PROVIDER).map(normalizeProvider).filter(item => item !== null);
    const providers = uniqueProviders([...primary, ...fallback]);
    if (providers.includes("glm") && !providers.includes("minimax") && hasMiniMaxKey()) providers.push("minimax");
    return providers.map((provider, index) => ({ provider, model: modelFor(provider, index > 0) }));
  }

  const providers: RemoteTextProvider[] = [];
  if (hasGlmKey()) providers.push("glm");
  if (hasMiniMaxKey()) providers.push("minimax");
  if (providers.length > 0) return uniqueProviders(providers).map((provider, index) => ({ provider, model: modelFor(provider, index > 0) }));

  const visionProvider = process.env.VIDEO_LEARNING_VISION_PROVIDER?.trim().toLowerCase();
  if (visionProvider && OFF_VALUES.has(visionProvider)) return [];
  const vision = visionProvider ? normalizeProvider(visionProvider) : null;
  if (vision === "openai" || vision === "dashscope") return [{ provider: vision, model: modelFor(vision, false) }];

  if (process.env.OPENAI_API_KEY) providers.push("openai");
  if (process.env.DASHSCOPE_API_KEY) providers.push("dashscope");
  return uniqueProviders(providers).map((provider, index) => ({ provider, model: modelFor(provider, index > 0) }));
}

export function apiKeyForTextProvider(provider: RemoteTextProvider): string | undefined {
  if (provider === "openai") return process.env.OPENAI_API_KEY;
  if (provider === "dashscope") return process.env.DASHSCOPE_API_KEY;
  if (provider === "glm") return process.env.GLM_API_KEY || process.env.ZAI_API_KEY || process.env.BIGMODEL_API_KEY || process.env.ZHIPUAI_API_KEY;
  return process.env.MINIMAX_API_KEY || process.env.MINIMAX_CN_API_KEY;
}

export function baseUrlForTextProvider(provider: RemoteTextProvider): string {
  if (provider === "openai") return process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  if (provider === "dashscope") return process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
  if (provider === "glm") {
    return process.env.GLM_BASE_URL
      || process.env.ZAI_BASE_URL
      || process.env.BIGMODEL_BASE_URL
      || (process.env.BIGMODEL_API_KEY || process.env.ZHIPUAI_API_KEY ? "https://open.bigmodel.cn/api/paas/v4" : "https://api.z.ai/api/paas/v4");
  }
  return process.env.MINIMAX_BASE_URL || (process.env.MINIMAX_CN_API_KEY ? "https://api.minimaxi.com/v1" : "https://api.minimax.io/v1");
}

export function endpointUrl(baseUrl: string, path: string): string {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  if (cleanBase.endsWith(path)) return cleanBase;
  return `${cleanBase}${path}`;
}
