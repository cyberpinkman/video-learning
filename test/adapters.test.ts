import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAdapterCommand, listAdapterStatuses } from "../src/adapters.ts";

let tempRoot: string | null = null;

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

test("adapter registry exposes default yt-dlp and configured platform adapters", () => {
  const statuses = listAdapterStatuses({
    env: {
      VIDEO_LEARNING_DOUYIN_API_CMD: ".venv/bin/python scripts/adapters/douyin_tiktok_scraper.py",
    },
    pathLookup: command => command === "yt-dlp" ? "/usr/local/bin/yt-dlp" : null,
  });

  expect(statuses.find(status => status.name === "yt-dlp")?.available).toBe(true);
  expect(statuses.find(status => status.name === "douyin-tiktok-download-api")?.available).toBe(true);
  expect(statuses.find(status => status.name === "mediacrawler")?.available).toBe(false);
});

test("configured adapter command parsing preserves quoted arguments", () => {
  const command = buildAdapterCommand("douyin-tiktok-download-api", {
    env: {
      VIDEO_LEARNING_DOUYIN_API_CMD: `python3 scripts/adapter.py --profile "main account"`,
    },
    pathLookup: () => null,
  });

  expect(command).toEqual(["python3", "scripts/adapter.py", "--profile", "main account"]);
});

test("unconfigured platform adapters return null instead of fake commands", () => {
  const command = buildAdapterCommand("wx_channels_download", {
    env: {},
    pathLookup: () => null,
  });

  expect(command).toBeNull();
});

test("default adapters can resolve tools from a project-local virtualenv", () => {
  tempRoot = join(tmpdir(), `video-learning-adapters-${Date.now()}`);
  const binDir = join(tempRoot, ".venv", "bin");
  mkdirSync(binDir, { recursive: true });
  const localYtDlp = join(binDir, "yt-dlp");
  Bun.write(localYtDlp, "#!/usr/bin/env sh\nexit 0\n");
  chmodSync(localYtDlp, 0o755);

  const command = buildAdapterCommand("yt-dlp", {
    env: {},
    pathLookup: () => null,
    projectRoot: tempRoot,
  });

  expect(command?.[0]).toBe(localYtDlp);
});

test("configured adapter commands normalize project-relative paths", () => {
  tempRoot = join(tmpdir(), `video-learning-adapters-${Date.now()}`);
  mkdirSync(join(tempRoot, ".venv", "bin"), { recursive: true });
  mkdirSync(join(tempRoot, "scripts", "adapters"), { recursive: true });
  const pythonPath = join(tempRoot, ".venv", "bin", "python");
  const scriptPath = join(tempRoot, "scripts", "adapters", "douyin.py");
  Bun.write(pythonPath, "#!/usr/bin/env sh\nexit 0\n");
  Bun.write(scriptPath, "print('ok')\n");

  const command = buildAdapterCommand("douyin-tiktok-download-api", {
    env: {
      VIDEO_LEARNING_DOUYIN_API_CMD: `.venv/bin/python scripts/adapters/douyin.py --profile "main account"`,
    },
    pathLookup: () => null,
    projectRoot: tempRoot,
  });

  expect(command).toEqual([pythonPath, scriptPath, "--profile", "main account"]);
});

test("default adapter commands normalize project-local interpreter and script paths", () => {
  tempRoot = join(tmpdir(), `video-learning-adapters-${Date.now()}`);
  const binDir = join(tempRoot, ".venv", "bin");
  const adaptersDir = join(tempRoot, "scripts", "adapters");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(adaptersDir, { recursive: true });
  const pythonPath = join(binDir, "python");
  const scriptPath = join(adaptersDir, "browser_media_download.py");
  Bun.write(pythonPath, "#!/usr/bin/env sh\nexit 0\n");
  Bun.write(scriptPath, "print('ok')\n");

  const command = buildAdapterCommand("playwright-media-sniffer", {
    env: {},
    pathLookup: () => null,
    projectRoot: tempRoot,
  });

  expect(command).toEqual([pythonPath, scriptPath]);
});
