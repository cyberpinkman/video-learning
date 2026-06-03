import { existsSync } from "node:fs";
import { join } from "node:path";
import { splitCommand } from "./adapters.ts";
import type { CommandResult, CommandRunner } from "./acquisition.ts";
import { detectPlatform } from "./platform.ts";
import type { AccountDiscoveredItem, AccountDiscoveryStatus, Platform } from "./types.ts";

export interface AccountDiscoveryResult {
  platform: Platform;
  accountUrl: string;
  accountId: string | null;
  author: string | null;
  expectedCount: number | null;
  discoveredCount: number;
  status: AccountDiscoveryStatus;
  items: AccountDiscoveredItem[];
  diagnostics: Record<string, unknown>;
}

export interface DiscoverAccountVideosInput {
  accountUrl: string;
  platform?: Platform;
  workspaceDir: string;
  commandRunner?: CommandRunner;
}

const defaultRunner: CommandRunner = async (command, options) => {
  const proc = Bun.spawn({ cmd: command, cwd: options?.cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

function resolveDiscoveryPython(): string {
  if (process.env.VIDEO_LEARNING_PYTHON) return process.env.VIDEO_LEARNING_PYTHON;
  const localPython = join(import.meta.dir, "..", ".venv", "bin", "python");
  return existsSync(localPython) ? localPython : "python3";
}

function timeoutMs(): string {
  const parsed = Number(process.env.VIDEO_LEARNING_ACCOUNT_DISCOVER_TIMEOUT_MS ?? "120000");
  return String(Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 120000);
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const normalized = value.replaceAll(",", "").trim();
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function typeFor(value: unknown): AccountDiscoveredItem["type"] {
  return value === "video" || value === "note" || value === "unknown" ? value : "unknown";
}

function publishedAt(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }
  return stringOrNull(value);
}

function itemId(item: Record<string, unknown>): string {
  return String(
    item.platformVideoId
    ?? item.platform_video_id
    ?? item.aweme_id
    ?? item.awemeId
    ?? item.id
    ?? "",
  ).trim();
}

function normalizeItem(item: unknown): AccountDiscoveredItem | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const obj = item as Record<string, unknown>;
  const platformVideoId = itemId(obj);
  const rawType = typeFor(obj.type);
  const type = rawType === "unknown" && String(obj.url ?? "").includes("/note/") ? "note" : rawType;
  const url = stringOrNull(obj.url) ?? (platformVideoId ? `https://www.douyin.com/${type === "note" ? "note" : "video"}/${platformVideoId}` : "");
  if (!platformVideoId && !url) return null;
  const durationSec = numberOrNull(obj.durationSec)
    ?? (numberOrNull(obj.duration_ms) !== null ? Number(numberOrNull(obj.duration_ms)) / 1000 : null)
    ?? (numberOrNull(obj.duration) !== null && Number(numberOrNull(obj.duration)) > 1000 ? Number(numberOrNull(obj.duration)) / 1000 : numberOrNull(obj.duration));
  return {
    platformVideoId,
    url,
    type,
    description: stringOrNull(obj.description) ?? stringOrNull(obj.desc) ?? stringOrNull(obj.title) ?? "",
    author: stringOrNull(obj.author),
    publishedAt: publishedAt(obj.publishedAt ?? obj.published_at ?? obj.create_time ?? obj.createTime),
    durationSec,
    acquiredVideoId: stringOrNull(obj.acquiredVideoId ?? obj.acquired_video_id ?? obj.video_id),
    acquireStatus: obj.acquireStatus === "success" || obj.acquireStatus === "failed" || obj.acquireStatus === "skipped" ? obj.acquireStatus : undefined,
    acquireMessage: stringOrNull(obj.acquireMessage ?? obj.acquire_message),
  };
}

function normalizeItems(rawItems: unknown): AccountDiscoveredItem[] {
  if (!Array.isArray(rawItems)) return [];
  const out: AccountDiscoveredItem[] = [];
  const seen = new Set<string>();
  for (const raw of rawItems) {
    const item = normalizeItem(raw);
    if (!item) continue;
    const key = item.platformVideoId || item.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function statusFor(input: { expectedCount: number | null; discoveredCount: number; author: string | null; accountId: string | null }): AccountDiscoveryStatus {
  if (!input.author || !input.accountId || input.expectedCount === null) return "failed";
  return input.discoveredCount === input.expectedCount ? "success" : "partial";
}

function statusOrNull(value: unknown): AccountDiscoveryStatus | null {
  return value === "success" || value === "partial" || value === "failed" ? value : null;
}

export function parseAccountDiscoveryStdout(stdout: string): AccountDiscoveryResult {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  let raw: Record<string, unknown> | null = null;
  for (const line of [...lines].reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
        break;
      }
    } catch {
      // Keep scanning earlier lines.
    }
  }
  if (!raw) throw new Error("account discovery command did not emit JSON");
  const platform = (raw.platform === "douyin" ? "douyin" : detectPlatform(String(raw.accountUrl ?? raw.account_url ?? ""))) as Platform;
  const items = normalizeItems(raw.items);
  const expectedCount = numberOrNull(raw.expectedCount ?? raw.expected_count);
  const accountId = stringOrNull(raw.accountId ?? raw.account_id ?? raw.secUserId ?? raw.sec_user_id);
  const author = stringOrNull(raw.author);
  const computedStatus = statusFor({ expectedCount, discoveredCount: items.length, author, accountId });
  const rawStatus = statusOrNull(raw.status);
  const status = rawStatus === "failed" ? "failed" : computedStatus;
  return {
    platform,
    accountUrl: stringOrNull(raw.accountUrl ?? raw.account_url) ?? "",
    accountId,
    author,
    expectedCount,
    discoveredCount: items.length,
    status,
    items,
    diagnostics: raw.diagnostics && typeof raw.diagnostics === "object" && !Array.isArray(raw.diagnostics) ? raw.diagnostics as Record<string, unknown> : {},
  };
}

function failedResult(input: DiscoverAccountVideosInput, diagnostics: Record<string, unknown>): AccountDiscoveryResult {
  const platform = (input.platform ?? detectPlatform(input.accountUrl)) as Platform;
  return {
    platform,
    accountUrl: input.accountUrl,
    accountId: null,
    author: null,
    expectedCount: null,
    discoveredCount: 0,
    status: "failed",
    items: [],
    diagnostics,
  };
}

async function runDiscoveryCommand(runner: CommandRunner, command: string[], cwd: string): Promise<AccountDiscoveryResult | null> {
  const result: CommandResult = await runner(command, { cwd });
  if (result.exitCode !== 0) {
    return null;
  }
  return parseAccountDiscoveryStdout(result.stdout);
}

function chooseBetter(first: AccountDiscoveryResult | null, second: AccountDiscoveryResult | null): AccountDiscoveryResult | null {
  if (!first) return second;
  if (!second) return first;
  if (second.status === "success" && first.status !== "success") return second;
  if (second.items.length > first.items.length) return second;
  return first;
}

export async function discoverAccountVideos(input: DiscoverAccountVideosInput): Promise<AccountDiscoveryResult> {
  const platform = input.platform ?? detectPlatform(input.accountUrl);
  if (platform !== "douyin") throw new Error("content-discover-account 第一版只支持抖音账号主页。");

  const runner = input.commandRunner ?? defaultRunner;
  const builtinCommand = [
    resolveDiscoveryPython(),
    join(import.meta.dir, "..", "scripts", "adapters", "douyin_account_discover.py"),
    input.accountUrl,
    "--timeout-ms",
    timeoutMs(),
  ];
  const attempts: Record<string, unknown>[] = [];
  let best: AccountDiscoveryResult | null = null;
  try {
    best = await runDiscoveryCommand(runner, builtinCommand, input.workspaceDir);
    attempts.push({ adapter: "douyin-account-discover", status: best ? best.status : "failed" });
  } catch (error) {
    attempts.push({ adapter: "douyin-account-discover", status: "failed", message: error instanceof Error ? error.message : String(error) });
  }

  const fallback = process.env.VIDEO_LEARNING_DOUYIN_ACCOUNT_DISCOVER_CMD;
  if (best?.status !== "success" && fallback) {
    const fallbackCommand = [...splitCommand(fallback), input.accountUrl];
    try {
      const fallbackResult = await runDiscoveryCommand(runner, fallbackCommand, input.workspaceDir);
      attempts.push({ adapter: "douyin-account-discover-wrapper", status: fallbackResult ? fallbackResult.status : "failed" });
      best = chooseBetter(best, fallbackResult);
    } catch (error) {
      attempts.push({ adapter: "douyin-account-discover-wrapper", status: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  }

  const result = best ?? failedResult(input, {});
  return {
    ...result,
    platform: "douyin",
    accountUrl: result.accountUrl || input.accountUrl,
    diagnostics: {
      ...result.diagnostics,
      attempts,
    },
  };
}
