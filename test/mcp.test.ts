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

test("status identifies the runtime and acquisition diagnostics contract", async () => {
  const client = await connect();
  const result = payload(await client.callTool({ name: "get_video_learning_status", arguments: {} }));
  expect(result?.project_root).toBe(projectRoot);
  expect(result?.cli_path).toBe(join(projectRoot, "src/cli.ts"));
  expect(result?.workspace_dir).toBe(join(workdir, "library"));
  expect(result?.db_path).toBe(join(workdir, "library/video-learning.sqlite"));
  expect(result?.acquisition_diagnostics_version).toBe(1);
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
