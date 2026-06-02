export type Platform = "douyin" | "wechat_channels" | "xiaohongshu" | "tiktok" | "youtube" | "local" | "unknown";

export type VideoStatus = "ingested" | "processing" | "analyzed" | "failed";

export type AnalysisDepth = "standard" | "deep";

export type ReportFormat = "full" | "shooting_brief" | "shot_list" | "edit_brief";

export interface VideoRecord {
  id: string;
  platform: Platform;
  sourceUrl: string | null;
  title: string;
  author: string | null;
  publishedAt: string | null;
  durationSec: number | null;
  contentHash: string;
  status: VideoStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AssetRecord {
  id: string;
  videoId: string;
  kind: "original_video" | "audio" | "subtitle" | "cover" | "keyframe" | "screen_recording" | "analysis_json";
  path: string;
  mimeType: string | null;
  contentHash: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ShotInput {
  startSec: number;
  endSec: number;
  keyframePath?: string | null;
  visualSummary?: string;
  shotSize?: string;
  cameraMotion?: string;
  composition?: string;
  subtitles?: string;
  audioRole?: string;
  purpose?: string;
}

export interface ShotRecord extends Required<ShotInput> {
  id: string;
  videoId: string;
  shotIndex: number;
}

export interface TranscriptSegmentInput {
  startSec: number;
  endSec: number;
  speaker?: string | null;
  text: string;
  wordsPerMinute?: number | null;
  keywords?: string[];
}

export interface TranscriptSegmentRecord extends TranscriptSegmentInput {
  id: string;
  videoId: string;
  segmentIndex: number;
  speaker: string | null;
  wordsPerMinute: number | null;
  keywords: string[];
}

export interface AcquisitionAttemptInput {
  platform: Platform;
  sourceUrl: string;
  adapter: string;
  strategy: string;
  status: "success" | "failed" | "skipped";
  usedAccount?: boolean;
  usedProxy?: boolean;
  message?: string;
  outputPath?: string | null;
  outputHash?: string | null;
}

export interface DownloaderMetadata {
  outputPath: string;
  title?: string | null;
  author?: string | null;
  durationSec?: number | null;
  publishedAt?: string | null;
}

export interface AcquisitionAttemptRecord extends Required<Omit<AcquisitionAttemptInput, "usedAccount" | "usedProxy" | "message" | "outputPath" | "outputHash">> {
  id: string;
  usedAccount: boolean;
  usedProxy: boolean;
  message: string;
  outputPath: string | null;
  outputHash: string | null;
  createdAt: string;
}

export interface ProcessingResult {
  durationSec: number;
  assets: Array<{
    kind: AssetRecord["kind"];
    path: string;
    mimeType?: string | null;
    contentHash?: string | null;
    metadata?: Record<string, unknown>;
  }>;
  shots: ShotInput[];
  transcript: TranscriptSegmentInput[];
}
