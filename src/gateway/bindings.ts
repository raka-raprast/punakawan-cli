// Persists which pkwn session each Telegram chat is currently bound to,
// across gateway restarts — same flat-JSON-file convention as
// `cli-shared.ts`'s `last-used.json` (this is small, infrequently-written
// keyed state; sessions.db's SQLite/WAL machinery exists for the
// cross-process, high-churn transcript data, which this isn't). Only the
// gateway process itself ever touches this file, so a plain
// read-modify-write is safe — no concurrent writer to race.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface BindingsStore {
  get(chatId: string): Promise<string | undefined>;
  set(chatId: string, sessionId: string): Promise<void>;
  clear(chatId: string): Promise<void>;
}

async function readAll(path: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function createFileBindingsStore(pkwnHome: string): BindingsStore {
  const path = join(pkwnHome, "telegram-bindings.json");
  return {
    async get(chatId) {
      return (await readAll(path))[chatId];
    },
    async set(chatId, sessionId) {
      const all = await readAll(path);
      all[chatId] = sessionId;
      await writeFile(path, JSON.stringify(all, null, 2) + "\n", "utf8");
    },
    async clear(chatId) {
      const all = await readAll(path);
      delete all[chatId];
      await writeFile(path, JSON.stringify(all, null, 2) + "\n", "utf8");
    },
  };
}
