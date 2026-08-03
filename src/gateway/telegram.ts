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
function requireGatewayConfig(config: PkwnConfig): { botToken: string; allowedChatIds: Set<string>; defaults: TelegramRouterDeps["defaults"] } {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runTelegramGateway(config: PkwnConfig): Promise<void> {
  const { botToken, allowedChatIds, defaults } = requireGatewayConfig(config);
  await ensureDaemonRunning(config);

  const telegram = createTelegramClient(botToken);
  const deps: TelegramRouterDeps = {
    daemon: createHttpDaemonClient(config),
    bindings: createFileBindingsStore(config.pkwnHome),
    allowedChatIds,
    defaults,
  };

  const me = await telegram.getMe();
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
        try {
          const replies = await withTypingIndicator(telegram, item.chatId, () => routeTelegramMessage(deps, item.chatId, item.text));
          for (const reply of replies) await telegram.sendMessage(item.chatId, reply);
        } catch (err) {
          console.error(`failed to handle update ${item.updateId} from chat ${item.chatId}: ${err instanceof Error ? err.message : String(err)}`);
          await telegram.sendMessage(item.chatId, "⚠️ internal error handling that message — check the gateway's logs.").catch(() => undefined);
        }
      }),
    );
  }
}
