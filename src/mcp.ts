import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { createStore } from "./config.ts";
import { createToolHandlers } from "./tools.ts";

function asStructuredObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

function toolResult(value: unknown) {
  const structuredContent = asStructuredObject(value);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

export async function runMcpServer(args: { dbPath?: string; workspaceDir?: string } = {}): Promise<void> {
  const { store, config } = createStore({ dbPath: args.dbPath, workspaceDir: args.workspaceDir });
  const handlers = createToolHandlers({ store, workspaceDir: config.workspaceDir });
  const server = new McpServer({ name: "video-learning", version: "0.1.0" });

  server.registerTool("acquire_video", {
    description: "Acquire a video from a supported platform URL using adapter fallback, then store it locally.",
    inputSchema: {
      url: z.string().url(),
      platform: z.enum(["douyin", "wechat_channels", "xiaohongshu", "tiktok", "youtube", "local", "unknown"]).optional(),
      strategy: z.string().optional(),
    },
  }, async input => toolResult(await handlers.acquire_video(input)));

  server.registerTool("ingest_video_file", {
    description: "Import a local video or authorized screen recording into the local video-learning database.",
    inputSchema: {
      path: z.string(),
      platform: z.enum(["douyin", "wechat_channels", "xiaohongshu", "tiktok", "youtube", "local", "unknown"]).optional(),
      source_url: z.string().optional(),
    },
  }, async input => toolResult(await handlers.ingest_video_file(input)));

  server.registerTool("deep_analyze_single", {
    description: "Run single-video deep analysis: local video processing, shot evidence, and optional cloud vision enrichment.",
    inputSchema: {
      video_id: z.string(),
      depth: z.enum(["standard", "deep"]).optional(),
    },
  }, async input => toolResult(await handlers.deep_analyze_single(input)));

  server.registerTool("get_deep_analyze_single_report", {
    description: "Return a timestamped deep single-video report, shooting brief, shot list, or edit brief.",
    inputSchema: {
      video_id: z.string(),
      format: z.enum(["full", "shooting_brief", "shot_list", "edit_brief"]).optional(),
    },
  }, async input => toolResult(await handlers.get_deep_analyze_single_report(input)));

  server.registerTool("content_analyze_single", {
    description: "Analyze a single video only from speech transcript or subtitle evidence, without shot or vision analysis.",
    inputSchema: {
      video_id: z.string(),
    },
  }, async input => toolResult(await handlers.content_analyze_single(input)));

  server.registerTool("get_content_analyze_single_report", {
    description: "Return a single-video content analysis report, brief, or transcript-only report.",
    inputSchema: {
      video_id: z.string(),
      format: z.enum(["full", "brief", "transcript"]).optional(),
    },
  }, async input => toolResult(await handlers.get_content_analyze_single_report(input)));

  server.registerTool("compare_videos", {
    description: "Compare a target video with reference videos for reusable structure and shooting patterns.",
    inputSchema: {
      target_id: z.string(),
      reference_ids: z.array(z.string()),
    },
  }, async input => toolResult(await handlers.compare_videos(input)));

  server.registerTool("search_video_memory", {
    description: "Search the local video-learning memory by title, author, and platform.",
    inputSchema: {
      query: z.string(),
      filters: z.object({
        platform: z.enum(["douyin", "wechat_channels", "xiaohongshu", "tiktok", "youtube", "local", "unknown"]).optional(),
      }).optional(),
    },
  }, async input => toolResult(await handlers.search_video_memory(input)));

  server.registerTool("make_recreation_plan", {
    description: "Generate and persist a concrete recreation plan for a video.",
    inputSchema: {
      video_id: z.string(),
      constraints: z.record(z.string(), z.unknown()).optional(),
    },
  }, async input => toolResult(await handlers.make_recreation_plan(input)));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
