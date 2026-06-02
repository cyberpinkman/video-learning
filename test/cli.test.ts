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
    env: {
      ...process.env,
      VIDEO_LEARNING_TEXT_PROVIDER: "off",
    },
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

test("deep-report-single refuses to create an empty database when the db path is missing", async () => {
  const missingDb = join(workdir, "missing.sqlite");

  const result = await runCli(["deep-report-single", "vid_missing", "--db", missingDb, "--workspace", workdir]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Refusing to create an empty database");
  expect(existsSync(missingDb)).toBe(false);
});

test("deep-report-single can write markdown to a stable output path", async () => {
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

  const result = await runCli(["deep-report-single", videoId, "--db", dbPath, "--workspace", workdir, "--format", "full", "--out", outPath]);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).path).toBe(outPath);
  expect(readFileSync(outPath, "utf8")).toContain("# 稳定报告视频");
});

test("content-report-single can write transcript-only markdown", async () => {
  const dbPath = join(workdir, "video-learning.sqlite");
  const outPath = join(workdir, "reports", "target-transcript.md");
  const store = new VideoLearningStore({ dbPath });
  const videoId = store.createVideoRecord({
    platform: "local",
    sourceUrl: null,
    title: "内容视频",
    author: "creator",
    publishedAt: null,
    durationSec: 10,
    contentHash: "content-report-hash",
    status: "analyzed",
  });
  store.replaceTranscript(videoId, [
    { startSec: 0, endSec: 2, speaker: "S1", text: "先讲用户痛点，再给解决路径", wordsPerMinute: 240, keywords: ["痛点", "路径"] },
  ]);
  store.saveContentAnalysis(videoId, {
    provider: "local",
    model: "fallback",
    transcriptHash: "hash",
    contentJson: {
      topic: "内容分析",
      audience: "创作者",
      hook: "先讲用户痛点",
      structure: [{ startSec: 0, endSec: 2, summary: "开场痛点", evidence: "00:00-00:02" }],
      arguments: ["给出解决路径"],
      quotes: ["先讲用户痛点，再给解决路径"],
      keywords: ["痛点", "路径"],
      reusableFramework: "痛点-路径",
      risks: ["机器转写需复核"],
      confidence: "low",
      evidenceNotes: ["仅基于转写"],
    },
  });

  const result = await runCli(["content-report-single", videoId, "--db", dbPath, "--workspace", workdir, "--format", "transcript", "--out", outPath]);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).path).toBe(outPath);
  expect(readFileSync(outPath, "utf8")).toContain("## 逐段转写");
  expect(readFileSync(outPath, "utf8")).toContain("[00:00.000-00:02.000]");
});

test("content-analyze-account and content-report-account write a stable account report", async () => {
  const dbPath = join(workdir, "video-learning.sqlite");
  const outPath = join(workdir, "reports", "account-full.md");
  const store = new VideoLearningStore({ dbPath });
  const first = store.createVideoRecord({
    platform: "douyin",
    sourceUrl: null,
    title: "账号第一条",
    author: "账号作者",
    publishedAt: null,
    durationSec: 10,
    contentHash: "account-cli-1",
    status: "analyzed",
  });
  const second = store.createVideoRecord({
    platform: "douyin",
    sourceUrl: null,
    title: "账号第二条",
    author: "账号作者",
    publishedAt: null,
    durationSec: 12,
    contentHash: "account-cli-2",
    status: "analyzed",
  });
  for (const [videoId, title] of [[first, "账号第一条"], [second, "账号第二条"]] as const) {
    store.replaceTranscript(videoId, [
      { startSec: 0, endSec: 2, speaker: "S1", text: `${title} 先讲选题痛点`, wordsPerMinute: 200, keywords: ["选题", "痛点"] },
    ]);
    store.saveContentAnalysis(videoId, {
      provider: "local",
      model: "fallback",
      transcriptHash: `${videoId}-hash`,
      contentJson: {
        topic: `${title}选题`,
        audience: "新手创作者",
        hook: "先讲痛点",
        structure: [{ startSec: 0, endSec: 2, summary: "痛点开场", evidence: "[00:00.000-00:02.000]" }],
        arguments: ["给出解决路径"],
        quotes: [`${title} 先讲选题痛点`],
        keywords: ["选题", "痛点"],
        reusableFramework: "痛点-方法",
        risks: ["机器转写需复核"],
        confidence: "low",
        evidenceNotes: ["仅基于转写"],
      },
    });
  }

  const analyze = await runCli(["content-analyze-account", first, second, "--db", dbPath, "--workspace", workdir]);
  expect(analyze.exitCode).toBe(0);
  const accountAnalysisId = JSON.parse(analyze.stdout).account_analysis_id;

  const report = await runCli(["content-report-account", accountAnalysisId, "--db", dbPath, "--workspace", workdir, "--format", "full", "--out", outPath]);

  expect(report.exitCode).toBe(0);
  expect(JSON.parse(report.stdout).path).toBe(outPath);
  expect(readFileSync(outPath, "utf8")).toContain("## 账号定位");
  expect(readFileSync(outPath, "utf8")).toContain("## 内容支柱");
});
