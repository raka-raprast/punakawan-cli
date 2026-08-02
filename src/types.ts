// Canonical, backend-agnostic types. Every backend adapter (Claude Code, Codex,
// Gemini) normalizes its own wire format into these shapes so the rest of the
// daemon (session manager, HTTP/WS API) never has to know which CLI is behind
// a session.

export type BackendId = "claude" | "codex" | "gemini";

/** Coarse permission tier, mapped by each adapter onto its own CLI flags. */
export type PermissionTier = "safe" | "edit" | "full";

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

export type ErrorKind =
  | "auth"
  | "rate_limit"
  | "sandbox"
  | "config"
  | "tool"
  | "cancelled"
  | "crash"
  | "timeout"
  | "unknown";

export type AgentEvent =
  | { type: "started"; backendSessionId: string }
  /** `text` is the cumulative assistant text produced so far for the
   * in-flight message (never a raw delta chunk) — partial=true means more
   * updates will follow for this same message, false means it is final.
   * Consumers that want incremental output diff against the previous
   * cumulative value themselves. */
  | { type: "text"; role: "assistant"; text: string; partial: boolean }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      id: string;
      output?: unknown;
      isError: boolean;
      error?: string;
    }
  | { type: "usage"; usage: UsageInfo }
  | { type: "warning"; message: string }
  | { type: "error"; kind: ErrorKind; message: string; retryable: boolean }
  | { type: "turn_complete"; ok: boolean; stopReason?: string };

export interface TurnOptions {
  /** Working directory the CLI should run in. Session/resume lookup for
   * Claude, Codex, and Gemini is all scoped (directly or via project hash)
   * to this directory, so it must stay stable across turns of one session. */
  cwd: string;
  prompt: string;
  /** Backend-native session/thread id to resume, or undefined for a fresh session. */
  resumeId?: string;
  model?: string;
  permission: PermissionTier;
  /** Isolated credential/config home dir override (per-worker auth isolation). */
  homeDir?: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface AuthStatus {
  backend: BackendId;
  loggedIn: boolean;
  /** e.g. "oauth-subscription" | "api-key" | "unknown" */
  mode?: string;
  plan?: string;
  detail?: string;
}

export interface BackendAdapter {
  readonly id: BackendId;
  readonly displayName: string;
  /** Default max concurrent OS processes the daemon will run for this backend. */
  readonly defaultMaxConcurrency: number;
  checkAuth(homeDir?: string): Promise<AuthStatus>;
  runTurn(opts: TurnOptions): AsyncGenerator<AgentEvent, void, void>;
}

export type SessionStatus =
  | "idle"
  | "running"
  | "error"
  | "rate_limited"
  | "interrupted"
  | "stopped";

export interface SessionMeta {
  id: string;
  backend: BackendId;
  cwd: string;
  model?: string;
  permission: PermissionTier;
  homeDir?: string;
  backendSessionId?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface TranscriptEntry {
  ts: string;
  direction: "in" | "out";
  /** "in" entries carry {text}; "out" entries carry an AgentEvent. */
  payload: { text: string } | AgentEvent;
}
