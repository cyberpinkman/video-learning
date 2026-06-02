import type { Platform } from "./types.ts";

export function detectPlatform(url: string): Platform {
  const lower = url.toLowerCase();
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) return "youtube";
  if (lower.includes("douyin.com")) return "douyin";
  if (lower.includes("xiaohongshu.com") || lower.includes("xhslink.com")) return "xiaohongshu";
  if (lower.includes("tiktok.com")) return "tiktok";
  if (lower.includes("channels.weixin.qq.com") || lower.includes("weixin.qq.com")) return "wechat_channels";
  return "unknown";
}
