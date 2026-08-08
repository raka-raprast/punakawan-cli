// Cron-style scheduled automations — hermes-agent's "scheduled automations"
// pillar. Owned by the daemon process directly (unlike the Telegram
// gateway, which is a separate HTTP client of the daemon): it already has
// `SessionManager` in hand, so firing a schedule is just another
// `sendMessage` call, no HTTP indirection needed. Delivery reuses the
// Telegram Bot API client built for the gateway, but talks to it
// directly (push via bot token) — no dependency on the gateway's
// long-poll process actually being up.
//
// Storage is its own SQLite file (`schedules.db`), same "one file per
// subsystem" split as credentials.db/sessions.db, and the same
// load-into-memory-map-at-init pattern SessionManager uses.

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { PkwnConfig } from "./config.js";
import type { SessionManager } from "./session-manager.js";
import type { BackendId, PermissionTier } from "./types.js";
import { nextCronFire } from "./cron.js";
import { chunkTelegramText } from "./gateway/telegram-router.js";
import { createTelegramClient, type TelegramClient } from "./gateway/telegram-client.js";

export interface ScheduleInput {
  cron: string;
  prompt: string;
  backend: BackendId;
  cwd: string;
  model?: string;
  permission?: PermissionTier;
  /** Attach to an already-existing session instead of creating (and
   * thereafter reusing) a fresh one on first fire. */
  sessionId?: string;
  /** Push the result to this Telegram chat when the turn completes
   * (requires `telegram.botToken` in config — see README). */
  notifyTelegramChatId?: string;
  enabled?: boolean;
}

export interface ScheduleMeta {
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

export interface SchedulePatch {
  cron?: string;
  prompt?: string;
  model?: string;
  permission?: PermissionTier;
  notifyTelegramChatId?: string;
  enabled?: boolean;
}

interface ScheduleRow {
  id: string;
  cron: string;
  prompt: string;
  backend: string;
  cwd: string;
  model: string | null;
  permission: string;
  session_id: string | null;
  notify_telegram_chat_id: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
  next_fire_at: string;
  last_fire_at: string | null;
  last_result: string | null;
  last_error: string | null;
}

function rowToMeta(row: ScheduleRow): ScheduleMeta {
  return {
    id: row.id,
    cron: row.cron,
    prompt: row.prompt,
    backend: row.backend as BackendId,
    cwd: row.cwd,
    model: row.model ?? undefined,
    permission: row.permission as PermissionTier,
    sessionId: row.session_id ?? undefined,
    notifyTelegramChatId: row.notify_telegram_chat_id ?? undefined,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextFireAt: row.next_fire_at,
    lastFireAt: row.last_fire_at ?? undefined,
    lastResult: (row.last_result as "ok" | "error" | null) ?? undefined,
    lastError: row.last_error ?? undefined,
  };
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;

export class Scheduler {
  private readonly schedules = new Map<string, ScheduleMeta>();
  private db!: DatabaseSync;
  private interval?: NodeJS.Timeout;
  private tickInFlight = false;
  private telegramClient?: TelegramClient;

  constructor(
    private readonly config: PkwnConfig,
    private readonly sessions: SessionManager,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.config.pkwnHome, { recursive: true });
    this.db = new DatabaseSync(join(this.config.pkwnHome, "schedules.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        cron TEXT NOT NULL,
        prompt TEXT NOT NULL,
        backend TEXT NOT NULL,
        cwd TEXT NOT NULL,
        model TEXT,
        permission TEXT NOT NULL,
        session_id TEXT,
        notify_telegram_chat_id TEXT,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        next_fire_at TEXT NOT NULL,
        last_fire_at TEXT,
        last_result TEXT,
        last_error TEXT
      );
    `);
    const rows = this.db.prepare("SELECT * FROM schedules").all() as unknown as ScheduleRow[];
    for (const row of rows) this.schedules.set(row.id, rowToMeta(row));
  }

  /** Starts the poll loop (default every 30s). A no-op if already
   * running — safe to call once from `cmdDaemon` without worrying about
   * double-starting. */
  start(pollIntervalMs = DEFAULT_POLL_INTERVAL_MS): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.tick().catch((err) => console.error(`scheduler tick failed: ${err instanceof Error ? err.message : String(err)}`));
    }, pollIntervalMs);
  }

  stop(): void {
    clearInterval(this.interval);
    this.interval = undefined;
  }

  list(): ScheduleMeta[] {
    return [...this.schedules.values()];
  }

  get(id: string): ScheduleMeta | undefined {
    return this.schedules.get(id);
  }

  async create(input: ScheduleInput): Promise<ScheduleMeta> {
    const nextFireAt = nextCronFire(input.cron, new Date()); // validates the expression, fails fast on garbage
    const now = new Date().toISOString();
    const meta: ScheduleMeta = {
      id: randomUUID(),
      cron: input.cron,
      prompt: input.prompt,
      backend: input.backend,
      cwd: input.cwd,
      model: input.model,
      permission: input.permission ?? "edit",
      sessionId: input.sessionId,
      notifyTelegramChatId: input.notifyTelegramChatId,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      nextFireAt: nextFireAt.toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO schedules (id, cron, prompt, backend, cwd, model, permission, session_id, notify_telegram_chat_id, enabled, created_at, updated_at, next_fire_at, last_fire_at, last_result, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      )
      .run(
        meta.id,
        meta.cron,
        meta.prompt,
        meta.backend,
        meta.cwd,
        meta.model ?? null,
        meta.permission,
        meta.sessionId ?? null,
        meta.notifyTelegramChatId ?? null,
        meta.enabled ? 1 : 0,
        meta.createdAt,
        meta.updatedAt,
        meta.nextFireAt,
      );
    this.schedules.set(meta.id, meta);
    return meta;
  }

  async update(id: string, patch: SchedulePatch): Promise<ScheduleMeta> {
    const existing = this.schedules.get(id);
    if (!existing) throw new Error(`no such schedule ${id}`);
    if (patch.cron !== undefined) {
      existing.nextFireAt = nextCronFire(patch.cron, new Date()).toISOString(); // re-validates + recomputes
      existing.cron = patch.cron;
    }
    if (patch.prompt !== undefined) existing.prompt = patch.prompt;
    if (patch.model !== undefined) existing.model = patch.model;
    if (patch.permission !== undefined) existing.permission = patch.permission;
    if (patch.notifyTelegramChatId !== undefined) existing.notifyTelegramChatId = patch.notifyTelegramChatId;
    if (patch.enabled !== undefined) existing.enabled = patch.enabled;
    existing.updatedAt = new Date().toISOString();
    this.writeMeta(existing);
    return existing;
  }

  async remove(id: string): Promise<void> {
    if (!this.schedules.has(id)) throw new Error(`no such schedule ${id}`);
    this.schedules.delete(id);
    this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  }

  /** Fires a schedule immediately, out of band from its cron cadence —
   * `nextFireAt` is left untouched, since this isn't the cron event
   * itself. Still records `lastFireAt`/`lastResult` and still delivers
   * to Telegram if configured, exactly like a real tick would. */
  async runNow(id: string): Promise<{ ok: boolean; finalText: string }> {
    const schedule = this.schedules.get(id);
    if (!schedule) throw new Error(`no such schedule ${id}`);
    return this.fire(schedule);
  }

  /** Fires every enabled schedule whose `nextFireAt` is due, then
   * reschedules each. Guarded against overlap: if a previous tick's
   * turn is still running (e.g. a long prompt outlasting the poll
   * interval), a tick that lands mid-flight is skipped rather than
   * double-firing the same schedule. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const due = this.list().filter((s) => s.enabled && new Date(s.nextFireAt).getTime() <= now.getTime());
      await Promise.all(due.map((s) => this.fireAndReschedule(s, now)));
    } finally {
      this.tickInFlight = false;
    }
  }

  private async fireAndReschedule(schedule: ScheduleMeta, now: Date): Promise<void> {
    try {
      await this.fire(schedule);
    } finally {
      schedule.nextFireAt = nextCronFire(schedule.cron, now).toISOString();
      schedule.updatedAt = new Date().toISOString();
      this.writeMeta(schedule);
    }
  }

  private async fire(schedule: ScheduleMeta): Promise<{ ok: boolean; finalText: string }> {
    let sessionId = schedule.sessionId;
    if (!sessionId || !this.sessions.get(sessionId)) {
      const created = await this.sessions.create({ backend: schedule.backend, cwd: schedule.cwd, model: schedule.model, permission: schedule.permission });
      sessionId = created.id;
      schedule.sessionId = sessionId; // reuse this same session on every future fire
    }

    let ok = false;
    let finalText = "";
    let errorMessage: string | undefined;
    try {
      const result = await this.sessions.sendMessage(sessionId, schedule.prompt);
      ok = result.ok;
      finalText = result.finalText;
      if (!ok) errorMessage = finalText || "turn did not complete successfully";
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    schedule.lastFireAt = new Date().toISOString();
    schedule.lastResult = ok ? "ok" : "error";
    schedule.lastError = errorMessage;
    this.writeMeta(schedule);

    if (schedule.notifyTelegramChatId) {
      await this.notifyTelegram(schedule, ok, finalText, errorMessage).catch((err) => {
        console.error(`schedule ${schedule.id}: telegram notify failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    return { ok, finalText };
  }

  private getTelegramClient(): TelegramClient | undefined {
    if (this.telegramClient) return this.telegramClient;
    if (!this.config.telegram?.botToken) return undefined;
    this.telegramClient = createTelegramClient(this.config.telegram.botToken, this.config.telegram.proxyUrl);
    return this.telegramClient;
  }

  private async notifyTelegram(schedule: ScheduleMeta, ok: boolean, finalText: string, errorMessage: string | undefined): Promise<void> {
    const client = this.getTelegramClient();
    if (!client) {
      console.warn(`schedule ${schedule.id}: notifyTelegramChatId is set but telegram.botToken isn't configured — skipping delivery`);
      return;
    }
    const header = ok ? `⏰ schedule ${schedule.id}` : `⏰ schedule ${schedule.id} FAILED`;
    const body = ok ? finalText || "(no output)" : errorMessage ?? "(no error detail)";
    for (const chunk of chunkTelegramText(`${header}\n\n${body}`)) {
      await client.sendMessage(schedule.notifyTelegramChatId!, chunk);
    }
  }

  private writeMeta(meta: ScheduleMeta): void {
    this.db
      .prepare(
        `UPDATE schedules SET cron = ?, prompt = ?, model = ?, permission = ?, session_id = ?, notify_telegram_chat_id = ?, enabled = ?, updated_at = ?, next_fire_at = ?, last_fire_at = ?, last_result = ?, last_error = ?
         WHERE id = ?`,
      )
      .run(
        meta.cron,
        meta.prompt,
        meta.model ?? null,
        meta.permission,
        meta.sessionId ?? null,
        meta.notifyTelegramChatId ?? null,
        meta.enabled ? 1 : 0,
        meta.updatedAt,
        meta.nextFireAt,
        meta.lastFireAt ?? null,
        meta.lastResult ?? null,
        meta.lastError ?? null,
        meta.id,
      );
  }
}
