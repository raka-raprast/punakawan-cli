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
      /** Opaque tool-specific display hints (e.g. `run_bash`'s wall time
       * and effective timeout) — ignored by everything except the TUI's
       * own rendering, threaded straight through from `ToolExecutionResult`. */
      meta?: Record<string, unknown>;
    }
  | { type: "usage"; usage: UsageInfo }
  | { type: "warning"; message: string }
  | { type: "error"; kind: ErrorKind; message: string; retryable: boolean }
  | { type: "turn_complete"; ok: boolean; stopReason?: string };

/** One collapsed content block within a turn's final (non-streaming) state
 * — direct-API adapters are stateless per HTTP call, so the full prior
 * conversation must be resent as `TurnOptions.history` on every turn
 * (unlike CLI `--resume`, which let the vendor CLI remember it locally). */
export interface HistoryBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  /** tool_use/tool_result correlation id. */
  id?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
}

export interface HistoryTurn {
  role: "user" | "assistant";
  blocks: HistoryBlock[];
}

export interface AskOption {
  label: string;
  description?: string;
}

/** A pending `ask_user_question` tool call, correlated by `id` (the
 * tool_use/function-call id) so an out-of-band answer can be routed back
 * to the right pending call. */
export interface AskRequest {
  id: string;
  question: string;
  options: AskOption[];
  allowMultiple: boolean;
}

export interface TurnOptions {
  /** Working directory for tool execution (file edits, shell commands). */
  cwd: string;
  prompt: string;
  /** Full prior conversation for this session, oldest first. Empty on the
   * first turn. */
  history: HistoryTurn[];
  model?: string;
  permission: PermissionTier;
  /** Isolated credential storage dir override (per-worker auth isolation). */
  homeDir?: string;
  signal: AbortSignal;
  timeoutMs: number;
  /** Lets the `ask_user_question` tool pause the turn and collect a live
   * choice from whoever is attached to this session. Undefined for
   * contexts with no interactive human ever possible (`pkwn verify`).
   * Where it *is* provided (every session-manager-backed turn, including
   * the OpenAI-compatible chat/completions endpoint), it still rejects
   * immediately rather than hanging until the turn's timeout if nothing
   * is actually attached to answer at call time — the tool degrades to
   * an error result in both cases. */
  ask?: (request: AskRequest) => Promise<string[]>;
}

export interface AuthStatus {
  backend: BackendId;
  loggedIn: boolean;
  /** e.g. "oauth-subscription" | "api-key" | "unknown" */
  mode?: string;
  plan?: string;
  detail?: string;
}

export interface ModelInfo {
  id: string;
  displayName?: string;
  description?: string;
}

export interface BackendAdapter {
  readonly id: BackendId;
  readonly displayName: string;
  /** Default max concurrent requests the daemon will run for this backend. */
  readonly defaultMaxConcurrency: number;
  checkAuth(homeDir?: string): Promise<AuthStatus>;
  /** Runs this backend's own OAuth login flow end to end — pkwn's own
   * OAuth client, independent of the vendor CLI. Most providers catch the
   * redirect on a local callback server automatically; Anthropic's
   * subscription OAuth redirects to a fixed Anthropic-hosted page instead
   * (no local port to catch), so `prompt` lets the adapter ask the caller
   * (the chat REPL's own `question()`) to relay a manually-pasted code. */
  login(opts: { homeDir?: string; prompt: (question: string) => Promise<string> }): Promise<AuthStatus>;
  logout(homeDir?: string): Promise<void>;
  /** The models this backend's account can actually use *right now* —
   * queried live from the provider where that's possible (Anthropic,
   * OpenAI/Codex both expose a real models-list endpoint pkwn's own OAuth
   * token can call directly). Backends with no such endpoint (Gemini's
   * Code Assist internal API doesn't have one — verified, `:listModels`
   * 404s) fall back to a maintained static list; check the adapter's own
   * comment for that backend's actual source of truth. */
  listModels(homeDir?: string): Promise<ModelInfo[]>;
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
  backendSessionId?: string;
  status: SessionStatus;
  /** Auto-generated after the session's first successful turn (a short
   * summary of what the conversation is about), same idea as most chat
   * UIs' thread titles. Absent until that background generation lands. */
  title?: string;
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
