import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { VideoLearningStore } from "./storage.ts";
import { adaptersForPlatform, buildAdapterCommand, type AdapterDefinition } from "./adapters.ts";
import { detectPlatform } from "./platform.ts";
import { redactSecrets } from "./redact.ts";
import type { DownloaderMetadata, Platform } from "./types.ts";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string[], options?: { cwd?: string }) => Promise<CommandResult>;

export interface AcquireVideoInput {
  url: string;
  platform?: Platform;
  strategy?: string;
  workspaceDir: string;
  store: VideoLearningStore;
  commandRunner?: CommandRunner;
  adapterCommands?: Record<string, string[]>;
}

const defaultRunner: CommandRunner = async (command, options) => {
  const proc = Bun.spawn({ cmd: command, cwd: options?.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

function parseDownloaderStdout(stdout: string): DownloaderMetadata | null {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of [...lines].reverse()) {
    try {
      const data = JSON.parse(line) as Record<string, any>;
      const requested = Array.isArray(data.requested_downloads) ? data.requested_downloads[0] : null;
      return {
        outputPath: data.filepath ?? data._filename ?? data.path ?? data.file ?? data.output_path ?? data.video_path ?? requested?.filepath ?? requested?.filename ?? null,
        title: data.title ?? null,
        author: data.author ?? data.uploader ?? data.channel ?? data.creator ?? null,
        durationSec: typeof data.durationSec === "number" ? data.durationSec : typeof data.duration === "number" ? data.duration : null,
        publishedAt: data.publishedAt ?? data.published_at ?? (data.upload_date ? String(data.upload_date) : null),
      };
    } catch {
      if (line.endsWith(".mp4") || line.endsWith(".webm") || line.endsWith(".mkv") || line.endsWith(".mov")) {
        return { outputPath: line };
      }
    }
  }
  return null;
}

function ytDlpAdapter(definition: AdapterDefinition): Adapter {
  return {
    name: definition.name,
    usedAccount: false,
    usedProxy: false,
    async run(input, _platform, runner) {
      const downloadsDir = join(input.workspaceDir, "downloads");
      mkdirSync(downloadsDir, { recursive: true });
      const baseCommand = commandForAdapter(input, definition);
      if (!baseCommand) throw new AdapterSkipped(`${definition.name} is not available. ${definition.installHint}.`);
      const command = [
        ...baseCommand,
        "--no-playlist",
        "--no-simulate",
        "--print-json",
        "-o",
        join(downloadsDir, "%(extractor)s-%(id)s.%(ext)s"),
        input.url,
      ];
      const result = await runner(command, { cwd: input.workspaceDir });
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "yt-dlp failed");
      const parsed = parseDownloaderStdout(result.stdout);
      if (!parsed?.outputPath) throw new Error("yt-dlp did not report an output filepath");
      if (!existsSync(parsed.outputPath)) throw new Error(`yt-dlp reported missing output file: ${parsed.outputPath}`);
      return {
        outputPath: parsed.outputPath,
        title: parsed.title,
        author: parsed.author,
        durationSec: parsed.durationSec,
        publishedAt: parsed.publishedAt,
      };
    },
  };
}

interface Adapter {
  name: string;
  usedAccount: boolean;
  usedProxy: boolean;
  run(input: AcquireVideoInput, platform: Platform, runner: CommandRunner): Promise<DownloaderMetadata>;
}

function commandForAdapter(input: AcquireVideoInput, definition: AdapterDefinition): string[] | null {
  const injected = input.adapterCommands?.[definition.name];
  if (injected && injected.length > 0) return injected;
  return buildAdapterCommand(definition.name);
}

function configuredCommandAdapter(definition: AdapterDefinition): Adapter {
  return {
    name: definition.name,
    usedAccount: definition.usedAccount,
    usedProxy: definition.usedProxy,
    async run(input, _platform, runner) {
      const command = commandForAdapter(input, definition);
      if (!command) throw new AdapterSkipped(`${definition.name} is not configured. ${definition.envVar ? `Set ${definition.envVar}` : definition.installHint}.`);
      const result = await runner([...command, input.url], { cwd: input.workspaceDir });
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `${definition.name} failed`);
      const parsed = parseDownloaderStdout(result.stdout);
      if (!parsed?.outputPath) throw new Error(`${definition.name} did not report an output filepath`);
      if (!existsSync(parsed.outputPath)) throw new Error(`${definition.name} reported missing output file: ${parsed.outputPath}`);
      return {
        outputPath: parsed.outputPath,
        title: parsed.title,
        author: parsed.author,
        durationSec: parsed.durationSec,
        publishedAt: parsed.publishedAt,
      };
    },
  };
}

class AdapterSkipped extends Error {
  readonly skipped = true;
}

function adaptersFor(platform: Platform, strategy: string): Adapter[] {
  return adaptersForPlatform(platform, strategy).map(definition => {
    if (definition.name === "yt-dlp") return ytDlpAdapter(definition);
    return configuredCommandAdapter(definition);
  });
}

export async function acquireVideo(input: AcquireVideoInput): Promise<{ video_id: string | null; status: string; attempts: unknown[] }> {
  const platform = input.platform ?? detectPlatform(input.url);
  const strategy = input.strategy ?? "normal";
  const runner = input.commandRunner ?? defaultRunner;
  const attempts: unknown[] = [];

  for (const adapter of adaptersFor(platform, strategy)) {
    try {
      const result = await adapter.run(input, platform, runner);
      const ingested = await input.store.ingestLocalFile({ path: result.outputPath, platform, sourceUrl: input.url });
      input.store.updateVideo(ingested.videoId, {
        title: result.title ?? undefined,
        author: result.author ?? undefined,
        durationSec: result.durationSec ?? undefined,
        publishedAt: result.publishedAt ?? undefined,
        status: "ingested",
      });
      input.store.logAcquisitionAttempt({
        platform,
        sourceUrl: input.url,
        adapter: adapter.name,
        strategy,
        status: "success",
        usedAccount: adapter.usedAccount,
        usedProxy: adapter.usedProxy,
        outputPath: result.outputPath,
        outputHash: ingested.contentHash,
        message: "downloaded",
      });
      attempts.push({ adapter: adapter.name, status: "success" });
      return { video_id: ingested.videoId, status: "success", attempts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const skipped = error instanceof AdapterSkipped;
      input.store.logAcquisitionAttempt({
        platform,
        sourceUrl: input.url,
        adapter: adapter.name,
        strategy,
        status: skipped ? "skipped" : "failed",
        usedAccount: adapter.usedAccount,
        usedProxy: adapter.usedProxy,
        message: redactSecrets(message),
      });
      attempts.push({ adapter: adapter.name, status: skipped ? "skipped" : "failed", message: redactSecrets(message) });
    }
  }
  return { video_id: null, status: "failed", attempts };
}
