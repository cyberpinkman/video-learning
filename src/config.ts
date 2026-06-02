import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadProjectEnv } from "./env.ts";
import { VideoLearningStore } from "./storage.ts";

loadProjectEnv();

export interface RuntimeConfig {
  workspaceDir: string;
  dbPath: string;
}

export function defaultWorkspaceDir(): string {
  return process.env.VIDEO_LEARNING_HOME || join(homedir(), ".video-learning");
}

export function resolveRuntimeConfig(args: { workspaceDir?: string; dbPath?: string } = {}): RuntimeConfig {
  const workspaceDir = resolve(args.workspaceDir || defaultWorkspaceDir());
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(join(workspaceDir, "downloads"), { recursive: true });
  mkdirSync(join(workspaceDir, "artifacts"), { recursive: true });
  const dbPath = resolve(args.dbPath || process.env.VIDEO_LEARNING_DB || join(workspaceDir, "video-learning.sqlite"));
  return { workspaceDir, dbPath };
}

export function createStore(args: { workspaceDir?: string; dbPath?: string } = {}): { store: VideoLearningStore; config: RuntimeConfig } {
  const config = resolveRuntimeConfig(args);
  return { store: new VideoLearningStore({ dbPath: config.dbPath }), config };
}
