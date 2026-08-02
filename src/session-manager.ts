// Owns every session's lifecycle: on-disk persistence (survives daemon
// restarts), per-session serialization (never two turns racing one
// conversation), per-backend concurrency limits (via BackendRegistry's
// semaphores), bounded retry of transient failures, and a live event bus so
// HTTP/SSE/WS clients can attach to a running or already-finished turn.

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type {
  AgentEvent,
  BackendId,
  PermissionTier,
  SessionMeta,
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

const MAX_TRANSCRIPT_TAIL = 500;
// A long-lived VPS session's transcript.jsonl would otherwise grow forever
// (tool output — e.g. Codex's aggregated_output — can be large per turn).
// Past this size we keep only the most recent half; it's Pkwn's own
// inspection log, not the backend's conversation memory (that lives in the
// backend's own resumable session state), so trimming it loses visibility,
// not context.
const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;

export class SessionManager {
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly dir: string;

  constructor(
    private readonly config: PkwnConfig,
    private readonly registry: BackendRegistry,
  ) {
    this.dir = join(config.pkwnHome, "sessions");
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    let entries: string[] = [];
    try {
      entries = await readdir(this.dir);
    } catch {
      return;
    }
    for (const id of entries) {
      try {
        const meta = await this.readMeta(id);
        // Any session left "running" when the daemon last stopped was
        // interrupted mid-turn; its backend-native session id (if any) is
        // still resumable, so we don't discard it — just mark it accurately.
        if (meta.status === "running") {
          meta.status = "interrupted";
          await this.writeMeta(meta);
        }
        this.sessions.set(id, { meta, queue: Promise.resolve(), emitter: new EventEmitter() });
      } catch {
        // Corrupt session directory — skip it rather than crash the daemon.
      }
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
    await mkdir(join(this.dir, id), { recursive: true });
    await this.writeMeta(meta);
    this.sessions.set(id, { meta, queue: Promise.resolve(), emitter: new EventEmitter() });
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
    await this.writeMeta(runtime.meta);
    return runtime.meta;
  }

  async remove(id: string): Promise<void> {
    const runtime = this.sessions.get(id);
    if (!runtime) throw new Error(`no such session ${id}`);
    if (runtime.meta.status === "running") {
      throw new Error(`session ${id} is running; stop it before deleting`);
    }
    this.sessions.delete(id);
    await rm(join(this.dir, id), { recursive: true, force: true });
  }

  stop(id: string): boolean {
    const runtime = this.sessions.get(id);
    if (!runtime?.abort) return false;
    runtime.abort.abort();
    return true;
  }

  /** Subscribe to live events for a session (past events are not replayed —
   * callers wanting history should read the transcript file first). */
  subscribe(id: string, onEvent: (event: AgentEvent) => void): () => void {
    const runtime = this.sessions.get(id);
    if (!runtime) throw new Error(`no such session ${id}`);
    runtime.emitter.on("event", onEvent);
    return () => runtime.emitter.off("event", onEvent);
  }

  async transcriptTail(id: string, limit = 100): Promise<TranscriptEntry[]> {
    const path = join(this.dir, id, "transcript.jsonl");
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return [];
    }
    const lines = raw.split("\n").filter(Boolean);
    return lines.slice(-Math.min(limit, MAX_TRANSCRIPT_TAIL)).map((line) => JSON.parse(line) as TranscriptEntry);
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
      await this.writeMeta(runtime.meta);
      await this.appendTranscript(runtime.meta.id, { direction: "in", payload: { text } });

      const collected: AgentEvent[] = [];
      let finalText = "";
      let ok = false;
      let errorEvent: Extract<AgentEvent, { type: "error" }> | undefined;

      try {
        for await (const event of backend.adapter.runTurn({
          cwd: runtime.meta.cwd,
          prompt: text,
          resumeId: runtime.meta.backendSessionId,
          model: runtime.meta.model ?? backend.defaultModel,
          permission: runtime.meta.permission,
          homeDir: backend.homeDir,
          signal: abort.signal,
          timeoutMs: this.config.defaultTurnTimeoutMs,
        })) {
          collected.push(event);
          runtime.emitter.emit("event", event);
          await this.appendTranscript(runtime.meta.id, { direction: "out", payload: event });

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
        await this.writeMeta(runtime.meta);
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
      await this.writeMeta(runtime.meta);

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

  private async readMeta(id: string): Promise<SessionMeta> {
    const raw = await readFile(join(this.dir, id, "meta.json"), "utf8");
    return JSON.parse(raw) as SessionMeta;
  }

  private async writeMeta(meta: SessionMeta): Promise<void> {
    await writeFile(join(this.dir, meta.id, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  }

  private async appendTranscript(
    id: string,
    entry: Omit<TranscriptEntry, "ts">,
  ): Promise<void> {
    const path = join(this.dir, id, "transcript.jsonl");
    await this.rotateTranscriptIfOversized(path);
    const full: TranscriptEntry = { ts: new Date().toISOString(), ...entry };
    await writeFile(path, JSON.stringify(full) + "\n", { flag: "a" });
  }

  private async rotateTranscriptIfOversized(path: string): Promise<void> {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return; // no transcript yet — nothing to rotate
    }
    if (size <= MAX_TRANSCRIPT_BYTES) return;
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const keep = lines.slice(-Math.floor(lines.length / 2));
    await writeFile(path, keep.length > 0 ? keep.join("\n") + "\n" : "", "utf8");
  }
}
