import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BackendId } from "./types.js";

export interface BackendConfig {
  maxConcurrency?: number;
  homeDir?: string;
  defaultModel?: string;
}

export interface PkwnConfig {
  pkwnHome: string;
  port: number;
  bindHost: string;
  apiKey?: string;
  defaultTurnTimeoutMs: number;
  maxTurnRetries: number;
  backends: Partial<Record<BackendId, BackendConfig>>;
}

const DEFAULTS: Omit<PkwnConfig, "pkwnHome"> = {
  port: 8787,
  bindHost: "127.0.0.1",
  defaultTurnTimeoutMs: 20 * 60 * 1000,
  maxTurnRetries: 2,
  backends: {},
};

function pkwnHome(): string {
  return process.env["PKWN_HOME"] ?? join(homedir(), ".pkwn");
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
