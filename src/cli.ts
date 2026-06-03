#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createStore, resolveRuntimeConfig } from "./config.ts";
import { runMcpServer } from "./mcp.ts";
import { createToolHandlers } from "./tools.ts";
import { listAdapterStatuses } from "./adapters.ts";
import type { AccountContentReportFormat, ContentReportFormat, Platform, ReportFormat } from "./types.ts";

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
  content-discover-account <account_url> [--platform douyin] [--out <path>] [--login] [--profile <path>] [--no-acquire]
  content-discover-account-result <discovery_id> [--out <path>]
  content-analyze-account <video_id...>
  content-report-account <account_analysis_id> [--format full|brief] [--out <path>]
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

function maxStdoutReportBytes(): number {
  const parsed = Number(process.env.VIDEO_LEARNING_CLI_MAX_STDOUT_BYTES ?? process.env.VIDEO_LEARNING_CLI_MAX_STDOUT_CHARS ?? "12000");
  if (!Number.isFinite(parsed) || parsed <= 0) return 12000;
  return Math.floor(parsed);
}

function allowLargeStdout(): boolean {
  return ["1", "true", "yes", "on"].includes((process.env.VIDEO_LEARNING_CLI_ALLOW_LARGE_STDOUT ?? "").trim().toLowerCase());
}

function writeOrPrintReport(input: {
  report: string;
  out: string | boolean | undefined;
  json: Record<string, unknown>;
}): void {
  if (typeof input.out === "string") {
    const outPath = resolve(input.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, input.report);
    printJson({ ...input.json, path: outPath });
    return;
  }
  const reportBytes = Buffer.byteLength(input.report, "utf8");
  const maxBytes = maxStdoutReportBytes();
  if (!allowLargeStdout() && reportBytes > maxBytes) {
    throw new Error(`Report is ${reportBytes} bytes, above stdout safety limit ${maxBytes}. Use --out <path> to write the full report, or set VIDEO_LEARNING_CLI_ALLOW_LARGE_STDOUT=1.`);
  }
  console.log(input.report);
}

function writeJsonFile(input: {
  value: unknown;
  out: string | boolean | undefined;
  summary: Record<string, unknown>;
}): void {
  if (typeof input.out !== "string") {
    printJson(input.summary);
    return;
  }
  const outPath = resolve(input.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(input.value, null, 2));
  printJson({ ...input.summary, path: outPath });
}

function ensureReadableDatabase(command: string, flags: Record<string, string | boolean>): void {
  if (command !== "deep-report-single" && command !== "content-report-single" && command !== "content-report-account" && command !== "content-discover-account-result") return;
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
      writeOrPrintReport({
        report: result.report,
        out: parsed.flags.out,
        json: { video_id: videoId, format: result.format },
      });
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
      writeOrPrintReport({
        report: result.report,
        out: parsed.flags.out,
        json: { video_id: videoId, format: result.format },
      });
      break;
    }
    case "content-discover-account": {
      const accountUrl = parsed.positionals[0];
      if (!accountUrl) throw new Error("Usage: video-learning content-discover-account <account_url>");
      if (parsed.flags.login === true) {
        process.env.VIDEO_LEARNING_DOUYIN_ACCOUNT_DISCOVER_HEADLESS = "0";
      }
      if (typeof parsed.flags.profile === "string") {
        process.env.VIDEO_LEARNING_DOUYIN_BROWSER_PROFILE_DIR = resolve(parsed.flags.profile);
      }
      const result = await tools.content_discover_account({
        account_url: accountUrl,
        platform: (parsed.flags.platform as Platform | undefined) ?? "douyin",
        acquire_assets: parsed.flags.no_acquire !== true,
      });
      const full = typeof parsed.flags.out === "string"
        ? await tools.get_content_discover_account_result({ discovery_id: result.discovery_id, include_items: true })
        : result;
      writeJsonFile({ value: full, out: parsed.flags.out, summary: result });
      break;
    }
    case "content-discover-account-result": {
      const discoveryId = parsed.positionals[0];
      if (!discoveryId) throw new Error("Usage: video-learning content-discover-account-result <discovery_id>");
      const summary = await tools.get_content_discover_account_result({ discovery_id: discoveryId, include_items: false });
      const full = typeof parsed.flags.out === "string"
        ? await tools.get_content_discover_account_result({ discovery_id: discoveryId, include_items: true })
        : summary;
      writeJsonFile({ value: full, out: parsed.flags.out, summary });
      break;
    }
    case "content-analyze-account": {
      const videoIds = parsed.positionals;
      if (videoIds.length === 0) throw new Error("Usage: video-learning content-analyze-account <video_id...>");
      printJson(await tools.content_analyze_account({ video_ids: videoIds }));
      break;
    }
    case "content-report-account": {
      const accountAnalysisId = parsed.positionals[0];
      if (!accountAnalysisId) throw new Error("Usage: video-learning content-report-account <account_analysis_id>");
      const result = await tools.get_content_analyze_account_report({
        account_analysis_id: accountAnalysisId,
        format: (parsed.flags.format as AccountContentReportFormat | undefined) ?? "full",
      });
      writeOrPrintReport({
        report: result.report,
        out: parsed.flags.out,
        json: { account_analysis_id: accountAnalysisId, format: result.format },
      });
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
