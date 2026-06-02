import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface EnvLoadOptions {
  projectRoot?: string;
  env?: Record<string, string | undefined>;
}

const defaultProjectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = trimmed.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/) ?? trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return null;
  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return [match[1], value];
}

export function loadProjectEnv(options: EnvLoadOptions = {}): void {
  const projectRoot = options.projectRoot ?? defaultProjectRoot;
  const env = options.env ?? process.env;
  const protectedKeys = new Set(Object.keys(env));
  for (const filename of [".env", ".env.local"]) {
    const path = join(projectRoot, filename);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;
      const [key, value] = parsed;
      if (!protectedKeys.has(key)) env[key] = value;
    }
  }
}
