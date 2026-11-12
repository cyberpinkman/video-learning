import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

const projectRoot = resolve(import.meta.dir, "..");
let workdir = "";
const clients: Client[] = [];

function payload(result: Awaited<ReturnType<Client["callTool"]>>) {
  return CallToolResultSchema.parse(result).structuredContent;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  workdir = "";
});

async function connect(environment: Record<string, string> = {}) {
  if (!workdir) workdir = mkdtempSync(join(tmpdir(), "video-learning-mcp-"));
  const callerDir = join(workdir, `caller project ${clients.length}`);
  mkdirSync(callerDir);
  // An unrelated project's dotenv must not configure the shared MCP server.
  writeFileSync(join(callerDir, ".env"), "VIDEO_LEARNING_GLM_MODEL=wrong-caller-model\n");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", "--no-env-file", "--cwd", projectRoot, join(projectRoot, "src/cli.ts"), "mcp", "--workspace", join(workdir, "library"), "--db", join(workdir, "library/video-learning.sqlite")],
    cwd: callerDir,
    env: {
      PATH: process.env.PATH ?? "",
      VIDEO_LEARNING_STT_ENGINE: "off",
      VIDEO_LEARNING_TEXT_PROVIDER: "off",
      VIDEO_LEARNING_VISION_PROVIDER: "off",
      ...environment,
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", data => { stderr += data.toString(); });
  const client = new Client({ name: "video-learning-contract-test", version: "1.0.0" });
  clients.push(client);
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`MCP startup failed: ${stderr}`, { cause: error });
  }
  return client;
}

test("stdio clients in different projects share evidence and can export a report", async () => {
  const first = await connect();
  const listed = await first.listTools();
  expect(listed.tools).toHaveLength(14);
  expect(first.getInstructions()).toContain("absolute paths");
  const status = await first.callTool({ name: "get_video_learning_status", arguments: {} });
  expect(payload(status)?.workspace_dir).toBe(join(workdir, "library"));
  expect(payload(status)?.video_count).toBe(0);
  expect(payload(status)?.project_root).toBe(projectRoot);
  expect(payload(status)?.cli_path).toBe(join(projectRoot, "src/cli.ts"));
  expect(payload(status)?.acquisition_diagnostics_version).toBe(1);

  const source = join(workdir, "source.mp4");
  const media = Bun.spawn({
    cmd: ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x90:d=2", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "2", "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", source],
    stdout: "pipe", stderr: "pipe",
  });
  await new Response(media.stderr).text();
  expect(await media.exited).toBe(0);
  writeFileSync(join(workdir, "source.srt"), "1\n00:00:00,000 --> 00:00:01,800\n用真实字幕说明一个具体观点。\n");
  const imported = await first.callTool({ name: "ingest_video_file", arguments: { path: source } });
  expect(imported.isError).not.toBe(true);
  const videoId = payload(imported)?.video_id as string;
  expect(videoId).toStartWith("vid_");
  await first.close();

  const second = await connect();
  const search = await second.callTool({ name: "search_video_memory", arguments: { query: "source" } });
  expect(payload(search)?.results).toMatchObject([{ video_id: videoId }]);
  const analysis = await second.callTool({ name: "content_analyze_single", arguments: { video_id: videoId } });
  expect(analysis.isError).not.toBe(true);
  expect(payload(analysis)?.status).toBe("content_analyzed");
  const outputPath = join(workdir, "caller project 1", "reports", "transcript.md");
  const report = await second.callTool({ name: "get_content_analyze_single_report", arguments: { video_id: videoId, format: "transcript", output_path: outputPath } });
  expect(report.isError).not.toBe(true);
  expect(payload(report)?.path).toBe(outputPath);
  expect(payload(report)?.report).toBeUndefined();
  expect(readFileSync(outputPath, "utf8")).toContain("用真实字幕说明一个具体观点");
}, 30000);

test("MCP rejects ambiguous paths and reports acquisition and handler failures", async () => {
  const client = await connect();
  const relative = await client.callTool({ name: "ingest_video_file", arguments: { path: "clip.mp4" } });
  expect(relative.isError).toBe(true);
  expect(JSON.stringify(relative.content)).toContain("absolute filesystem path");
  // Local has no URL adapter, so this deterministically fails without network access.
  const failed = await client.callTool({ name: "acquire_video", arguments: { url: "https://example.invalid/video", platform: "local" } });
  expect(payload(failed)?.status).toBe("failed");
  expect(failed.isError).toBe(true);
  const missing = await client.callTool({ name: "get_content_analyze_single_report", arguments: { video_id: "missing" } });
  expect(missing.isError).toBe(true);
  const alive = await client.callTool({ name: "get_video_learning_status", arguments: {} });
  expect(alive.isError).not.toBe(true);
});

test.skipIf(process.env.VIDEO_LEARNING_RUN_BROWSER_TESTS !== "1")("browser failure evidence crosses subprocess, MCP and SQLite boundaries", async () => {
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
    "<html><head><title>Empty media fixture</title></head><body><button>登录</button></body></html>",
    { headers: { "Content-Type": "text/html" } },
  ) });
  try {
    const client = await connect({
      VIDEO_LEARNING_BROWSER_PROFILE_DIR: "", VIDEO_LEARNING_DOUYIN_BROWSER_PROFILE_DIR: "",
      VIDEO_LEARNING_BROWSER_PROXY: "", VIDEO_LEARNING_UNKNOWN_PROXY: "", VIDEO_LEARNING_DOUYIN_PROXY: "",
      VIDEO_LEARNING_BROWSER_READY_TIMEOUT_MS: "1000", VIDEO_LEARNING_BROWSER_DEBUG_DIR: "",
      VIDEO_LEARNING_BROWSER_HEADFUL: "0",
      VIDEO_LEARNING_DOUYIN_API_CMD: "", VIDEO_LEARNING_MEDIACRAWLER_CMD: "",
    });
    const result = await client.callTool({ name: "acquire_video", arguments: {
      url: `http://127.0.0.1:${fixture.port}/video/123?token=fixture-secret`, platform: "douyin",
    } });
    expect(result.isError).toBe(true);
    const attempts = payload(result)?.attempts as Array<Record<string, any>>;
    expect(attempts[0]?.error).toMatchObject({ code: "no_media_candidates", phase: "media_readiness", retryable: false });
    const diagnostic = JSON.parse(readFileSync(attempts[0]!.error.diagnostics_path, "utf8"));
    expect(diagnostic.navigation_attempts).toBe(1);
    expect(diagnostic.blocking_evidence).toEqual([]);
    expect(JSON.stringify(diagnostic)).not.toContain("fixture-secret");
    const db = new Database(join(workdir, "library/video-learning.sqlite"), { readonly: true });
    try {
      const row = db.query("SELECT message FROM acquisition_attempts WHERE status = 'failed'").get() as { message: string };
      expect(JSON.parse(row.message).error.diagnostics_path).toBe(attempts[0]!.error.diagnostics_path);
    } finally { db.close(); }
  } finally { fixture.stop(true); }
}, 20000);
