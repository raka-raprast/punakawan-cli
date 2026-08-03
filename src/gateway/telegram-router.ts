// Pure decision logic for one incoming Telegram message: auth gating,
// gateway-level slash commands, and forwarding to the bound (or freshly
// created) pkwn session. Deliberately has no Telegram or daemon HTTP
// calls of its own — everything IO goes through the injected
// `DaemonClient`/`BindingsStore`, so this is unit-testable the same way
// `session-manager.test.ts` exercises SessionManager against a
// `FakeAdapter` instead of a real backend.

import type { BackendId, PermissionTier } from "../types.js";
import type { BindingsStore } from "./bindings.js";
import type { DaemonClient } from "./daemon-client.js";

const TELEGRAM_MAX_MESSAGE_LENGTH = 4000; // Telegram's real cap is 4096; leave margin.

/** Splits a reply into Telegram-sized chunks. Never returns an empty
 * array — an empty final answer still needs *something* sent back. */
export function chunkTelegramText(text: string, maxLen = TELEGRAM_MAX_MESSAGE_LENGTH): string[] {
  if (text.length === 0) return ["(no output)"];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) chunks.push(text.slice(i, i + maxLen));
  return chunks;
}

export interface TelegramRouterDeps {
  daemon: DaemonClient;
  bindings: BindingsStore;
  /** Deny-by-default: an empty set means every chat gets the "not
   * authorized" reply below, never a forwarded message. */
  allowedChatIds: Set<string>;
  defaults: { backend: BackendId; cwd: string; permission: PermissionTier };
}

async function resolveOrCreateSession(deps: TelegramRouterDeps, chatId: string): Promise<string> {
  const bound = await deps.bindings.get(chatId);
  if (bound) return bound;
  const created = await deps.daemon.createSession({ backend: deps.defaults.backend, cwd: deps.defaults.cwd, permission: deps.defaults.permission });
  await deps.bindings.set(chatId, created.id);
  return created.id;
}

async function forwardMessage(deps: TelegramRouterDeps, chatId: string, text: string): Promise<string[]> {
  const sessionId = await resolveOrCreateSession(deps, chatId);
  let result;
  try {
    result = await deps.daemon.sendMessage(sessionId, text);
  } catch {
    // The binding pointed at a session the daemon no longer has (deleted
    // via /rm elsewhere, a fresh daemon, a wiped pkwnHome, ...) — recreate
    // once rather than wedging this chat on a dead session forever.
    const created = await deps.daemon.createSession({ backend: deps.defaults.backend, cwd: deps.defaults.cwd, permission: deps.defaults.permission });
    await deps.bindings.set(chatId, created.id);
    result = await deps.daemon.sendMessage(created.id, text);
  }
  const prefix = result.ok ? "" : "⚠️ turn failed: ";
  return chunkTelegramText(`${prefix}${result.finalText}`.trim() || "(no output)");
}

/** Routes one incoming Telegram message to a reply (possibly
 * multi-chunk). Never throws — a `DaemonClient`/`BindingsStore` failure
 * that escapes `forwardMessage`'s own retry propagates up to the
 * gateway's IO loop, which is expected to catch it per-update so one
 * bad message never kills the long-poll loop. */
export async function routeTelegramMessage(deps: TelegramRouterDeps, chatId: string, text: string): Promise<string[]> {
  if (!deps.allowedChatIds.has(chatId)) {
    return [
      `this chat isn't authorized yet. Your chat id is ${chatId} — add it to "telegram.allowedChatIds" in config.json ` +
        `(or PKWN_TELEGRAM_ALLOWED_CHAT_IDS) and restart the gateway to authorize it.`,
    ];
  }

  const trimmed = text.trim();
  if (/^\/new\s*$/i.test(trimmed)) {
    await deps.bindings.clear(chatId);
    return ["started a fresh session — send a message to begin."];
  }
  if (/^\/id\s*$/i.test(trimmed)) {
    const bound = await deps.bindings.get(chatId);
    return [bound ? `bound to session ${bound}` : "(no active session yet — send a message to start one)"];
  }
  const modelMatch = /^\/model(?:\s+(.+))?$/i.exec(trimmed);
  if (modelMatch) {
    const bound = await deps.bindings.get(chatId);
    if (!bound) return ["no active session yet — send a message first, then /model <id>."];
    if (!modelMatch[1]) return ["usage: /model <model-id>"];
    const meta = await deps.daemon.patchSession(bound, { model: modelMatch[1].trim() });
    return [`model set to ${meta.model}`];
  }
  const permissionMatch = /^\/permission(?:\s+(.+))?$/i.exec(trimmed);
  if (permissionMatch) {
    const tier = permissionMatch[1]?.trim();
    if (tier !== "safe" && tier !== "edit" && tier !== "full") return ["usage: /permission safe|edit|full"];
    const bound = await deps.bindings.get(chatId);
    if (!bound) return ["no active session yet — send a message first, then /permission <tier>."];
    const meta = await deps.daemon.patchSession(bound, { permission: tier });
    return [`permission set to ${meta.permission}`];
  }

  return forwardMessage(deps, chatId, text);
}
