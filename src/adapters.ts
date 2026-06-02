import { existsSync } from "node:fs";
import { dirname, delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Platform } from "./types.ts";

export interface AdapterDefinition {
  name: string;
  platforms: Platform[];
  envVar?: string;
  defaultCommand?: string[];
  installHint: string;
  directDownload: boolean;
  usedAccount: boolean;
  usedProxy: boolean;
}

export interface AdapterStatus extends AdapterDefinition {
  available: boolean;
  command: string[] | null;
  reason: string;
}

export interface AdapterResolutionContext {
  env?: Record<string, string | undefined>;
  pathLookup?: (command: string) => string | null;
  projectRoot?: string;
}

export const ADAPTERS: AdapterDefinition[] = [
  {
    name: "yt-dlp",
    platforms: ["youtube", "tiktok", "unknown"],
    defaultCommand: ["yt-dlp"],
    installHint: "Installed via Homebrew or Python package yt-dlp. Used directly for YouTube and as TikTok fallback.",
    directDownload: true,
    usedAccount: false,
    usedProxy: false,
  },
  {
    name: "playwright-media-sniffer",
    platforms: ["douyin", "xiaohongshu", "wechat_channels"],
    defaultCommand: [".venv/bin/python", "scripts/adapters/browser_media_download.py"],
    installHint: "Installed by scripts/install_adapters.sh. Uses the read-later Playwright media-sniffing strategy for platforms where yt-dlp is weak.",
    directDownload: true,
    usedAccount: true,
    usedProxy: false,
  },
  {
    name: "tiktok-api",
    platforms: ["tiktok"],
    envVar: "VIDEO_LEARNING_TIKTOK_API_CMD",
    installHint: "Optional. Configure a wrapper command that emits JSON with path/title/duration. TikTokApi itself is installed in .venv by scripts/install_adapters.sh.",
    directDownload: false,
    usedAccount: true,
    usedProxy: false,
  },
  {
    name: "douyin-tiktok-download-api",
    platforms: ["douyin"],
    envVar: "VIDEO_LEARNING_DOUYIN_API_CMD",
    installHint: "Optional. Configure a local wrapper or API client command for Douyin_TikTok_Download_API / douyin-tiktok-scraper.",
    directDownload: true,
    usedAccount: true,
    usedProxy: false,
  },
  {
    name: "mediacrawler",
    platforms: ["douyin", "xiaohongshu"],
    envVar: "VIDEO_LEARNING_MEDIACRAWLER_CMD",
    installHint: "Optional. Clone/setup MediaCrawler separately, then point this env var at a wrapper command that outputs downloaded video JSON.",
    directDownload: false,
    usedAccount: true,
    usedProxy: false,
  },
  {
    name: "res-downloader-cli",
    platforms: ["wechat_channels", "xiaohongshu"],
    envVar: "VIDEO_LEARNING_RES_DOWNLOADER_CMD",
    installHint: "Optional/manual. res-downloader is GUI/proxy based; configure a local helper command only if you have one.",
    directDownload: true,
    usedAccount: true,
    usedProxy: true,
  },
  {
    name: "wx_channels_download",
    platforms: ["wechat_channels"],
    envVar: "VIDEO_LEARNING_WX_CHANNELS_CMD",
    installHint: "Optional. Configure a WeChat Channels downloader helper command that emits JSON with a local path.",
    directDownload: true,
    usedAccount: true,
    usedProxy: false,
  },
];

const defaultProjectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function defaultPathLookup(command: string, projectRoot = defaultProjectRoot): string | null {
  if (command.includes("/") && existsSync(command)) return command;
  const localTool = join(projectRoot, ".venv", "bin", command);
  if (existsSync(localTool)) return localTool;
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function normalizeProjectRelativeToken(token: string, projectRoot: string): string {
  if (isAbsolute(token) || !token.includes("/")) return token;
  const candidate = join(projectRoot, token);
  return existsSync(candidate) ? candidate : token;
}

function normalizeConfiguredCommand(command: string[], projectRoot: string): string[] {
  return command.map(token => normalizeProjectRelativeToken(token, projectRoot));
}

export function splitCommand(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;
  for (const ch of command) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && !quote) {
      quote = ch;
      continue;
    }
    if (quote === ch) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

export function getAdapterDefinition(name: string): AdapterDefinition | null {
  return ADAPTERS.find(adapter => adapter.name === name) ?? null;
}

export function adaptersForPlatform(platform: Platform, strategy = "normal"): AdapterDefinition[] {
  const candidates = ADAPTERS.filter(adapter => adapter.platforms.includes(platform) || (platform === "unknown" && adapter.name === "yt-dlp"));
  if (platform === "tiktok" && strategy === "strong") {
    return candidates.sort((a, b) => Number(a.name === "yt-dlp") - Number(b.name === "yt-dlp"));
  }
  return candidates.sort((a, b) => {
    if (a.name === "yt-dlp") return -1;
    if (b.name === "yt-dlp") return 1;
    return 0;
  });
}

export function buildAdapterCommand(name: string, ctx: AdapterResolutionContext = {}): string[] | null {
  const adapter = getAdapterDefinition(name);
  if (!adapter) return null;
  const env = ctx.env ?? process.env;
  const projectRoot = ctx.projectRoot ?? defaultProjectRoot;
  const pathLookup = ctx.pathLookup ?? ((command: string) => defaultPathLookup(command, ctx.projectRoot));
  if (adapter.envVar && env[adapter.envVar]) {
    const command = splitCommand(env[adapter.envVar]!);
    return command.length > 0 ? normalizeConfiguredCommand(command, projectRoot) : null;
  }
  if (!adapter.defaultCommand) return null;
  const normalizedDefault = normalizeConfiguredCommand(adapter.defaultCommand, projectRoot);
  const executable = normalizedDefault[0];
  if (isAbsolute(executable) || executable.includes("/")) {
    return existsSync(executable) ? normalizedDefault : null;
  }
  const localTool = join(projectRoot, ".venv", "bin", executable);
  const resolved = existsSync(localTool) ? localTool : pathLookup(executable);
  return resolved ? [resolved, ...normalizedDefault.slice(1)] : null;
}

export function listAdapterStatuses(ctx: AdapterResolutionContext = {}): AdapterStatus[] {
  return ADAPTERS.map(adapter => {
    const command = buildAdapterCommand(adapter.name, ctx);
    return {
      ...adapter,
      command,
      available: Boolean(command),
      reason: command ? "available" : adapter.envVar ? `Set ${adapter.envVar}` : adapter.installHint,
    };
  });
}
