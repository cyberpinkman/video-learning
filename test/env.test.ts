import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProjectEnv } from "../src/env.ts";

let tempRoot: string | null = null;

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

test("project env loader reads .env.local without overriding shell env", () => {
  tempRoot = mkdtempSync(join(tmpdir(), "video-learning-env-"));
  writeFileSync(join(tempRoot, ".env"), "DASHSCOPE_API_KEY=from-env\nVIDEO_LEARNING_VISION_MODEL=qwen3.6-plus\n");
  writeFileSync(join(tempRoot, ".env.local"), "DASHSCOPE_API_KEY=from-local\nVIDEO_LEARNING_BROWSER_PROFILE_DIR=/tmp/profile\n");

  const env: Record<string, string | undefined> = {
    VIDEO_LEARNING_VISION_MODEL: "shell-model",
  };
  loadProjectEnv({ projectRoot: tempRoot, env });

  expect(env.DASHSCOPE_API_KEY).toBe("from-local");
  expect(env.VIDEO_LEARNING_BROWSER_PROFILE_DIR).toBe("/tmp/profile");
  expect(env.VIDEO_LEARNING_VISION_MODEL).toBe("shell-model");
});
