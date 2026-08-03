// Minimal Telegram Bot API wrapper — plain HTTP/JSON (`api.telegram.org`),
// same "no SDK, direct API calls" philosophy as the backend adapters.
// Long polling only (`getUpdates`): no public HTTPS endpoint required,
// which fits a single self-hosted gateway process better than webhooks.

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
  sendMessage(chatId: string, text: string): Promise<void>;
  sendChatAction(chatId: string, action: "typing"): Promise<void>;
}

interface RawUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
}

async function callApi<T>(botToken: string, method: string, params: Record<string, unknown>, timeoutMs: number, externalSignal?: AbortSignal): Promise<T> {
  const signal = externalSignal ? AbortSignal.any([externalSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const res = await fetch(`${API_BASE}/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    signal,
  });
  const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!body.ok) throw new Error(`telegram ${method} failed: ${body.description ?? res.status}`);
  return body.result as T;
}

export function createTelegramClient(botToken: string): TelegramClient {
  return {
    async getMe() {
      const result = await callApi<{ id: number; username?: string }>(botToken, "getMe", {}, 10_000);
      return { id: result.id, username: result.username };
    },

    async getUpdates(offset, timeoutSec, signal) {
      // The HTTP call must outlast Telegram's own server-side long-poll
      // window, or we'd abort a request that was about to succeed.
      const updates = await callApi<RawUpdate[]>(botToken, "getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message"] }, (timeoutSec + 10) * 1000, signal);
      let nextOffset = offset;
      const items: TelegramIncoming[] = [];
      for (const update of updates) {
        nextOffset = Math.max(nextOffset, update.update_id + 1);
        if (update.message?.text) items.push({ updateId: update.update_id, chatId: String(update.message.chat.id), text: update.message.text });
      }
      return { items, nextOffset };
    },

    async sendMessage(chatId, text) {
      await callApi(botToken, "sendMessage", { chat_id: chatId, text }, 15_000);
    },

    async sendChatAction(chatId, action) {
      await callApi(botToken, "sendChatAction", { chat_id: chatId, action }, 10_000);
    },
  };
}
