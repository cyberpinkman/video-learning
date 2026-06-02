const SECRET_PATTERNS: RegExp[] = [
  /([?&](?:token|access_token|refresh_token|cookie|session|auth|key)=)[^&#\s]+/gi,
  /(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /\b(cookie|session|token|access_token|refresh_token|secret|password)=([^;\s&]+)/gi,
  /\b(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}\b/g,
  /\b(?:https?:\/\/)?[^@\s]+:[^@\s]+@[^/\s]+/g,
];

export function redactSecrets(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match, prefix) => {
      if (typeof prefix === "string" && prefix.length > 0 && match.startsWith(prefix)) {
        return `${prefix}[REDACTED]`;
      }
      return match.includes("=") ? match.replace(/=.*/, "=[REDACTED]") : "[REDACTED]";
    });
  }
  return redacted;
}

export function redactObject<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map(item => redactObject(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const keyLooksSecret = /token|cookie|secret|password|authorization|proxy/i.test(key);
      out[key] = keyLooksSecret ? "[REDACTED]" : redactObject(item);
    }
    return out as T;
  }
  return value;
}
