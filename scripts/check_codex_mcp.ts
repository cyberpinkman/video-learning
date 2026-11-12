import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const configPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
const config = Bun.TOML.parse(readFileSync(configPath, "utf8")) as {
  mcp_servers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; enabled?: boolean }>;
};
const server = config.mcp_servers?.["video-learning"];
if (!server?.command) throw new Error("video-learning is not installed. Run bun run mcp:install first.");
if (server.enabled === false) throw new Error("video-learning is disabled in the Codex configuration.");

const client = new Client({ name: "video-learning-install-check", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: server.command,
  args: server.args,
  env: server.env,
  // Start outside the repository to exercise the installed cross-project command.
  cwd: server.cwd ?? tmpdir(),
  stderr: "pipe",
});
const deadline = setTimeout(() => {
  console.error("MCP verification timed out during local startup or read-only checks.");
  process.exit(1);
}, 30000);

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const status = CallToolResultSchema.parse(await client.callTool({ name: "get_video_learning_status", arguments: {} }));
  const search = CallToolResultSchema.parse(await client.callTool({ name: "search_video_memory", arguments: { query: "" } }));
  if (status.isError || search.isError) throw new Error("The server connected but a read-only verification failed.");
  const results = search.structuredContent?.results;
  if (!Array.isArray(results)) throw new Error("Search did not return a video list.");
  console.log(JSON.stringify({
    server: "video-learning",
    protocol_verified: true,
    tool_count: tools.length,
    tools: tools.map(tool => tool.name),
    status: status.structuredContent,
    searchable_videos: results.length,
    scope: "Verified local startup and shared library reads; no downloads, cloud calls or analysis were performed.",
  }, null, 2));
} finally {
  clearTimeout(deadline);
  await client.close();
}
