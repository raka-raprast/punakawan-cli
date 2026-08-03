// Shared helpers for talking to a running pkwn daemon and running pkwn's
// own backend OAuth logins — used by both the top-level `pkwn` commands
// (cli.ts) and the interactive chat TUI (tui/App.tsx). Split out from
// cli.ts specifically so the TUI never has to import cli.ts itself: that
// file's own top-level `main().catch(...)` would re-run on import.

import { open, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { BackendRegistry } from "./backends/registry.js";
import type { PkwnConfig } from "./config.js";
import type { AgentEvent, AuthStatus, BackendId, PermissionTier, TranscriptEntry } from "./types.js";

export function isBackendId(value: string): value is BackendId {
  return value === "claude" || value === "codex" || value === "gemini";
}

/** Runs a backend's own OAuth login flow end to end — pkwn's own OAuth
 * client, independent of any vendor CLI. `homeDir` defaults to that
 * backend's registry-resolved credential store, so a plain `pkwn auth
 * login <backend>` (no override) writes to the exact location the daemon
 * itself will read from; an explicit `homeDir` is only for testing an
 * isolated login. Shared by `pkwn auth login` and the chat TUI's
 * `/connect` picker. */
export async function loginBackend(
  backend: BackendId,
  homeDir: string | undefined,
  prompt: (question: string) => Promise<string>,
): Promise<AuthStatus> {
  const config = await loadConfig();
  const registry = new BackendRegistry(config);
  const registered = registry.get(backend);
  const home = homeDir ?? registered.homeDir;
  console.log(`launching: ${registered.adapter.displayName} login (homeDir=${home})`);
  return registered.adapter.login({ homeDir: home, prompt });
}

export function daemonBase(config: PkwnConfig): { base: string; headers: Record<string, string> } {
  return {
    base: `http://${config.bindHost}:${config.port}`,
    headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
  };
}

export async function pingDaemon(base: string, headers: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(`${base}/healthz`, { headers, signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** `pkwn`'s omp/hermes-style self-start: if no daemon answers on the
 * configured port, spawn one detached (it survives this process exiting,
 * and the terminal closing) with output appended to
 * `<pkwnHome>/daemon.log`, then poll until it's reachable. Concurrent
 * launches race harmlessly — the loser's spawn hits EADDRINUSE and exits
 * immediately; every caller's poll loop succeeds once the winner binds. */
export async function ensureDaemonRunning(config: PkwnConfig): Promise<void> {
  const { base, headers } = daemonBase(config);
  if (await pingDaemon(base, headers)) return;

  const logPath = join(config.pkwnHome, "daemon.log");
  console.error(`no pkwn daemon at ${base} — starting one (log: ${logPath})`);
  const log = await open(logPath, "a");
  const child = spawn(process.execPath, [process.argv[1] ?? "", "daemon"], {
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    env: process.env,
  });
  child.unref();
  await log.close();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await pingDaemon(base, headers)) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 300);
    await promise;
  }
  throw new Error(`daemon did not come up within 15s — check ${logPath}`);
}

export interface SessionMetaResponse {
  id: string;
  backend: BackendId;
  cwd: string;
  model?: string;
  permission: PermissionTier;
  status: string;
  title?: string;
  updatedAt: string;
  /** Set when this session is a subagent spawned by another session's
   * `spawn_subagent` tool call — absent for ordinary sessions. */
  parentSessionId?: string;
  /** Only present on `GET /v1/sessions/:id` — the tail of this session's
   * raw transcript, oldest first. Absent from list/create/patch responses. */
  transcriptTail?: TranscriptEntry[];
}

export interface ScheduleMetaResponse {
  id: string;
  cron: string;
  prompt: string;
  backend: BackendId;
  cwd: string;
  model?: string;
  permission: PermissionTier;
  sessionId?: string;
  notifyTelegramChatId?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  nextFireAt: string;
  lastFireAt?: string;
  lastResult?: "ok" | "error";
  lastError?: string;
}
export interface ScheduleListResponse {
  schedules: ScheduleMetaResponse[];
}

export interface SkillInfoResponse {
  name: string;
  description: string;
  scope: "global" | "project";
}
export interface SkillListResponse {
  skills: SkillInfoResponse[];
}

/** Regroups a session's flat transcript log back into per-turn
 * `{userText, events}` shape — exactly what a live turn accumulates into
 * `state.liveTurn` before it's finalized into scrollback — so `/resume`
 * can replay the full prior conversation (text, reasoning, tool calls,
 * diffs) instead of just reconnecting to future events. An "in" entry
 * starts a new turn; every "out" entry until the next "in" belongs to
 * it. A tail that got rotated (or capped) mid-turn may start with
 * orphaned "out" entries — those get a placeholder user line rather
 * than being silently dropped. */
export function transcriptToTurns(entries: TranscriptEntry[]): Array<{ userText: string; events: AgentEvent[] }> {
  const turns: Array<{ userText: string; events: AgentEvent[] }> = [];
  let current: { userText: string; events: AgentEvent[] } | undefined;
  for (const entry of entries) {
    if (entry.direction === "in") {
      if (current) turns.push(current);
      current = { userText: (entry.payload as { text: string }).text, events: [] };
      continue;
    }
    if (!current) current = { userText: "(earlier in this conversation)", events: [] };
    current.events.push(entry.payload as AgentEvent);
  }
  if (current) turns.push(current);
  return turns;
}

export interface SessionListResponse {
  sessions: SessionMetaResponse[];
}
export interface AuthStatusEntry {
  backend: BackendId;
  loggedIn: boolean;
  mode?: string;
  detail?: string;
}
export interface AuthStatusResponse {
  backends: AuthStatusEntry[];
}
export interface SearchResultResponse {
  sessionId: string;
  ts: string;
  direction: string;
  snippet: string;
}
export interface SearchResponse {
  results: SearchResultResponse[];
}
export interface ModelInfoResponse {
  id: string;
  displayName?: string;
  description?: string;
}
export interface ModelsResponse {
  models: ModelInfoResponse[];
}

export interface LastUsed {
  backend: BackendId;
  model?: string;
  permission?: PermissionTier;
}

/** Remembers the last backend/model/permission chosen per working
 * directory (`~/.pkwn/last-used.json`), so a fresh `pkwn` in a folder you
 * used before can pre-select the same choice instead of forcing `/connect`
 * every launch — without needing an actual (lazily-created) session to
 * exist just to remember a preference. */
export async function readLastUsed(pkwnHome: string, cwd: string): Promise<LastUsed | undefined> {
  try {
    const all = JSON.parse(await readFile(join(pkwnHome, "last-used.json"), "utf8")) as Record<string, LastUsed>;
    return all[cwd];
  } catch {
    return undefined;
  }
}

export async function writeLastUsed(pkwnHome: string, cwd: string, value: LastUsed): Promise<void> {
  const path = join(pkwnHome, "last-used.json");
  let all: Record<string, LastUsed> = {};
  try {
    all = JSON.parse(await readFile(path, "utf8")) as Record<string, LastUsed>;
  } catch {
    // first write for this pkwnHome
  }
  all[cwd] = value;
  await writeFile(path, JSON.stringify(all, null, 2) + "\n", "utf8");
}

/** Thin typed fetch wrapper for daemon calls. `Response.json()` is untyped
 * by the fetch spec — this is the one place that boundary is cast, with
 * each call site naming the shape it expects. */
export async function apiRequest<T>(config: PkwnConfig, method: string, path: string, body?: unknown): Promise<T> {
  const { base, headers } = daemonBase(config);
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { ...headers, "content-type": "application/json" } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // not JSON — fall back to the raw response text
    }
    throw new Error(`${method} ${path} -> ${res.status}: ${message}`);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}
