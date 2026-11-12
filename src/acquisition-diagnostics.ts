import { isAbsolute } from "node:path";
import { redactObject, redactSecrets } from "./redact.ts";

export interface AcquisitionErrorEvidence {
  code: string;
  phase: string;
  message: string;
  retryable: boolean;
  diagnostics_path?: string;
  next_actions: string[];
  details?: Record<string, unknown>;
}

// Diagnostic URLs are evidence of a route, never a transport for signed queries
// or credentials. Source URLs in the library retain their separate policy.
export function safeDiagnosticText(value: string): string {
  const headersRemoved = value.replace(/\b(?:cookie|set-cookie|authorization)\s*:\s*[^\r\n]*/gi, "[REDACTED_HEADER]");
  return redactSecrets(headersRemoved.replace(/https?:\/\/[^\s"'<>]+/gi, raw => {
    try {
      const url = new URL(raw);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return "[REDACTED_URL]";
    }
  })).slice(0, 8000);
}

function safeDiagnosticObject(value: unknown): unknown {
  const redacted = redactObject(value);
  if (typeof redacted === "string") return safeDiagnosticText(redacted);
  if (Array.isArray(redacted)) return redacted.slice(0, 100).map(safeDiagnosticObject);
  if (redacted && typeof redacted === "object") {
    return Object.fromEntries(Object.entries(redacted).slice(0, 100).map(([key, item]) => [key, safeDiagnosticObject(item)]));
  }
  return redacted;
}

export function diagnosticPath(value: unknown): string | undefined {
  return typeof value === "string" && isAbsolute(value) ? value : undefined;
}

export function parseAcquisitionError(stderr: string): AcquisitionErrorEvidence | null {
  for (const line of stderr.trim().split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line)?.error;
      if (!value || typeof value !== "object" || Array.isArray(value)
        || typeof value.code !== "string" || !/^[a-z0-9_]+$/.test(value.code)
        || typeof value.phase !== "string" || !/^[a-z0-9_]+$/.test(value.phase)
        || typeof value.message !== "string" || typeof value.retryable !== "boolean") continue;
      const path = diagnosticPath(value.diagnostics_path);
      return {
        code: value.code, phase: value.phase, message: safeDiagnosticText(value.message), retryable: value.retryable,
        ...(path ? { diagnostics_path: path } : {}),
        next_actions: Array.isArray(value.next_actions) ? value.next_actions.filter((item: unknown): item is string => typeof item === "string").slice(0, 10).map(safeDiagnosticText) : [],
        ...(value.details && typeof value.details === "object" && !Array.isArray(value.details)
          ? { details: safeDiagnosticObject(value.details) as Record<string, unknown> } : {}),
      };
    } catch { /* Older adapters may write ordinary stderr rather than JSON. */ }
  }
  return null;
}

export class AcquisitionAdapterError extends Error {
  constructor(readonly evidence: AcquisitionErrorEvidence) {
    super(evidence.message);
  }
}

export function adapterCommandError(stderr: string, stdout: string, adapter: string): Error {
  const evidence = parseAcquisitionError(stderr) ?? parseAcquisitionError(stdout);
  if (evidence) return new AcquisitionAdapterError(evidence);
  const legacy = (stderr || stdout || `${adapter} failed`).split(/\r?\n/).map(line => {
    try { return JSON.stringify(safeDiagnosticObject(JSON.parse(line))); }
    catch { return safeDiagnosticText(line); }
  }).join("\n");
  return new Error(legacy.slice(0, 8000));
}

// Both single-video and batch consumers must retain actionable failure evidence
// instead of reducing it back to a short message.
export function compactAcquisitionAttempts(attempts: unknown[]): Array<Record<string, unknown>> {
  return attempts.map(raw => {
    const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const error = parseAcquisitionError(JSON.stringify({ error: item.error }));
    const path = diagnosticPath(item.diagnostics_path);
    return {
      adapter: String(item.adapter ?? ""), status: String(item.status ?? ""),
      message: safeDiagnosticText(String(item.message ?? "")).slice(0, 240),
      ...(error ? { error } : {}), ...(path ? { diagnostics_path: path } : {}),
    };
  });
}
