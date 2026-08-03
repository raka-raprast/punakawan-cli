// Owns every session's lifecycle: persistence (survives daemon restarts),
// per-session serialization (never two turns racing one conversation),
// per-backend concurrency limits (via BackendRegistry's semaphores),
// bounded retry of transient failures, and a live event bus so HTTP/SSE/WS
// clients can attach to a running or already-finished turn.
//
// Storage is SQLite (`<pkwnHome>/sessions.db`): a `sessions` table for
// metadata, a `transcript_entries` table for the full raw event log (every
// response, every `reasoning` delta, every tool call/result — everything
// `runTurn` ever yields), and an FTS5 `transcript_fts` index over the
// human-readable text in that log so `search()` can find a past
// conversation by content, not just by id.

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type {
  AgentEvent,
  AskRequest,
  BackendId,
  HistoryBlock,
  HistoryTurn,
  PermissionTier,
  SessionMeta,
  SessionStatus,
  TranscriptEntry,
} from "./types.js";
import type { PkwnConfig } from "./config.js";
import type { BackendRegistry } from "./backends/registry.js";

interface SessionRuntime {
  meta: SessionMeta;
  /** Serializes turns on this session: a turn awaits the previous one's queue tail. */
  queue: Promise<unknown>;
  abort?: AbortController;
  emitter: EventEmitter;
  /** Pending `ask_user_question` tool calls awaiting a live answer,
   * keyed by tool-call id. Resolved by `answerAsk` (a real answer) or
   * `cancelPendingAsks` (the interactive client went away). */
  pendingAsks: Map<string, (answer: string[]) => void>;
}

export interface CreateSessionInput {
  backend: BackendId;
  cwd: string;
  model?: string;
  permission?: PermissionTier;
}

export interface SendMessageResult {
  finalText: string;
  ok: boolean;
  events: AgentEvent[];
}

export interface SearchResult {
  sessionId: string;
  ts: string;
  direction: "in" | "out";
  /** FTS5 `snippet()` output — the matched text with `[...]` around hits. */
  snippet: string;
}

const MAX_TRANSCRIPT_TAIL = 500;
// A long-lived VPS session's transcript would otherwise grow forever (tool
// output — e.g. Codex's aggregated_output — can be large per turn). Past
// this size we keep only the most recent half; it's Pkwn's own inspection
// log, not the backend's conversation memory (that lives in the backend's
// own resumable session state), so trimming it loses visibility, not
// context.
const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;
// Threshold below which the whole first message becomes the title
// verbatim; past it, truncate at a word boundary and mark it with "…".
const TITLE_MAX_CHARS = 60;

interface SessionRow {
  id: string;
  backend: string;
  cwd: string;
  model: string | null;
  permission: string;
  backend_session_id: string | null;
  status: string;
  title: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToMeta(row: SessionRow): SessionMeta {
  return {
    id: row.id,
    backend: row.backend as BackendId,
    cwd: row.cwd,
    model: row.model ?? undefined,
    permission: row.permission as PermissionTier,
    backendSessionId: row.backend_session_id ?? undefined,
    status: row.status as SessionStatus,
    title: row.title ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Deterministic, zero-cost session title: the first user message,
 * whitespace-collapsed and capped at TITLE_MAX_CHARS. Deliberately *not*
 * an extra LLM call — that would be a real (if tiny) API request racing
 * the session's own turn queue on a fire-and-forget schedule, burning the
 * user's quota and concurrency slot non-deterministically just to name a
 * conversation. This is instant, free, and never surprises a test or a
 * rate limit. */
function deriveTitle(firstMessage: string): string {
  const collapsed = firstMessage.replace(/\s+/g, " ").trim();
  if (collapsed.length <= TITLE_MAX_CHARS) return collapsed;
  const cut = collapsed.slice(0, TITLE_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut) + "…";
}

/** Plain-text projection of a transcript entry for the FTS index —
 * `undefined` for entries with nothing worth searching (usage/error/
 * turn_complete/started, or a mid-stream partial text delta we'll see
 * again finalized). */
function extractTextContent(entry: Omit<TranscriptEntry, "ts">): string | undefined {
  if (entry.direction === "in") {
    return "type" in entry.payload ? undefined : entry.payload.text;
  }
  if (!("type" in entry.payload)) return undefined;
  const event = entry.payload;
  if (event.type === "text" && !event.partial) return event.text;
  if (event.type === "reasoning") return event.text;
  if (event.type === "tool_call") return `${event.name} ${JSON.stringify(event.input)}`;
  if (event.type === "tool_result") return typeof event.output === "string" ? event.output : JSON.stringify(event.output);
  return undefined;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRuntime>();
  private db!: DatabaseSync;

  constructor(
    private readonly config: PkwnConfig,
    private readonly registry: BackendRegistry,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.config.pkwnHome, { recursive: true });
    this.db = new DatabaseSync(join(this.config.pkwnHome, "sessions.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        backend TEXT NOT NULL,
        cwd TEXT NOT NULL,
        model TEXT,
        permission TEXT NOT NULL,
        backend_session_id TEXT,
        status TEXT NOT NULL,
        title TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        direction TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_transcript_session ON transcript_entries(session_id, id);
      CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(text_content, tokenize='porter');
    `);

    const rows = this.db.prepare("SELECT * FROM sessions").all() as unknown as SessionRow[];
    for (const row of rows) {
      const meta = rowToMeta(row);
      // Any session left "running" when the daemon last stopped was
      // interrupted mid-turn; its backend-native session id (if any) is
      // still resumable, so we don't discard it — just mark it accurately.
      if (meta.status === "running") {
        meta.status = "interrupted";
        this.writeMeta(meta);
      }
      this.sessions.set(meta.id, { meta, queue: Promise.resolve(), emitter: new EventEmitter(), pendingAsks: new Map() });
    }
  }

  list(): SessionMeta[] {
    return [...this.sessions.values()].map((s) => s.meta);
  }

  get(id: string): SessionMeta | undefined {
    return this.sessions.get(id)?.meta;
  }

  async create(input: CreateSessionInput): Promise<SessionMeta> {
    this.registry.get(input.backend); // throws if unknown backend
    const id = randomUUID();
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id,
      backend: input.backend,
      cwd: input.cwd,
      model: input.model,
      permission: input.permission ?? "edit",
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, backend, cwd, model, permission, backend_session_id, status, title, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?)`,
      )
      .run(meta.id, meta.backend, meta.cwd, meta.model ?? null, meta.permission, meta.status, meta.createdAt, meta.updatedAt);
    this.sessions.set(id, { meta, queue: Promise.resolve(), emitter: new EventEmitter(), pendingAsks: new Map() });
    return meta;
  }

  /** Change model and/or permission tier for a session's *next* turn.
   * Safe to call anytime, including mid-turn — runTurnWithRetry reads
   * meta.model/meta.permission fresh on each call, it never captures them
   * up front. Does not affect a turn already in flight. */
  async update(id: string, patch: { model?: string; permission?: PermissionTier }): Promise<SessionMeta> {
    const runtime = this.sessions.get(id);
    if (!runtime) throw new Error(`no such session ${id}`);
    if (patch.model !== undefined) runtime.meta.model = patch.model;
    if (patch.permission !== undefined) runtime.meta.permission = patch.permission;
    runtime.meta.updatedAt = new Date().toISOString();
    this.writeMeta(runtime.meta);
    return runtime.meta;
  }

  async remove(id: string): Promise<void> {
    const runtime = this.sessions.get(id);
    if (!runtime) throw new Error(`no such session ${id}`);
    if (runtime.meta.status === "running") {
      throw new Error(`session ${id} is running; stop it before deleting`);
    }
    this.sessions.delete(id);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM transcript_fts WHERE rowid IN (SELECT id FROM transcript_entries WHERE session_id = ?)").run(id);
      this.db.prepare("DELETE FROM transcript_entries WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  stop(id: string): boolean {
    const runtime = this.sessions.get(id);
    if (!runtime?.abort) return false;
    runtime.abort.abort();
    return true;
  }

  /** Subscribe to live events for a session (past events are not replayed —
   * callers wanting history should read the transcript first). */
  subscribe(id: string, onEvent: (event: AgentEvent) => void): () => void {
    const runtime = this.sessions.get(id);
    if (!runtime) throw new Error(`no such session ${id}`);
    runtime.emitter.on("event", onEvent);
    return () => runtime.emitter.off("event", onEvent);
  }

  /** Resolves a pending `ask_user_question` tool call with a live
   * answer from whoever's attached to this session. Returns false for a
   * stale/unknown id (already answered, already abandoned) — callers
   * should treat that as a harmless no-op, not an error. */
  answerAsk(id: string, askId: string, answer: string[]): boolean {
    const resolve = this.sessions.get(id)?.pendingAsks.get(askId);
    if (!resolve) return false;
    resolve(answer);
    return true;
  }

  /** Abandons every question this session's tool loop is waiting on —
   * e.g. its one interactive client just disconnected. Each pending
   * `ask_user_question` call resolves as "dismissed" rather than
   * hanging until the turn's own timeout. */
  cancelPendingAsks(id: string): void {
    const runtime = this.sessions.get(id);
    if (!runtime) return;
    for (const resolve of runtime.pendingAsks.values()) resolve([]);
  }

  /** Rejects immediately, rather than hanging until the turn's timeout,
   * when nothing is actually attached to receive this question — a bare
   * `POST /messages` caller or the OpenAI-compatible `/chat/completions`
   * endpoint, neither of which has a live human to answer. */
  private askUser(runtime: SessionRuntime, request: AskRequest): Promise<string[]> {
    if (runtime.emitter.listenerCount("event") === 0) {
      return Promise.reject(new Error("no interactive client attached to this session"));
    }
    const { promise, resolve } = Promise.withResolvers<string[]>();
    runtime.pendingAsks.set(request.id, resolve);
    return promise.finally(() => runtime.pendingAsks.delete(request.id));
  }

  async transcriptTail(id: string, limit = 100): Promise<TranscriptEntry[]> {
    const rows = this.db
      .prepare("SELECT ts, direction, payload FROM transcript_entries WHERE session_id = ? ORDER BY id DESC LIMIT ?")
      .all(id, Math.min(limit, MAX_TRANSCRIPT_TAIL)) as unknown as Array<{ ts: string; direction: "in" | "out"; payload: string }>;
    return rows.reverse().map((r) => ({ ts: r.ts, direction: r.direction, payload: JSON.parse(r.payload) as TranscriptEntry["payload"] }));
  }

  /** Full-text search across every session's transcript. The query is
   * treated as a literal phrase (quoted and escaped) rather than FTS5's
   * full boolean-operator grammar, so arbitrary user input (hyphens,
   * quotes, `AND`/`NOT`, ...) can never produce a MATCH syntax error —
   * trading multi-term boolean queries for predictability. */
  async search(query: string, limit = 20): Promise<SearchResult[]> {
    const phrase = `"${query.replace(/"/g, '""')}"`;
    const rows = this.db
      .prepare(
        `SELECT transcript_entries.session_id as sessionId, transcript_entries.ts as ts, transcript_entries.direction as direction,
                snippet(transcript_fts, 0, '[', ']', '...', 12) as snippet
         FROM transcript_fts
         JOIN transcript_entries ON transcript_fts.rowid = transcript_entries.id
         WHERE transcript_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(phrase, limit) as unknown as SearchResult[];
    return rows;
  }

  /** Enqueue one turn on a session, serialized against any turn already
   * running on it, and return once the turn completes (success, error, or
   * exhausted retries). Live events are also emitted for subscribers. */
  async sendMessage(id: string, text: string): Promise<SendMessageResult> {
    const runtime = this.sessions.get(id);
    if (!runtime) throw new Error(`no such session ${id}`);

    const turn = runtime.queue.then(() => this.runTurnWithRetry(runtime, text));
    // Swallow rejection on the queue chain itself (already surfaced to the
    // caller of this invocation via `turn`) so it never blocks the next one.
    runtime.queue = turn.catch(() => undefined);
    return turn;
  }

  private async runTurnWithRetry(runtime: SessionRuntime, text: string): Promise<SendMessageResult> {
    const backend = this.registry.get(runtime.meta.backend);
    const maxAttempts = 1 + Math.max(0, this.config.maxTurnRetries);
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const release = await backend.semaphore.acquire();
      const abort = new AbortController();
      runtime.abort = abort;
      runtime.meta.status = "running";
      runtime.meta.updatedAt = new Date().toISOString();
      this.writeMeta(runtime.meta);
      const history = this.buildHistory(runtime.meta.id);
      this.appendTranscript(runtime.meta.id, { direction: "in", payload: { text } });

      const collected: AgentEvent[] = [];
      let finalText = "";
      let ok = false;
      let errorEvent: Extract<AgentEvent, { type: "error" }> | undefined;

      try {
        for await (const event of backend.adapter.runTurn({
          cwd: runtime.meta.cwd,
          prompt: text,
          history,
          model: runtime.meta.model ?? backend.defaultModel,
          permission: runtime.meta.permission,
          homeDir: backend.homeDir,
          signal: abort.signal,
          timeoutMs: this.config.defaultTurnTimeoutMs,
          ask: (request) => this.askUser(runtime, request),
        })) {
          collected.push(event);
          runtime.emitter.emit("event", event);
          this.appendTranscript(runtime.meta.id, { direction: "out", payload: event });

          if (event.type === "started") runtime.meta.backendSessionId = event.backendSessionId;
          if (event.type === "text" && !event.partial) finalText = event.text;
          if (event.type === "error") errorEvent = event;
          if (event.type === "turn_complete") ok = event.ok;
        }
      } catch (err) {
        errorEvent = { type: "error", kind: "crash", message: String(err), retryable: true };
        runtime.emitter.emit("event", errorEvent);
      } finally {
        runtime.abort = undefined;
        release();
      }

      if (ok) {
        runtime.meta.status = "idle";
        runtime.meta.lastError = undefined;
        runtime.meta.updatedAt = new Date().toISOString();
        this.writeMeta(runtime.meta);
        if (!runtime.meta.title) {
          runtime.meta.title = deriveTitle(text);
          this.writeMeta(runtime.meta);
        }
        return { finalText, ok: true, events: collected };
      }

      lastError = errorEvent?.message ?? "turn failed with no error detail";
      const retryable = errorEvent?.retryable ?? false;
      const isLastAttempt = attempt === maxAttempts;

      if (errorEvent?.kind === "rate_limit") {
        runtime.meta.status = "rate_limited";
      } else if (isLastAttempt || !retryable) {
        runtime.meta.status = "error";
      }
      runtime.meta.lastError = lastError;
      runtime.meta.updatedAt = new Date().toISOString();
      this.writeMeta(runtime.meta);

      if (runtime.meta.status === "rate_limited" || !retryable || isLastAttempt) {
        return { finalText, ok: false, events: collected };
      }
      const backoff = Promise.withResolvers<void>();
      setTimeout(backoff.resolve, 1000 * 2 ** (attempt - 1));
      await backoff.promise;
    }

    // Unreachable given maxAttempts >= 1, but keeps the compiler happy.
    return { finalText: "", ok: false, events: [{ type: "error", kind: "unknown", message: lastError ?? "unknown", retryable: false }] };
  }

  private writeMeta(meta: SessionMeta): void {
    this.db
      .prepare(
        `UPDATE sessions SET backend = ?, cwd = ?, model = ?, permission = ?, backend_session_id = ?, status = ?, title = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        meta.backend,
        meta.cwd,
        meta.model ?? null,
        meta.permission,
        meta.backendSessionId ?? null,
        meta.status,
        meta.title ?? null,
        meta.lastError ?? null,
        meta.updatedAt,
        meta.id,
      );
  }

  /** Replays this session's transcript into the collapsed
   * user/assistant/tool-exchange shape direct-API adapters need to resend
   * as `TurnOptions.history` — they're stateless per HTTP call, unlike a
   * CLI's own `--resume`, which remembered conversation state itself.
   * Boundaries: a new "in" entry starts a fresh user turn; a `tool_call`
   * event starts/continues the current assistant turn; a `tool_result`
   * event closes the assistant turn and starts a user turn of its own
   * (mirroring exactly how the raw provider APIs represent a multi-step
   * tool exchange — alternating role turns, not one turn per session
   * message). Only finalized (`partial: false`) text is included. */
  private buildHistory(id: string): HistoryTurn[] {
    const rows = this.db.prepare("SELECT direction, payload FROM transcript_entries WHERE session_id = ? ORDER BY id ASC").all(id) as unknown as Array<{
      direction: "in" | "out";
      payload: string;
    }>;
    const entries = rows.map((r) => ({ direction: r.direction, payload: JSON.parse(r.payload) as TranscriptEntry["payload"] }));

    const history: HistoryTurn[] = [];
    let assistantBlocks: HistoryBlock[] = [];
    let toolResultBlocks: HistoryBlock[] = [];

    const flushAssistant = (): void => {
      if (assistantBlocks.length > 0) history.push({ role: "assistant", blocks: assistantBlocks });
      assistantBlocks = [];
    };
    const flushToolResults = (): void => {
      if (toolResultBlocks.length > 0) history.push({ role: "user", blocks: toolResultBlocks });
      toolResultBlocks = [];
    };
    for (const entry of entries) {
      if (entry.direction === "in") {
        flushAssistant();
        flushToolResults();
        if (!("type" in entry.payload)) history.push({ role: "user", blocks: [{ type: "text", text: entry.payload.text }] });
        continue;
      }
      if (!("type" in entry.payload)) continue;
      const event = entry.payload;
      if (event.type === "text" && !event.partial) {
        flushToolResults();
        assistantBlocks.push({ type: "text", text: event.text });
      } else if (event.type === "tool_call") {
        flushToolResults();
        assistantBlocks.push({ type: "tool_use", id: event.id, name: event.name, input: event.input });
      } else if (event.type === "tool_result") {
        flushAssistant();
        toolResultBlocks.push({ type: "tool_result", id: event.id, output: event.output, isError: event.isError });
      }
    }
    flushAssistant();
    flushToolResults();
    return history;
  }

  private appendTranscript(id: string, entry: Omit<TranscriptEntry, "ts">): void {
    this.rotateTranscriptIfOversized(id);
    const ts = new Date().toISOString();
    const row = this.db
      .prepare("INSERT INTO transcript_entries (session_id, ts, direction, payload) VALUES (?, ?, ?, ?) RETURNING id")
      .get(id, ts, entry.direction, JSON.stringify(entry.payload)) as unknown as { id: number };
    const textContent = extractTextContent(entry);
    if (textContent) this.db.prepare("INSERT INTO transcript_fts(rowid, text_content) VALUES (?, ?)").run(row.id, textContent);
  }

  private rotateTranscriptIfOversized(id: string): void {
    const stats = this.db
      .prepare("SELECT COALESCE(SUM(LENGTH(payload)), 0) as totalBytes, COUNT(*) as count FROM transcript_entries WHERE session_id = ?")
      .get(id) as unknown as { totalBytes: number; count: number };
    if (stats.totalBytes <= MAX_TRANSCRIPT_BYTES) return;
    const dropCount = stats.count - Math.floor(stats.count / 2);
    if (dropCount <= 0) return;
    const toDrop = this.db.prepare("SELECT id FROM transcript_entries WHERE session_id = ? ORDER BY id ASC LIMIT ?").all(id, dropCount) as unknown as Array<{
      id: number;
    }>;
    const placeholders = toDrop.map(() => "?").join(",");
    const ids = toDrop.map((r) => r.id);
    if (ids.length === 0) return;
    this.db.prepare(`DELETE FROM transcript_fts WHERE rowid IN (${placeholders})`).run(...ids);
    this.db.prepare(`DELETE FROM transcript_entries WHERE id IN (${placeholders})`).run(...ids);
  }
}
