// The Telegram gateway's IO layer: long-polls Telegram, wires the real
// TelegramClient + HTTP DaemonClient + file-backed BindingsStore, and
// hands each incoming message to `routeTelegramMessage` for the actual
// decision logic. Runs as a standalone long-lived process
// (`pkwn gateway telegram`) — a client of the daemon's own HTTP API,
// exactly the relationship the chat TUI has, not a second thing with
// direct SessionManager access.

import { ensureDaemonRunning } from "../cli-shared.js";
import type { PkwnConfig } from "../config.js";
import type { BackendId, PermissionTier } from "../types.js";
import { createFileBindingsStore } from "./bindings.js";
import { createHttpDaemonClient } from "./daemon-client.js";
import { createTelegramClient, type TelegramClient } from "./telegram-client.js";
import { routeTelegramMessage, type TelegramRouterDeps } from "./telegram-router.js";

const LONG_POLL_TIMEOUT_SEC = 30;
const TYPING_REPEAT_MS = 4_000; // Telegram's own "typing" indicator expires after ~5s.

function isBackendIdValue(v: unknown): v is BackendId {
  return v === "claude" || v === "codex" || v === "gemini";
}
function isPermissionTierValue(v: unknown): v is PermissionTier {
  return v === "safe" || v === "edit" || v === "full";
}

/** Fails fast with one clear message rather than starting a gateway that
 * can't actually do anything useful — same posture as config.ts's own
 * bind-host/API-key validation. */
function requireGatewayConfig(config: PkwnConfig): { botToken: string; allowedChatIds: Set<string>; defaults: TelegramRouterDeps["defaults"]; proxyUrl?: string } {
  const telegram = config.telegram;
  if (!telegram?.botToken) {
    throw new Error("PKWN_TELEGRAM_BOT_TOKEN (or telegram.botToken in config.json) is required to start the Telegram gateway.");
  }
  if (!isBackendIdValue(telegram.backend)) {
    throw new Error("telegram.backend (or PKWN_TELEGRAM_BACKEND) must be one of 'claude' | 'codex' | 'gemini'.");
  }
  if (!telegram.cwd) {
    throw new Error("telegram.cwd (or PKWN_TELEGRAM_CWD) is required — a Telegram chat has no notion of a 'current directory'.");
  }
  if (telegram.permission !== undefined && !isPermissionTierValue(telegram.permission)) {
    throw new Error("telegram.permission (or PKWN_TELEGRAM_PERMISSION) must be one of 'safe' | 'edit' | 'full'.");
  }
  if (!telegram.allowedChatIds || telegram.allowedChatIds.length === 0) {
    console.warn(
      "warning: telegram.allowedChatIds is empty — every chat will just be told its own id and refused. " +
        "Message the bot once to learn your chat id, add it to config (or PKWN_TELEGRAM_ALLOWED_CHAT_IDS), and restart.",
    );
  }
  return {
    botToken: telegram.botToken,
    allowedChatIds: new Set(telegram.allowedChatIds ?? []),
    defaults: { backend: telegram.backend, cwd: telegram.cwd, permission: telegram.permission ?? "edit" },
    proxyUrl: telegram.proxyUrl,
  };
}

/** Keeps Telegram's typing indicator alive for the duration of `work` —
 * resent every few seconds since each ping only lasts ~5s server-side.
 * A failed "typing…" ping is cosmetic; it's swallowed rather than ever
 * failing the real turn over it. */
async function withTypingIndicator<T>(client: TelegramClient, chatId: string, work: () => Promise<T>): Promise<T> {
  const ping = (): void => {
    client.sendChatAction(chatId, "typing").catch(() => undefined);
  };
  ping();
  const interval = setInterval(ping, TYPING_REPEAT_MS);
  try {
    return await work();
  } finally {
    clearInterval(interval);
  }
}

/** Retries a flaky Telegram API call with linear backoff. Used for the
 * one-shot startup `getMe()` check and for delivering an
 * already-computed reply — in both cases, giving up after a single
 * transient blip is the real disaster: a login that never gets past
 * startup, or a reply for a turn whose expensive LLM work *already
 * succeeded* getting silently dropped (observed for real: a turn
 * completed and updated the session, but every one of the placeholder
 * send / real reply / error-fallback attempts hit the same network blip
 * and the user got nothing). The poll loop's own steady-state
 * `getUpdates` deliberately does NOT go through this — it already
 * retries forever on its own cadence; wrapping an infinite retry in a
 * bounded one would just add a spurious eventual failure. */
async function withRetry<T>(label: string, attempts: number, baseDelayMs: number, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts) throw err;
      console.error(`${label} failed (attempt ${attempt}/${attempts}), retrying: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(baseDelayMs * attempt);
    }
  }
}

/** Replaces the "working on it…" placeholder with a reply's first chunk
 * in place, falling back to a normal send if the edit itself fails (a
 * placeholder that never actually landed, a stale message id, ...) so
 * the real answer is never lost behind a failed edit. Remaining chunks
 * (a reply over Telegram's ~4096-char limit) always go out as new
 * messages — Telegram has no "append to an existing message" primitive.
 * Every send/edit here is retried (see `withRetry`) since the turn's
 * actual work is already done by this point. */
async function deliverReplies(client: TelegramClient, chatId: string, placeholderId: number | undefined, replies: string[]): Promise<void> {
  for (let i = 0; i < replies.length; i++) {
    const chunk = replies[i]!;
    if (i === 0 && placeholderId !== undefined) {
      try {
        await withRetry("edit placeholder", 6, 2_000, () => client.editMessageText(chatId, placeholderId, chunk));
        continue;
      } catch {
        // placeholder edit failed even after retries — fall through to a fresh send below.
      }
    }
    await withRetry("send reply", 6, 2_000, () => client.sendMessage(chatId, chunk));
  }
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function getMeWithRetry(client: TelegramClient): Promise<{ id: number; username?: string }> {
  return withRetry("getMe", 5, 3_000, () => client.getMe());
}

export async function runTelegramGateway(config: PkwnConfig): Promise<void> {
  const { botToken, allowedChatIds, defaults, proxyUrl } = requireGatewayConfig(config);
  await ensureDaemonRunning(config);

  const telegram = createTelegramClient(botToken, proxyUrl);
  const deps: TelegramRouterDeps = {
    daemon: createHttpDaemonClient(config),
    bindings: createFileBindingsStore(config.pkwnHome),
    allowedChatIds,
    defaults,
  };

  const me = await getMeWithRetry(telegram);
  console.log(`pkwn telegram gateway running as @${me.username ?? me.id} — forwarding to ${defaults.backend} @ ${defaults.cwd}`);
  console.log(allowedChatIds.size > 0 ? `authorized chats: ${[...allowedChatIds].join(", ")}` : "no chats authorized yet");

  let stopped = false;
  const abort = new AbortController();
  const shutdown = (signal: string): void => {
    console.log(`received ${signal}, stopping after the in-flight poll`);
    stopped = true;
    abort.abort();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  let offset = 0;
  while (!stopped) {
    let batch: { items: Awaited<ReturnType<TelegramClient["getUpdates"]>>["items"]; nextOffset: number };
    try {
      batch = await telegram.getUpdates(offset, LONG_POLL_TIMEOUT_SEC, abort.signal);
    } catch (err) {
      if (stopped) break;
      console.error(`getUpdates failed, retrying: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(3_000);
      continue;
    }
    offset = batch.nextOffset;

    await Promise.all(
      batch.items.map(async (item) => {
        // An immediate, visible placeholder — not just the ephemeral
        // "typing…" chat action below, which times out after ~5s per
        // ping and is easy to miss (or, on a flaky network, silently
        // drops a ping and never shows at all). This gets edited in
        // place once the real reply (or an error) is ready, so there's
        // always a persisted, visible answer to "is it stuck or just
        // thinking" — never just silence until the turn finishes.
        const placeholderId = await withRetry("send placeholder", 4, 1_500, () => telegram.sendMessage(item.chatId, "⏳ working on it…")).catch((err) => {
          console.error(`giving up on placeholder for update ${item.updateId} from chat ${item.chatId}: ${err instanceof Error ? err.message : String(err)}`);
          return undefined;
        });
        try {
          const replies = await withTypingIndicator(telegram, item.chatId, () => routeTelegramMessage(deps, item.chatId, item.text));
          await deliverReplies(telegram, item.chatId, placeholderId, replies);
        } catch (err) {
          console.error(`failed to handle update ${item.updateId} from chat ${item.chatId}: ${err instanceof Error ? err.message : String(err)}`);
          const message = "⚠️ internal error handling that message — check the gateway's logs.";
          const deliverError = async (): Promise<void> => {
            if (placeholderId !== undefined) await telegram.editMessageText(item.chatId, placeholderId, message);
            else await telegram.sendMessage(item.chatId, message);
          };
          await withRetry("deliver error notice", 4, 1_500, deliverError).catch(() => undefined);
        }
      }),
    );
  }
}
