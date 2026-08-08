import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BackendId, PermissionTier } from "./types.js";

export interface BackendConfig {
  maxConcurrency?: number;
  homeDir?: string;
  defaultModel?: string;
}

/** Config for the Telegram messaging gateway (`pkwn gateway telegram`).
 * Deny-by-default: an empty/unset `allowedChatIds` means the gateway
 * still runs (so you can message it to learn your own chat id) but
 * forwards nothing to any backend — a publicly-discoverable Telegram bot
 * wired to a shell-executing agent must never be open by default. */
export interface TelegramGatewayConfig {
  botToken?: string;
  allowedChatIds?: string[];
  backend?: BackendId;
  cwd?: string;
  permission?: PermissionTier;
  /** HTTP/HTTPS CONNECT proxy the gateway's Telegram Bot API calls tunnel
   * through (e.g. `http://100.x.y.z:8888`, a Tailscale peer running a
   * plain forward proxy) — for a network where the gateway's own egress
   * to `api.telegram.org` is blocked/throttled but the daemon and every
   * other outbound call the gateway makes (the daemon's own HTTP API)
   * still needs to go direct, so this is scoped to just the Telegram
   * client rather than a machine-wide proxy/exit-node setting. */
  proxyUrl?: string;
}

export interface PkwnConfig {
  pkwnHome: string;
  port: number;
  bindHost: string;
  apiKey?: string;
  defaultTurnTimeoutMs: number;
  maxTurnRetries: number;
  backends: Partial<Record<BackendId, BackendConfig>>;
  telegram?: TelegramGatewayConfig;
}

const DEFAULTS: Omit<PkwnConfig, "pkwnHome"> = {
  port: 8787,
  bindHost: "127.0.0.1",
  defaultTurnTimeoutMs: 20 * 60 * 1000,
  maxTurnRetries: 2,
  backends: {},
};

export function pkwnHome(): string {
  return process.env["PKWN_HOME"] ?? join(homedir(), ".pkwn");
}

/** Merges the `telegram` block of `config.json` with its env-var
 * overrides. Absent both, `botToken` stays undefined and
 * `cmdGatewayTelegram` refuses to start rather than silently doing
 * nothing — same "fail loud, not open" posture as the bind-host/API-key
 * check below. Validation of `backend`/`permission` enum values and
 * `cwd` presence is the gateway's job at startup, not the config
 * loader's — this function only merges, it never rejects. */
function loadTelegramConfig(fileValue: TelegramGatewayConfig | undefined): TelegramGatewayConfig | undefined {
  const allowedChatIdsEnv = process.env["PKWN_TELEGRAM_ALLOWED_CHAT_IDS"];
  const telegram: TelegramGatewayConfig = {
    botToken: process.env["PKWN_TELEGRAM_BOT_TOKEN"] ?? fileValue?.botToken,
    allowedChatIds: allowedChatIdsEnv
      ? allowedChatIdsEnv
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
      : fileValue?.allowedChatIds,
    backend: (process.env["PKWN_TELEGRAM_BACKEND"] as BackendId | undefined) ?? fileValue?.backend,
    cwd: process.env["PKWN_TELEGRAM_CWD"] ?? fileValue?.cwd,
    permission: (process.env["PKWN_TELEGRAM_PERMISSION"] as PermissionTier | undefined) ?? fileValue?.permission,
    proxyUrl: process.env["PKWN_TELEGRAM_PROXY_URL"] ?? fileValue?.proxyUrl,
  };
  const hasAnySetting = Object.values(telegram).some((v) => v !== undefined);
  return hasAnySetting ? telegram : undefined;
}

export async function loadConfig(): Promise<PkwnConfig> {
  const home = pkwnHome();
  await mkdir(home, { recursive: true });
  const configPath = join(home, "config.json");

  let fileConfig: Partial<PkwnConfig> = {};
  try {
    fileConfig = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    // No config file yet — fine, defaults + env vars apply.
  }

  const config: PkwnConfig = {
    pkwnHome: home,
    port: Number(process.env["PKWN_PORT"] ?? fileConfig.port ?? DEFAULTS.port),
    bindHost: process.env["PKWN_BIND_HOST"] ?? fileConfig.bindHost ?? DEFAULTS.bindHost,
    apiKey: process.env["PKWN_API_KEY"] ?? fileConfig.apiKey,
    defaultTurnTimeoutMs: Number(
      process.env["PKWN_TURN_TIMEOUT_MS"] ?? fileConfig.defaultTurnTimeoutMs ?? DEFAULTS.defaultTurnTimeoutMs,
    ),
    maxTurnRetries: Number(process.env["PKWN_MAX_RETRIES"] ?? fileConfig.maxTurnRetries ?? DEFAULTS.maxTurnRetries),
    backends: fileConfig.backends ?? {},
    telegram: loadTelegramConfig(fileConfig.telegram),
  };

  if (config.bindHost !== "127.0.0.1" && config.bindHost !== "localhost" && !config.apiKey) {
    throw new Error(
      `refusing to bind to ${config.bindHost} without PKWN_API_KEY set — a VPS-reachable daemon must require a bearer token. ` +
        `Set PKWN_API_KEY (env or ${configPath}) or bind to 127.0.0.1 and put it behind an authenticated reverse proxy / SSH tunnel.`,
    );
  }

  return config;
}

export async function writeDefaultConfigIfMissing(): Promise<string> {
  const home = pkwnHome();
  await mkdir(home, { recursive: true });
  const configPath = join(home, "config.json");
  try {
    await readFile(configPath, "utf8");
    return configPath;
  } catch {
    const scaffold: Partial<PkwnConfig> = {
      port: DEFAULTS.port,
      bindHost: DEFAULTS.bindHost,
      defaultTurnTimeoutMs: DEFAULTS.defaultTurnTimeoutMs,
      maxTurnRetries: DEFAULTS.maxTurnRetries,
      backends: {
        claude: {},
        codex: { maxConcurrency: 1 },
        gemini: {},
      },
    };
    await writeFile(configPath, JSON.stringify(scaffold, null, 2) + "\n", "utf8");
    return configPath;
  }
}
