import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAccountVideos, parseAccountDiscoveryStdout } from "../src/account-discovery.ts";
import { VideoLearningStore } from "../src/storage.ts";
import { createToolHandlers } from "../src/tools.ts";

let workdir = "";

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "video-learning-account-discovery-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function discoveryPayload(count: number, expectedCount = count) {
  return {
    platform: "douyin",
    accountUrl: "https://www.douyin.com/user/sec_user_id",
    accountId: "sec_user_id",
    author: "账号作者",
    expectedCount,
    items: Array.from({ length: count }, (_, index) => ({
      platformVideoId: `70000000000000000${String(index).padStart(2, "0")}`,
      url: `https://www.douyin.com/video/70000000000000000${String(index).padStart(2, "0")}`,
      type: "video",
      description: `第 ${index + 1} 条作品`,
      author: "账号作者",
      publishedAt: "2026-06-01T00:00:00.000Z",
      durationSec: 60 + index,
    })),
    diagnostics: { source: "test-wrapper" },
  };
}

test("account discovery stdout parsing normalizes and deduplicates items", () => {
  const payload = discoveryPayload(2);
  payload.items.push({ ...payload.items[0], description: "重复作品" });

  const parsed = parseAccountDiscoveryStdout(`log line\n${JSON.stringify(payload)}\n`);

  expect(parsed.status).toBe("success");
  expect(parsed.expectedCount).toBe(2);
  expect(parsed.discoveredCount).toBe(2);
  expect(parsed.items.map(item => item.platformVideoId)).toEqual([
    "7000000000000000000",
    "7000000000000000001",
  ]);
});

test("discoverAccountVideos returns success when discovered count matches account works count", async () => {
  const result = await discoverAccountVideos({
    accountUrl: "https://v.douyin.com/account/",
    platform: "douyin",
    workspaceDir: workdir,
    commandRunner: async command => {
      expect(command.some(part => part.includes("douyin_account_discover.py"))).toBe(true);
      return { exitCode: 0, stdout: JSON.stringify(discoveryPayload(60)), stderr: "" };
    },
  });

  expect(result.status).toBe("success");
  expect(result.expectedCount).toBe(60);
  expect(result.discoveredCount).toBe(60);
  expect(result.items).toHaveLength(60);
});

test("discoverAccountVideos preserves adapter failed status for auth-required discovery", async () => {
  const payload = {
    ...discoveryPayload(0, 60),
    status: "failed",
    diagnostics: { authRequired: true },
  };

  const result = await discoverAccountVideos({
    accountUrl: "https://v.douyin.com/account/",
    platform: "douyin",
    workspaceDir: workdir,
    commandRunner: async () => ({ exitCode: 0, stdout: JSON.stringify(payload), stderr: "" }),
  });

  expect(result.status).toBe("failed");
  expect(result.expectedCount).toBe(60);
  expect(result.discoveredCount).toBe(0);
  expect(result.diagnostics.authRequired).toBe(true);
});

test("content_discover_account saves partial discoveries but fails strict full-count validation", async () => {
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });
  const tools = createToolHandlers({
    store,
    workspaceDir: workdir,
    commandRunner: async () => ({
      exitCode: 0,
      stdout: JSON.stringify(discoveryPayload(21, 60)),
      stderr: "",
    }),
  });

  await expect(tools.content_discover_account({
    account_url: "https://v.douyin.com/account/",
    platform: "douyin",
  })).rejects.toThrow("partial");

  const discoveries = store.listAccountDiscoveries();
  expect(discoveries).toHaveLength(1);
  expect(discoveries[0].status).toBe("partial");
  expect(discoveries[0].expectedCount).toBe(60);
  expect(discoveries[0].discoveredCount).toBe(21);
  expect(store.listVideos()).toHaveLength(0);
});

test("content_discover_account acquires discovered account videos into local assets", async () => {
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });
  const acquiredUrls: string[] = [];
  const tools = createToolHandlers({
    store,
    workspaceDir: workdir,
    commandRunner: async command => {
      if (command.some(part => part.includes("douyin_account_discover.py"))) {
        return { exitCode: 0, stdout: JSON.stringify(discoveryPayload(2)), stderr: "" };
      }
      const url = command.at(-1) ?? "";
      acquiredUrls.push(url);
      const outputPath = join(workdir, `${url.split("/").at(-1)}.mp4`);
      writeFileSync(outputPath, Buffer.from(`video asset for ${url}`));
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          path: outputPath,
          title: `下载-${url.split("/").at(-1)}`,
          author: "账号作者",
          durationSec: 61,
        }),
        stderr: "",
      };
    },
  });

  const result = await tools.content_discover_account({
    account_url: "https://v.douyin.com/account/",
    platform: "douyin",
  });

  expect(acquiredUrls).toEqual([
    "https://www.douyin.com/video/7000000000000000000",
    "https://www.douyin.com/video/7000000000000000001",
  ]);
  expect(result.acquired_count).toBe(2);
  expect(result.asset_failed_count).toBe(0);
  const videoIds = result.video_ids ?? [];
  expect(videoIds).toHaveLength(2);
  expect(store.listVideos()).toHaveLength(2);
  expect(store.listVideos().map(video => video.author)).toEqual(["账号作者", "账号作者"]);
  const discovery = store.listAccountDiscoveries()[0];
  expect(discovery.items.map(item => item.acquiredVideoId)).toEqual(videoIds);
  expect(discovery.diagnostics.assetAcquisition).toMatchObject({
    enabled: true,
    requestedCount: 2,
    acquiredCount: 2,
    failedCount: 0,
  });
});

test("content_discover_account rejects non-Douyin account urls", async () => {
  const store = new VideoLearningStore({ dbPath: join(workdir, "video-learning.sqlite") });
  const tools = createToolHandlers({ store, workspaceDir: workdir });

  await expect(tools.content_discover_account({
    account_url: "https://www.youtube.com/@creator",
    platform: "youtube",
  })).rejects.toThrow("只支持抖音");
});
