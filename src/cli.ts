#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createStore, resolveRuntimeConfig } from "./config.ts";
import { runMcpServer } from "./mcp.ts";
import { createToolHandlers } from "./tools.ts";
import { listAdapterStatuses } from "./adapters.ts";
import type { ContentReportFormat, Platform, ReportFormat } from "./types.ts";

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2).replaceAll("-", "_");
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command, positionals, flags };
}

function usage(): string {
  return `video-learning

Commands:
  acquire <url> [--platform youtube|douyin|wechat_channels|xiaohongshu|tiktok] [--strategy normal|strong]
  ingest <path> [--platform local] [--source-url <url>]
  deep-analyze-single <video_id> [--depth standard|deep] [--stub]
  deep-report-single <video_id> [--format full|shooting_brief|shot_list|edit_brief] [--out <path>]
  content-analyze-single <video_id>
  content-report-single <video_id> [--format full|brief|transcript] [--out <path>]
  search <query> [--platform <platform>]
  adapters
  mcp

Global flags:
  --db <path>          SQLite database path
  --workspace <path>   Workspace for downloads/artifacts
`;
}

function globalConfig(flags: Record<string, string | boolean>) {
  return {
    dbPath: typeof flags.db === "string" ? flags.db : undefined,
    workspaceDir: typeof flags.workspace === "string" ? flags.workspace : undefined,
  };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function ensureReadableDatabase(command: string, flags: Record<string, string | boolean>): void {
  if (command !== "deep-report-single" && command !== "content-report-single") return;
  const config = resolveRuntimeConfig(globalConfig(flags));
  if (!existsSync(config.dbPath)) {
    throw new Error(`Database not found: ${config.dbPath}. Refusing to create an empty database for report output.`);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") {
    console.log(usage());
    return;
  }

  if (parsed.command === "mcp") {
    await runMcpServer(globalConfig(parsed.flags));
    return;
  }

  ensureReadableDatabase(parsed.command, parsed.flags);
  const { store, config } = createStore(globalConfig(parsed.flags));
  const tools = createToolHandlers({
    store,
    workspaceDir: config.workspaceDir,
    allowStubProcessing: Boolean(parsed.flags.stub),
  });

  switch (parsed.command) {
    case "acquire": {
      const url = parsed.positionals[0];
      if (!url) throw new Error("Usage: video-learning acquire <url>");
      printJson(await tools.acquire_video({
        url,
        platform: parsed.flags.platform as Platform | undefined,
        strategy: typeof parsed.flags.strategy === "string" ? parsed.flags.strategy : undefined,
      }));
      break;
    }
    case "ingest": {
      const path = parsed.positionals[0];
      if (!path) throw new Error("Usage: video-learning ingest <path>");
      printJson(await tools.ingest_video_file({
        path,
        platform: parsed.flags.platform as Platform | undefined,
        source_url: typeof parsed.flags.source_url === "string" ? parsed.flags.source_url : null,
      }));
      break;
    }
    case "deep-analyze-single": {
      const videoId = parsed.positionals[0];
      if (!videoId) throw new Error("Usage: video-learning deep-analyze-single <video_id>");
      printJson(await tools.deep_analyze_single({
        video_id: videoId,
        depth: parsed.flags.depth === "deep" ? "deep" : "standard",
      }));
      break;
    }
    case "deep-report-single": {
      const videoId = parsed.positionals[0];
      if (!videoId) throw new Error("Usage: video-learning deep-report-single <video_id>");
      const result = await tools.get_deep_analyze_single_report({
        video_id: videoId,
        format: (parsed.flags.format as ReportFormat | undefined) ?? "full",
      });
      if (typeof parsed.flags.out === "string") {
        const outPath = resolve(parsed.flags.out);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, result.report);
        printJson({ video_id: videoId, format: result.format, path: outPath });
        break;
      }
      console.log(result.report);
      break;
    }
    case "content-analyze-single": {
      const videoId = parsed.positionals[0];
      if (!videoId) throw new Error("Usage: video-learning content-analyze-single <video_id>");
      printJson(await tools.content_analyze_single({ video_id: videoId }));
      break;
    }
    case "content-report-single": {
      const videoId = parsed.positionals[0];
      if (!videoId) throw new Error("Usage: video-learning content-report-single <video_id>");
      const result = await tools.get_content_analyze_single_report({
        video_id: videoId,
        format: (parsed.flags.format as ContentReportFormat | undefined) ?? "full",
      });
      if (typeof parsed.flags.out === "string") {
        const outPath = resolve(parsed.flags.out);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, result.report);
        printJson({ video_id: videoId, format: result.format, path: outPath });
        break;
      }
      console.log(result.report);
      break;
    }
    case "search": {
      const query = parsed.positionals.join(" ");
      if (!query) throw new Error("Usage: video-learning search <query>");
      printJson(await tools.search_video_memory({
        query,
        filters: typeof parsed.flags.platform === "string" ? { platform: parsed.flags.platform as Platform } : undefined,
      }));
      break;
    }
    case "adapters": {
      printJson(listAdapterStatuses());
      break;
    }
    default:
      console.log(usage());
      process.exitCode = 2;
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
