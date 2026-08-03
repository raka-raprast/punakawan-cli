// Thin typed wrapper around the running pkwn daemon's own HTTP API —
// the Telegram gateway is a client of that API, exactly like the chat
// TUI (`cli-shared.ts`'s `apiRequest`), not a second thing with direct
// SessionManager access. Keeps the daemon single-purpose and lets the
// gateway run on a different machine than the daemon if desired.

import { apiRequest } from "../cli-shared.js";
import type { PkwnConfig } from "../config.js";
import type { BackendId, PermissionTier } from "../types.js";

export interface DaemonClient {
  createSession(input: { backend: BackendId; cwd: string; permission?: PermissionTier }): Promise<{ id: string }>;
  sendMessage(sessionId: string, text: string): Promise<{ ok: boolean; finalText: string }>;
  /** Undefined for a session that no longer exists (e.g. deleted via
   * `/rm` since the gateway last bound this chat to it) — callers treat
   * that the same as "never bound" and create a fresh one. */
  getSession(sessionId: string): Promise<{ id: string; model?: string; permission: PermissionTier } | undefined>;
  patchSession(sessionId: string, patch: { model?: string; permission?: PermissionTier }): Promise<{ model?: string; permission: PermissionTier }>;
}

export function createHttpDaemonClient(config: PkwnConfig): DaemonClient {
  return {
    async createSession(input) {
      return apiRequest(config, "POST", "/v1/sessions", input);
    },
    async sendMessage(sessionId, text) {
      return apiRequest(config, "POST", `/v1/sessions/${sessionId}/messages`, { text });
    },
    async getSession(sessionId) {
      try {
        return await apiRequest(config, "GET", `/v1/sessions/${sessionId}`);
      } catch {
        return undefined;
      }
    },
    async patchSession(sessionId, patch) {
      return apiRequest(config, "PATCH", `/v1/sessions/${sessionId}`, patch);
    },
  };
}
