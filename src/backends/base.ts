import type { ErrorKind } from "../types.js";

/** Best-effort classification of a free-text CLI error into a canonical
 * ErrorKind. Used where a backend doesn't give us a structured error code
 * (e.g. Codex's turn.failed.error.message is plain text). */
export function classifyErrorText(text: string): ErrorKind {
  const t = text.toLowerCase();
  if (
    t.includes("usage limit") ||
    t.includes("rate limit") ||
    t.includes("resource_exhausted") ||
    t.includes("429") ||
    t.includes("out of credits") ||
    t.includes("credits depleted")
  ) {
    return "rate_limit";
  }
  if (
    t.includes("not logged in") ||
    t.includes("login expired") ||
    t.includes("please run /login") ||
    t.includes("authentication")
  ) {
    return "auth";
  }
  if (t.includes("sandbox")) return "sandbox";
  if (t.includes("config")) return "config";
  return "unknown";
}

/** Parse a line as JSON, returning undefined (never throwing) on failure —
 * CLIs occasionally interleave a stray non-JSON line (banners, warnings). */
export function tryParseJson(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
