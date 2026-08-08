// Minimal Telegram Bot API wrapper — plain HTTP/JSON (`api.telegram.org`),
// same "no SDK, direct API calls" philosophy as the backend adapters.
// Long polling only (`getUpdates`): no public HTTPS endpoint required,
// which fits a single self-hosted gateway process better than webhooks.

import { ProxyAgent, type Dispatcher } from "undici";

const API_BASE = "https://api.telegram.org";

export interface TelegramIncoming {
  updateId: number;
  chatId: string;
  text: string;
}

export interface TelegramClient {
  getMe(): Promise<{ id: number; username?: string }>;
  /** Long-polls for new updates starting after `offset - 1`. Blocks up to
   * `timeoutSec` server-side if nothing is pending. `nextOffset` accounts
   * for every raw update seen (including non-text ones filtered out of
   * `items`), so callers never re-fetch an update they've already
   * consumed. `signal` lets the gateway's shutdown handler cancel a
   * pending long-poll immediately instead of waiting out its timeout. */
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<{ items: TelegramIncoming[]; nextOffset: number }>;
  /** Returns the sent message's id — callers use it to later
   * `editMessageText` this same message in place (e.g. turning a
   * "working on it…" placeholder into the real answer) instead of
   * sending a second message. */
  sendMessage(chatId: string, text: string): Promise<number>;
  editMessageText(chatId: string, messageId: number, text: string): Promise<void>;
  sendChatAction(chatId: string, action: "typing"): Promise<void>;
}

interface RawUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
}

async function callApi<T>(
  botToken: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  dispatcher: Dispatcher | undefined,
  externalSignal?: AbortSignal,
): Promise<T> {
  const signal = externalSignal ? AbortSignal.any([externalSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const res = await fetch(`${API_BASE}/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    signal,
    ...(dispatcher ? { dispatcher } : {}),
  });
  const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!body.ok) throw new Error(`telegram ${method} failed: ${body.description ?? res.status}`);
  return body.result as T;
}

/** `proxyUrl`, when set, tunnels every Telegram Bot API call through an
 * HTTP CONNECT proxy (`telegram.proxyUrl` / `PKWN_TELEGRAM_PROXY_URL`) —
 * for a network where this process's own egress to `api.telegram.org` is
 * blocked/throttled but everything else (the daemon's HTTP API, in
 * particular) is reachable directly, so this is scoped to just the
 * Telegram client rather than a machine-wide proxy/exit-node. */
export function createTelegramClient(botToken: string, proxyUrl?: string): TelegramClient {
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  return {
    async getMe() {
      const result = await callApi<{ id: number; username?: string }>(botToken, "getMe", {}, 10_000, dispatcher);
      return { id: result.id, username: result.username };
    },

    async getUpdates(offset, timeoutSec, signal) {
      // The HTTP call must outlast Telegram's own server-side long-poll
      // window, or we'd abort a request that was about to succeed.
      const updates = await callApi<RawUpdate[]>(botToken, "getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message"] }, (timeoutSec + 10) * 1000, dispatcher, signal);
      let nextOffset = offset;
      const items: TelegramIncoming[] = [];
      for (const update of updates) {
        nextOffset = Math.max(nextOffset, update.update_id + 1);
        if (update.message?.text) items.push({ updateId: update.update_id, chatId: String(update.message.chat.id), text: update.message.text });
      }
      return { items, nextOffset };
    },

    async sendMessage(chatId, text) {
      const result = await callApi<{ message_id: number }>(botToken, "sendMessage", { chat_id: chatId, text }, 15_000, dispatcher);
      return result.message_id;
    },

    async editMessageText(chatId, messageId, text) {
      await callApi(botToken, "editMessageText", { chat_id: chatId, message_id: messageId, text }, 15_000, dispatcher);
    },

    async sendChatAction(chatId, action) {
      await callApi(botToken, "sendChatAction", { chat_id: chatId, action }, 10_000, dispatcher);
    },
  };
}
