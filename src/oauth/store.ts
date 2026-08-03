// Local, per-backend OAuth credential storage — pkwn's own token vault,
// independent of whatever the vendor CLI (if even installed) caches for
// itself. Backed by SQLite (one `auth_credentials` row per backend), the
// same shape omp's auth-broker-gateway uses for its own credential vault:
// an audit trail (`disabled_cause`, `created_at`/`updated_at`) survives
// even when a token stops working, instead of the row just vanishing.
// pkwn's own OAuth clients still do every login/refresh themselves — this
// only changes where the result is kept.

import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BackendId } from "../types.js";

const BACKEND_IDS: BackendId[] = ["claude", "codex", "gemini"];

export interface StoredCredential {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; absent means "unknown expiry, refresh reactively on 401". */
  expiresAt?: number;
  /** Human-readable identity for status display (email, org, etc.). */
  identity?: string;
  /** Provider-specific extras a refresh/request needs (e.g. a ChatGPT
   * account id, or a Code Assist cloud project id) that don't fit the
   * generic fields above. */
  extra?: Record<string, unknown>;
  /** Set when a refresh/token-exchange definitively failed (revoked,
   * invalid_grant, etc.) — the row is kept rather than deleted, so
   * `auth status` can say *why* instead of just "not logged in". Cleared
   * automatically the next time `writeCredential` persists a fresh,
   * working token for this backend. */
  disabledCause?: string;
}

interface CredentialRow {
  data: string;
  disabled_cause: string | null;
}

const databases = new Map<string, DatabaseSync>();

function openDb(pkwnHome: string): DatabaseSync {
  const existing = databases.get(pkwnHome);
  if (existing) return existing;
  const db = new DatabaseSync(join(pkwnHome, "credentials.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS auth_credentials (
      provider TEXT PRIMARY KEY,
      credential_type TEXT NOT NULL DEFAULT 'oauth',
      data TEXT NOT NULL,
      disabled_cause TEXT,
      identity_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  databases.set(pkwnHome, db);
  return db;
}

/** One-time import from the pre-SQLite storage format (one plaintext
 * `<pkwnHome>/credentials/<backend>.json` file per backend) — otherwise a
 * real, still-valid login done before this storage migration would look
 * like "not logged in" forever after upgrading, silently discarding a
 * working token. Each legacy file is removed once imported; a failed
 * parse is skipped (left in place) rather than crashing startup. */
async function migrateLegacyJsonCredentials(sqlite: DatabaseSync, pkwnHome: string): Promise<void> {
  const dir = join(pkwnHome, "credentials");
  for (const backend of BACKEND_IDS) {
    const path = join(dir, `${backend}.json`);
    try {
      const raw = await readFile(path, "utf8");
      const legacy = JSON.parse(raw) as StoredCredential;
      const now = Date.now();
      sqlite
        .prepare(
          `INSERT INTO auth_credentials (provider, data, disabled_cause, identity_key, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?, ?)
           ON CONFLICT(provider) DO NOTHING`,
        )
        .run(backend, JSON.stringify({ ...legacy, disabledCause: undefined }), legacy.identity ?? null, now, now);
      await rm(path);
    } catch {
      // no legacy file for this backend, or it didn't parse — nothing to migrate
    }
  }
}

async function db(pkwnHome: string): Promise<DatabaseSync> {
  await mkdir(pkwnHome, { recursive: true, mode: 0o700 });
  const isNew = !databases.has(pkwnHome);
  const sqlite = openDb(pkwnHome);
  if (isNew) await migrateLegacyJsonCredentials(sqlite, pkwnHome);
  return sqlite;
}

export async function readCredential(pkwnHome: string, backend: BackendId): Promise<StoredCredential | undefined> {
  const row = (await db(pkwnHome)).prepare("SELECT data, disabled_cause FROM auth_credentials WHERE provider = ?").get(backend) as
    | CredentialRow
    | undefined;
  if (!row) return undefined;
  const cred = JSON.parse(row.data) as StoredCredential;
  if (row.disabled_cause) cred.disabledCause = row.disabled_cause;
  return cred;
}

export async function writeCredential(pkwnHome: string, backend: BackendId, cred: StoredCredential): Promise<void> {
  const { disabledCause, ...persisted } = cred;
  const now = Date.now();
  (await db(pkwnHome))
    .prepare(
      `INSERT INTO auth_credentials (provider, data, disabled_cause, identity_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         data = excluded.data, disabled_cause = excluded.disabled_cause,
         identity_key = excluded.identity_key, updated_at = excluded.updated_at`,
    )
    .run(backend, JSON.stringify(persisted), disabledCause ?? null, cred.identity ?? null, now, now);
}

/** Marks a credential as broken without discarding it — a refresh/exchange
 * definitively failed (revoked, `invalid_grant`, ...). Kept so `checkAuth`
 * can report *why* login is needed again, not just that it is. */
export async function disableCredential(pkwnHome: string, backend: BackendId, cause: string): Promise<void> {
  (await db(pkwnHome)).prepare("UPDATE auth_credentials SET disabled_cause = ?, updated_at = ? WHERE provider = ?").run(cause, Date.now(), backend);
}

export async function deleteCredential(pkwnHome: string, backend: BackendId): Promise<void> {
  (await db(pkwnHome)).prepare("DELETE FROM auth_credentials WHERE provider = ?").run(backend);
}

/** True once the access token is within `skewMs` of (or past) expiry, or
 * has no known expiry at all (treated as "refresh to be safe"). */
export function isExpiringSoon(cred: StoredCredential, skewMs = 60_000): boolean {
  if (cred.expiresAt === undefined) return false;
  return cred.expiresAt - Date.now() < skewMs;
}
