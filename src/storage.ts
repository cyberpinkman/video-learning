import { Database } from "bun:sqlite";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { sha256File } from "./hash.ts";
import { redactSecrets } from "./redact.ts";
import type {
  AcquisitionAttemptInput,
  AcquisitionAttemptRecord,
  AssetRecord,
  Platform,
  ShotInput,
  ShotRecord,
  TranscriptSegmentInput,
  TranscriptSegmentRecord,
  VideoRecord,
  VideoStatus,
} from "./types.ts";

export interface StoreOptions {
  dbPath: string;
}

interface VideoRecordInput {
  platform: Platform;
  sourceUrl: string | null;
  title: string;
  author: string | null;
  publishedAt: string | null;
  durationSec: number | null;
  contentHash: string;
  status: VideoStatus;
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function jsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class VideoLearningStore {
  private db: Database;

  constructor(options: StoreOptions) {
    this.db = new Database(options.dbPath, { create: true });
    this.db.run("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS videos (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        source_url TEXT,
        title TEXT NOT NULL,
        author TEXT,
        published_at TEXT,
        duration_sec REAL,
        content_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS acquisition_attempts (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        source_url TEXT NOT NULL,
        adapter TEXT NOT NULL,
        strategy TEXT NOT NULL,
        status TEXT NOT NULL,
        used_account INTEGER NOT NULL DEFAULT 0,
        used_proxy INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL DEFAULT '',
        output_path TEXT,
        output_hash TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        mime_type TEXT,
        content_hash TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS shots (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        shot_index INTEGER NOT NULL,
        start_sec REAL NOT NULL,
        end_sec REAL NOT NULL,
        keyframe_path TEXT NOT NULL DEFAULT '',
        visual_summary TEXT NOT NULL DEFAULT '',
        shot_size TEXT NOT NULL DEFAULT '',
        camera_motion TEXT NOT NULL DEFAULT '',
        composition TEXT NOT NULL DEFAULT '',
        subtitles TEXT NOT NULL DEFAULT '',
        audio_role TEXT NOT NULL DEFAULT '',
        purpose TEXT NOT NULL DEFAULT '',
        UNIQUE(video_id, shot_index)
      );

      CREATE TABLE IF NOT EXISTS transcript_segments (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        segment_index INTEGER NOT NULL,
        start_sec REAL NOT NULL,
        end_sec REAL NOT NULL,
        speaker TEXT,
        text TEXT NOT NULL,
        words_per_minute REAL,
        keywords TEXT NOT NULL DEFAULT '[]',
        UNIQUE(video_id, segment_index)
      );

      CREATE TABLE IF NOT EXISTS analysis_reports (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        format TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recreation_plans (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        constraints_json TEXT NOT NULL DEFAULT '{}',
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_assets_video ON assets(video_id);
      CREATE INDEX IF NOT EXISTS idx_shots_video ON shots(video_id, shot_index);
      CREATE INDEX IF NOT EXISTS idx_transcript_video ON transcript_segments(video_id, segment_index);
      CREATE INDEX IF NOT EXISTS idx_attempts_created ON acquisition_attempts(created_at);
    `);
  }

  async ingestLocalFile(input: { path: string; platform?: Platform; sourceUrl?: string | null }): Promise<{ videoId: string; created: boolean; contentHash: string }> {
    const stat = statSync(input.path);
    if (!stat.isFile()) throw new Error(`Not a regular file: ${input.path}`);
    const contentHash = await sha256File(input.path);
    const existing = this.findVideoByHash(contentHash);
    if (existing) {
      return { videoId: existing.id, created: false, contentHash };
    }

    const videoId = this.createVideoRecord({
      platform: input.platform ?? "local",
      sourceUrl: input.sourceUrl ? redactSecrets(input.sourceUrl) : null,
      title: basename(input.path),
      author: null,
      publishedAt: null,
      durationSec: null,
      contentHash,
      status: "ingested",
    });
    this.addAsset(videoId, {
      kind: "original_video",
      path: input.path,
      mimeType: "video/mp4",
      contentHash,
      metadata: { source: "local_file" },
    });
    return { videoId, created: true, contentHash };
  }

  createVideoRecord(input: VideoRecordInput): string {
    const existing = this.findVideoByHash(input.contentHash);
    if (existing) return existing.id;
    const videoId = id("vid");
    const ts = nowIso();
    this.db.query(`
      INSERT INTO videos (id, platform, source_url, title, author, published_at, duration_sec, content_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(videoId, input.platform, input.sourceUrl ? redactSecrets(input.sourceUrl) : null, input.title, input.author, input.publishedAt, input.durationSec, input.contentHash, input.status, ts, ts);
    return videoId;
  }

  updateVideo(videoId: string, patch: Partial<Pick<VideoRecord, "title" | "author" | "publishedAt" | "durationSec" | "status">>): void {
    const current = this.getVideo(videoId);
    if (!current) throw new Error(`Video not found: ${videoId}`);
    this.db.query(`
      UPDATE videos
      SET title = ?, author = ?, published_at = ?, duration_sec = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(
      patch.title ?? current.title,
      patch.author === undefined ? current.author : patch.author,
      patch.publishedAt === undefined ? current.publishedAt : patch.publishedAt,
      patch.durationSec === undefined ? current.durationSec : patch.durationSec,
      patch.status ?? current.status,
      nowIso(),
      videoId,
    );
  }

  addAsset(videoId: string, input: {
    kind: AssetRecord["kind"];
    path: string;
    mimeType?: string | null;
    contentHash?: string | null;
    metadata?: Record<string, unknown>;
  }): string {
    const assetId = id("ast");
    this.db.query(`
      INSERT INTO assets (id, video_id, kind, path, mime_type, content_hash, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(assetId, videoId, input.kind, input.path, input.mimeType ?? null, input.contentHash ?? null, JSON.stringify(input.metadata ?? {}), nowIso());
    return assetId;
  }

  replaceShots(videoId: string, shots: ShotInput[]): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM shots WHERE video_id = ?").run(videoId);
      const insert = this.db.query(`
        INSERT INTO shots (id, video_id, shot_index, start_sec, end_sec, keyframe_path, visual_summary, shot_size, camera_motion, composition, subtitles, audio_role, purpose)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      shots.forEach((shot, index) => {
        insert.run(
          id("shot"),
          videoId,
          index,
          shot.startSec,
          shot.endSec,
          shot.keyframePath ?? "",
          shot.visualSummary ?? "",
          shot.shotSize ?? "",
          shot.cameraMotion ?? "",
          shot.composition ?? "",
          shot.subtitles ?? "",
          shot.audioRole ?? "",
          shot.purpose ?? "",
        );
      });
    })();
  }

  replaceTranscript(videoId: string, transcript: TranscriptSegmentInput[]): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM transcript_segments WHERE video_id = ?").run(videoId);
      const insert = this.db.query(`
        INSERT INTO transcript_segments (id, video_id, segment_index, start_sec, end_sec, speaker, text, words_per_minute, keywords)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      transcript.forEach((segment, index) => {
        insert.run(
          id("trn"),
          videoId,
          index,
          segment.startSec,
          segment.endSec,
          segment.speaker ?? null,
          segment.text,
          segment.wordsPerMinute ?? null,
          JSON.stringify(segment.keywords ?? []),
        );
      });
    })();
  }

  saveAnalysisReport(videoId: string, format: string, content: string): string {
    const reportId = id("rpt");
    this.db.query("INSERT INTO analysis_reports (id, video_id, format, content, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(reportId, videoId, format, content, nowIso());
    return reportId;
  }

  saveRecreationPlan(videoId: string, constraints: Record<string, unknown>, content: string): string {
    const planId = id("plan");
    this.db.query("INSERT INTO recreation_plans (id, video_id, constraints_json, content, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(planId, videoId, JSON.stringify(constraints), content, nowIso());
    return planId;
  }

  logAcquisitionAttempt(input: AcquisitionAttemptInput): string {
    const attemptId = id("acq");
    this.db.query(`
      INSERT INTO acquisition_attempts (id, platform, source_url, adapter, strategy, status, used_account, used_proxy, message, output_path, output_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attemptId,
      input.platform,
      redactSecrets(input.sourceUrl),
      input.adapter,
      input.strategy,
      input.status,
      input.usedAccount ? 1 : 0,
      input.usedProxy ? 1 : 0,
      redactSecrets(input.message ?? ""),
      input.outputPath ? redactSecrets(input.outputPath) : null,
      input.outputHash ?? null,
      nowIso(),
    );
    return attemptId;
  }

  findVideoByHash(contentHash: string): VideoRecord | null {
    const row = this.db.query("SELECT * FROM videos WHERE content_hash = ?").get(contentHash) as Record<string, unknown> | null;
    return row ? this.mapVideo(row) : null;
  }

  getVideo(videoId: string): VideoRecord | null {
    const row = this.db.query("SELECT * FROM videos WHERE id = ?").get(videoId) as Record<string, unknown> | null;
    return row ? this.mapVideo(row) : null;
  }

  listVideos(): VideoRecord[] {
    return this.db.query("SELECT * FROM videos ORDER BY created_at").all().map(row => this.mapVideo(row as Record<string, unknown>));
  }

  listAssets(videoId: string): AssetRecord[] {
    return this.db.query("SELECT * FROM assets WHERE video_id = ? ORDER BY created_at").all(videoId).map(row => this.mapAsset(row as Record<string, unknown>));
  }

  listShots(videoId: string): ShotRecord[] {
    return this.db.query("SELECT * FROM shots WHERE video_id = ? ORDER BY shot_index").all(videoId).map(row => this.mapShot(row as Record<string, unknown>));
  }

  listTranscript(videoId: string): TranscriptSegmentRecord[] {
    return this.db.query("SELECT * FROM transcript_segments WHERE video_id = ? ORDER BY segment_index").all(videoId).map(row => this.mapTranscript(row as Record<string, unknown>));
  }

  listAcquisitionAttempts(): AcquisitionAttemptRecord[] {
    return this.db.query("SELECT * FROM acquisition_attempts ORDER BY created_at").all().map(row => this.mapAttempt(row as Record<string, unknown>));
  }

  private mapVideo(row: Record<string, unknown>): VideoRecord {
    return {
      id: String(row.id),
      platform: row.platform as Platform,
      sourceUrl: row.source_url ? String(row.source_url) : null,
      title: String(row.title),
      author: row.author ? String(row.author) : null,
      publishedAt: row.published_at ? String(row.published_at) : null,
      durationSec: row.duration_sec === null || row.duration_sec === undefined ? null : Number(row.duration_sec),
      contentHash: String(row.content_hash),
      status: row.status as VideoStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapAsset(row: Record<string, unknown>): AssetRecord {
    return {
      id: String(row.id),
      videoId: String(row.video_id),
      kind: row.kind as AssetRecord["kind"],
      path: String(row.path),
      mimeType: row.mime_type ? String(row.mime_type) : null,
      contentHash: row.content_hash ? String(row.content_hash) : null,
      metadata: jsonParse(String(row.metadata ?? "{}"), {}),
      createdAt: String(row.created_at),
    };
  }

  private mapShot(row: Record<string, unknown>): ShotRecord {
    return {
      id: String(row.id),
      videoId: String(row.video_id),
      shotIndex: Number(row.shot_index),
      startSec: Number(row.start_sec),
      endSec: Number(row.end_sec),
      keyframePath: String(row.keyframe_path ?? ""),
      visualSummary: String(row.visual_summary ?? ""),
      shotSize: String(row.shot_size ?? ""),
      cameraMotion: String(row.camera_motion ?? ""),
      composition: String(row.composition ?? ""),
      subtitles: String(row.subtitles ?? ""),
      audioRole: String(row.audio_role ?? ""),
      purpose: String(row.purpose ?? ""),
    };
  }

  private mapTranscript(row: Record<string, unknown>): TranscriptSegmentRecord {
    return {
      id: String(row.id),
      videoId: String(row.video_id),
      segmentIndex: Number(row.segment_index),
      startSec: Number(row.start_sec),
      endSec: Number(row.end_sec),
      speaker: row.speaker ? String(row.speaker) : null,
      text: String(row.text),
      wordsPerMinute: row.words_per_minute === null || row.words_per_minute === undefined ? null : Number(row.words_per_minute),
      keywords: jsonParse(String(row.keywords ?? "[]"), []),
    };
  }

  private mapAttempt(row: Record<string, unknown>): AcquisitionAttemptRecord {
    return {
      id: String(row.id),
      platform: row.platform as Platform,
      sourceUrl: String(row.source_url),
      adapter: String(row.adapter),
      strategy: String(row.strategy),
      status: row.status as "success" | "failed" | "skipped",
      usedAccount: Boolean(row.used_account),
      usedProxy: Boolean(row.used_proxy),
      message: String(row.message ?? ""),
      outputPath: row.output_path ? String(row.output_path) : null,
      outputHash: row.output_hash ? String(row.output_hash) : null,
      createdAt: String(row.created_at),
    };
  }
}
