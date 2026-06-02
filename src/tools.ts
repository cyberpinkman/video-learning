import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import type { VideoLearningStore } from "./storage.ts";
import { analyzeAccountContent } from "./account-content.ts";
import { generateAccountContentReport } from "./account-content-report.ts";
import { maybeEnrichShotsWithCloud } from "./cloud.ts";
import { analyzeContentFromTranscript } from "./content.ts";
import { generateContentReport } from "./content-report.ts";
import { generateRecreationReport } from "./report.ts";
import type { AccountContentReportFormat, AnalysisDepth, ContentReportFormat, Platform, ProcessingResult, ReportFormat, TranscriptProcessingResult, VideoRecord } from "./types.ts";

export interface ToolContext {
  store: VideoLearningStore;
  workspaceDir: string;
  allowStubProcessing?: boolean;
}

export interface ToolHandlers {
  acquire_video(input: { url: string; platform?: Platform; strategy?: string }): Promise<{ video_id: string | null; status: string; attempts: unknown[] }>;
  ingest_video_file(input: { path: string; platform?: Platform; source_url?: string | null }): Promise<{ video_id: string; created: boolean; content_hash: string }>;
  deep_analyze_single(input: { video_id: string; depth?: AnalysisDepth }): Promise<{ video_id: string; status: string; report_id: string }>;
  get_deep_analyze_single_report(input: { video_id: string; format?: ReportFormat }): Promise<{ video_id: string; format: ReportFormat; report: string }>;
  content_analyze_single(input: { video_id: string }): Promise<{ video_id: string; status: string; analysis_id: string; report_id: string }>;
  get_content_analyze_single_report(input: { video_id: string; format?: ContentReportFormat }): Promise<{ video_id: string; format: ContentReportFormat; report: string }>;
  content_analyze_account(input: { video_ids: string[] }): Promise<{ account_analysis_id: string; status: string; author: string; video_ids: string[]; single_analysis_ids: string[] }>;
  get_content_analyze_account_report(input: { account_analysis_id: string; format?: AccountContentReportFormat }): Promise<{ account_analysis_id: string; format: AccountContentReportFormat; report: string }>;
  compare_videos(input: { target_id: string; reference_ids: string[] }): Promise<{ report: string }>;
  search_video_memory(input: { query: string; filters?: { platform?: Platform } }): Promise<{ results: Array<{ video_id: string; title: string; platform: Platform; status: string }> }>;
  make_recreation_plan(input: { video_id: string; constraints?: Record<string, unknown> }): Promise<{ video_id: string; plan: string; plan_id: string }>;
}

function makeStubProcessingResult(title: string): ProcessingResult {
  return {
    durationSec: 360,
    assets: [],
    shots: [
      {
        startSec: 0,
        endSec: 3,
        visualSummary: `《${title}》开场主镜头，主体直面镜头，字幕用大字给出痛点或结果承诺。`,
        shotSize: "近景",
        cameraMotion: "固定",
        composition: "居中构图",
        subtitles: "先用一句话讲清楚观众为什么要继续看",
        audioRole: "钩子口播",
        purpose: "建立痛点和观看承诺",
      },
      {
        startSec: 3,
        endSec: 12,
        visualSummary: "切到示范或对比素材，用 B-roll 覆盖解释段。",
        shotSize: "中景/特写组合",
        cameraMotion: "轻微推进",
        composition: "主体靠近三分线",
        subtitles: "第一个关键动作",
        audioRole: "解释",
        purpose: "展开第一层信息",
      },
    ],
    transcript: [
      {
        startSec: 0,
        endSec: 3,
        speaker: "S1",
        text: "先用一句话讲清楚观众为什么要继续看",
        wordsPerMinute: 180,
        keywords: ["hook", "痛点", "承诺"],
      },
    ],
  };
}

export function resolveWorkerPython(args: { projectRoot?: string; env?: Record<string, string | undefined> } = {}): string {
  const env = args.env ?? process.env;
  if (env.VIDEO_LEARNING_PYTHON) return env.VIDEO_LEARNING_PYTHON;
  const projectRoot = args.projectRoot ?? join(import.meta.dir, "..");
  const localPython = join(projectRoot, ".venv", "bin", "python");
  return existsSync(localPython) ? localPython : "python3";
}

async function processWithWorker(videoId: string, videoPath: string, workspaceDir: string, depth: AnalysisDepth = "standard"): Promise<ProcessingResult> {
  const maxShots = depth === "deep" ? "240" : "120";
  const proc = Bun.spawn({
    cmd: [resolveWorkerPython(), join(import.meta.dir, "..", "scripts", "video_worker.py"), "analyze", videoPath, "--out-dir", join(workspaceDir, "artifacts", videoId), "--max-shots", maxShots],
    env: {
      ...process.env,
      VIDEO_LEARNING_STT_ENGINE: process.env.VIDEO_LEARNING_STT_ENGINE ?? "faster-whisper",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`video worker failed: ${stderr || stdout}`);
  }
  return JSON.parse(stdout) as ProcessingResult;
}

async function transcribeWithWorker(videoId: string, videoPath: string, workspaceDir: string): Promise<TranscriptProcessingResult> {
  const proc = Bun.spawn({
    cmd: [resolveWorkerPython(), join(import.meta.dir, "..", "scripts", "video_worker.py"), "transcribe", videoPath, "--out-dir", join(workspaceDir, "artifacts", videoId, "content")],
    env: {
      ...process.env,
      VIDEO_LEARNING_STT_ENGINE: process.env.VIDEO_LEARNING_STT_ENGINE ?? "faster-whisper",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`video worker transcribe failed: ${stderr || stdout}`);
  }
  return JSON.parse(stdout) as TranscriptProcessingResult;
}

function originalVideoPath(store: VideoLearningStore, videoId: string): string | null {
  return store.listAssets(videoId).find(asset => asset.kind === "original_video" || asset.kind === "screen_recording")?.path ?? null;
}

function existingTranscriptProcessing(store: VideoLearningStore, videoId: string, durationSec: number | null): TranscriptProcessingResult | null {
  const transcript = store.listTranscript(videoId);
  if (transcript.length === 0) return null;
  return {
    durationSec: durationSec ?? Math.max(...transcript.map(segment => segment.endSec), 0),
    assets: [],
    transcript: transcript.map(segment => ({
      startSec: segment.startSec,
      endSec: segment.endSec,
      speaker: segment.speaker,
      text: segment.text,
      wordsPerMinute: segment.wordsPerMinute,
      keywords: segment.keywords,
    })),
  };
}

function requireSameAuthor(videos: VideoRecord[]): string {
  if (videos.length === 0) throw new Error("至少需要 1 个 video_id。");
  const author = videos[0].author?.trim();
  if (!author) throw new Error(`视频 ${videos[0].id} 作者为空，无法进行账号级内容分析。`);
  for (const video of videos) {
    const current = video.author?.trim();
    if (!current) throw new Error(`视频 ${video.id} 作者为空，无法进行账号级内容分析。`);
    if (current !== author) throw new Error(`作者不一致：${author} 与 ${current}。`);
  }
  return author;
}

function transcriptEvidence(store: VideoLearningStore, videoId: string) {
  return store.listTranscript(videoId).filter(segment => segment.text.trim().length > 0);
}

export function createToolHandlers(ctx: ToolContext): ToolHandlers {
  const { store } = ctx;

  return {
    async acquire_video(input) {
      const { acquireVideo } = await import("./acquisition.ts");
      const result = await acquireVideo({
        url: input.url,
        platform: input.platform,
        strategy: input.strategy,
        workspaceDir: ctx.workspaceDir,
        store,
      });
      return result;
    },

    async ingest_video_file(input) {
      if (!existsSync(input.path)) throw new Error(`File not found: ${input.path}`);
      const result = await store.ingestLocalFile({
        path: input.path,
        platform: input.platform ?? "local",
        sourceUrl: input.source_url ?? null,
      });
      return { video_id: result.videoId, created: result.created, content_hash: result.contentHash };
    },

    async deep_analyze_single(input) {
      const video = store.getVideo(input.video_id);
      if (!video) throw new Error(`Video not found: ${input.video_id}`);
      const videoPath = originalVideoPath(store, input.video_id);
      const processing = ctx.allowStubProcessing || !videoPath
        ? makeStubProcessingResult(video.title || basename(videoPath ?? "video"))
        : await processWithWorker(input.video_id, videoPath, ctx.workspaceDir, input.depth ?? "standard");

      for (const asset of processing.assets) {
        store.addAsset(input.video_id, {
          kind: asset.kind,
          path: asset.path,
          mimeType: asset.mimeType ?? null,
          contentHash: asset.contentHash ?? null,
          metadata: asset.metadata ?? {},
        });
      }
      const enrichedShots = ctx.allowStubProcessing ? processing.shots : await maybeEnrichShotsWithCloud(processing.shots);
      store.replaceShots(input.video_id, enrichedShots);
      store.replaceTranscript(input.video_id, processing.transcript);
      store.updateVideo(input.video_id, { durationSec: processing.durationSec, status: "analyzed" });
      const report = generateRecreationReport(store, input.video_id, "full");
      const reportId = store.saveAnalysisReport(input.video_id, "full", report);
      return { video_id: input.video_id, status: "analyzed", report_id: reportId };
    },

    async get_deep_analyze_single_report(input) {
      const format = input.format ?? "full";
      const report = generateRecreationReport(store, input.video_id, format);
      store.saveAnalysisReport(input.video_id, format, report);
      return { video_id: input.video_id, format, report };
    },

    async content_analyze_single(input) {
      const video = store.getVideo(input.video_id);
      if (!video) throw new Error(`Video not found: ${input.video_id}`);
      const videoPath = originalVideoPath(store, input.video_id);
      const processing = ctx.allowStubProcessing
        ? {
            durationSec: video.durationSec ?? 0,
            assets: [],
            transcript: [{
              startSec: 0,
              endSec: Math.min(video.durationSec ?? 3, 3),
              speaker: "S1",
              text: "内容分析需要可转写音频或字幕证据",
              wordsPerMinute: 0,
              keywords: ["内容分析"],
            }],
          } satisfies TranscriptProcessingResult
        : videoPath
          ? await transcribeWithWorker(input.video_id, videoPath, ctx.workspaceDir)
          : existingTranscriptProcessing(store, input.video_id, video.durationSec);
      if (!processing) throw new Error("缺少原视频资产或可复用转写证据，无法进行 content-analyze-single。");

      for (const asset of processing.assets) {
        store.addAsset(input.video_id, {
          kind: asset.kind,
          path: asset.path,
          mimeType: asset.mimeType ?? null,
          contentHash: asset.contentHash ?? null,
          metadata: asset.metadata ?? {},
        });
      }
      store.replaceTranscript(input.video_id, processing.transcript);
      store.updateVideo(input.video_id, { durationSec: processing.durationSec, status: "analyzed" });
      const transcript = store.listTranscript(input.video_id);
      const content = await analyzeContentFromTranscript(transcript);
      const analysisId = store.saveContentAnalysis(input.video_id, {
        provider: content.provider,
        model: content.model,
        transcriptHash: content.transcriptHash,
        contentJson: content.content,
      });
      const report = generateContentReport(store, input.video_id, "full");
      const reportId = store.saveAnalysisReport(input.video_id, "content_full", report);
      return { video_id: input.video_id, status: "content_analyzed", analysis_id: analysisId, report_id: reportId };
    },

    async get_content_analyze_single_report(input) {
      const format = input.format ?? "full";
      const report = generateContentReport(store, input.video_id, format);
      store.saveAnalysisReport(input.video_id, `content_${format}`, report);
      return { video_id: input.video_id, format, report };
    },

    async content_analyze_account(input) {
      if (input.video_ids.length === 0) throw new Error("至少需要 1 个 video_id。");
      const videos = input.video_ids.map(videoId => {
        const video = store.getVideo(videoId);
        if (!video) throw new Error(`Video not found: ${videoId}`);
        return video;
      });
      const author = requireSameAuthor(videos);
      const accountVideos = [];
      const singleAnalysisIds: string[] = [];
      for (const video of videos) {
        let analysis = store.getLatestContentAnalysis(video.id);
        if (!analysis) {
          try {
            await this.content_analyze_single({ video_id: video.id });
          } catch (error) {
            throw new Error(`视频 ${video.id} 无法完成 content-analyze-single：${error instanceof Error ? error.message : String(error)}`);
          }
          analysis = store.getLatestContentAnalysis(video.id);
        }
        if (!analysis) throw new Error(`视频 ${video.id} 缺少 content-analyze-single 结果。`);
        const transcriptSegments = transcriptEvidence(store, video.id);
        if (transcriptSegments.length === 0) throw new Error(`视频 ${video.id} 缺少转写证据，无法进行账号级内容分析。`);
        singleAnalysisIds.push(analysis.id);
        accountVideos.push({
          video,
          analysisId: analysis.id,
          content: analysis.contentJson,
          transcriptSegments: transcriptSegments.map(segment => ({
            startSec: segment.startSec,
            endSec: segment.endSec,
            text: segment.text,
          })),
        });
      }
      const account = await analyzeAccountContent({ author, videos: accountVideos });
      const accountAnalysisId = store.saveAccountContentAnalysis({
        author,
        videoIds: videos.map(video => video.id),
        singleAnalysisIds,
        provider: account.provider,
        model: account.model,
        contentJson: account.content,
      });
      const report = generateAccountContentReport(store, accountAnalysisId, "full");
      store.saveAnalysisReport(videos[0].id, "account_content_full", report);
      return {
        account_analysis_id: accountAnalysisId,
        status: "account_content_analyzed",
        author,
        video_ids: videos.map(video => video.id),
        single_analysis_ids: singleAnalysisIds,
      };
    },

    async get_content_analyze_account_report(input) {
      const format = input.format ?? "full";
      const report = generateAccountContentReport(store, input.account_analysis_id, format);
      return { account_analysis_id: input.account_analysis_id, format, report };
    },

    async compare_videos(input) {
      const target = store.getVideo(input.target_id);
      if (!target) throw new Error(`Target video not found: ${input.target_id}`);
      const targetShots = store.listShots(input.target_id);
      const targetAvg = averageShotDuration(targetShots);
      const refs = input.reference_ids.map(id => {
        const video = store.getVideo(id);
        if (!video) return null;
        const shots = store.listShots(id);
        return { video, shots, avg: averageShotDuration(shots) };
      }).filter(item => item !== null);
      const report = [
        `# 对比分析：${target.title}`,
        "",
        `目标视频镜头数：${targetShots.length}`,
        `目标平均镜头时长：${targetAvg.toFixed(2)} 秒`,
        `参考视频数量：${refs.length}`,
        "",
        "| 参考视频 | 镜头数 | 平均镜头时长差 | 可迁移点 |",
        "| --- | ---: | ---: | --- |",
        ...refs.map(ref => `| ${ref.video.title} | ${ref.shots.length} | ${(targetAvg - ref.avg).toFixed(2)} 秒 | 对比 hook、镜头节奏、字幕密度和 B-roll 功能 |`),
        "",
        "## 可迁移模式",
        "- 对比 hook、镜头平均时长、字幕密度和 B-roll 比例，优先复用结构，不复用原文案。",
      ].join("\n");
      return { report };
    },

    async search_video_memory(input) {
      const query = input.query.toLowerCase();
      const results = store.listVideos()
        .filter(video => !input.filters?.platform || video.platform === input.filters.platform)
        .filter(video => `${video.title} ${video.author ?? ""} ${video.platform}`.toLowerCase().includes(query))
        .map(video => ({ video_id: video.id, title: video.title, platform: video.platform, status: video.status }));
      return { results };
    },

    async make_recreation_plan(input) {
      const report = generateRecreationReport(store, input.video_id, "shooting_brief");
      const constraints = input.constraints ?? {};
      const plan = [
        report,
        "",
        "## 约束",
        JSON.stringify(constraints, null, 2),
      ].join("\n");
      const planId = store.saveRecreationPlan(input.video_id, constraints, plan);
      return { video_id: input.video_id, plan, plan_id: planId };
    },
  };
}

function averageShotDuration(shots: Array<{ startSec: number; endSec: number }>): number {
  if (shots.length === 0) return 0;
  return shots.reduce((sum, shot) => sum + Math.max(0, shot.endSec - shot.startSec), 0) / shots.length;
}
