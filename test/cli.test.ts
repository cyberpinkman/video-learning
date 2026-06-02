import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VideoLearningStore } from "../src/storage.ts";

let workdir = "";
const projectRoot = join(import.meta.dir, "..");

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "video-learning-cli-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", join(projectRoot, "src", "cli.ts"), ...args],
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

test("report refuses to create an empty database when the db path is missing", async () => {
  const missingDb = join(workdir, "missing.sqlite");

  const result = await runCli(["report", "vid_missing", "--db", missingDb, "--workspace", workdir]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Refusing to create an empty database");
  expect(existsSync(missingDb)).toBe(false);
});

test("report can write markdown to a stable output path", async () => {
  const dbPath = join(workdir, "video-learning.sqlite");
  const outPath = join(workdir, "reports", "target-full.md");
  const store = new VideoLearningStore({ dbPath });
  const videoId = store.createVideoRecord({
    platform: "local",
    sourceUrl: null,
    title: "稳定报告视频",
    author: "creator",
    publishedAt: null,
    durationSec: 10,
    contentHash: "stable-report-hash",
    status: "analyzed",
  });
  store.replaceShots(videoId, [
    { startSec: 0, endSec: 3, visualSummary: "开场镜头", shotSize: "近景", cameraMotion: "固定", composition: "居中", subtitles: "开场", audioRole: "口播", purpose: "hook" },
  ]);

  const result = await runCli(["report", videoId, "--db", dbPath, "--workspace", workdir, "--format", "full", "--out", outPath]);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).path).toBe(outPath);
  expect(readFileSync(outPath, "utf8")).toContain("# 稳定报告视频");
});
