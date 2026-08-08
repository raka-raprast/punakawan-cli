#!/usr/bin/env node
import { createInterface } from "node:readline";
import { WebSocket } from "ws";
import { loadConfig, writeDefaultConfigIfMissing } from "./config.js";
import { BackendRegistry } from "./backends/registry.js";
import { SessionManager } from "./session-manager.js";
import { createApiServer } from "./api/server.js";
import { daemonBase, ensureDaemonRunning, isBackendId, loginBackend } from "./cli-shared.js";
import { runChatTui } from "./tui/index.js";
import { runTelegramGateway } from "./gateway/telegram.js";
import { Scheduler } from "./scheduler.js";

async function cmdDaemon(): Promise<void> {
  const config = await loadConfig();
  const registry = new BackendRegistry(config);
  const sessions = new SessionManager(config, registry);
  await sessions.init();
  const scheduler = new Scheduler(config, sessions);
  await scheduler.init();
  scheduler.start();
  const server = createApiServer(config, registry, sessions, scheduler);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.bindHost, resolve);
  });
  console.log(`pkwn daemon listening on http://${config.bindHost}:${config.port} (PKWN_HOME=${config.pkwnHome})`);
  if (!config.apiKey) {
    console.warn("warning: PKWN_API_KEY is unset — the API is unauthenticated (fine on 127.0.0.1 only).");
  }

  const shutdown = (signal: string) => {
    console.log(`received ${signal}, shutting down`);
    scheduler.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

async function cmdAuthStatus(): Promise<void> {
  const config = await loadConfig();
  const registry = new BackendRegistry(config);
  for (const backend of registry.list()) {
    const status = await backend.adapter.checkAuth(backend.homeDir);
    const flag = status.loggedIn ? "logged in" : "NOT logged in";
    console.log(`${backend.adapter.displayName.padEnd(14)} ${flag}${status.mode ? ` (${status.mode})` : ""}`);
    if (status.detail) console.log(`  ${status.detail}`);
  }
}

async function cmdGatewayTelegram(): Promise<void> {
  const config = await loadConfig();
  await runTelegramGateway(config);
}

/** Standalone `question()` for contexts with no chat TUI already attached
 * to stdin (top-level `pkwn auth login`). */
async function standalonePrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const { promise, resolve } = Promise.withResolvers<string>();
  rl.question(question, (answer) => {
    rl.close();
    resolve(answer);
  });
  return promise;
}

async function cmdAuthLogin(backendArg: string, homeDir?: string): Promise<void> {
  if (!isBackendId(backendArg)) {
    console.error(`unknown backend "${backendArg}" — expected claude | codex | gemini`);
    process.exitCode = 1;
    return;
  }
  const status = await loginBackend(backendArg, homeDir, standalonePrompt);
  console.log(status.loggedIn ? `${backendArg} logged in.` : `${backendArg} login failed${status.detail ? `: ${status.detail}` : ""}`);
  if (!status.loggedIn) process.exitCode = 1;
}

async function cmdSessionsList(): Promise<void> {
  const config = await loadConfig();
  const registry = new BackendRegistry(config);
  const sessions = new SessionManager(config, registry);
  await sessions.init();
  const list = sessions.list();
  for (const meta of list) {
    console.log(`${meta.id}  ${meta.backend.padEnd(7)} ${meta.status.padEnd(11)} ${meta.cwd}${meta.title ? `  — ${meta.title}` : ""}`);
  }
  if (list.length === 0) console.log("(no sessions)");
}

async function cmdSessionsSearch(query: string): Promise<void> {
  const config = await loadConfig();
  const registry = new BackendRegistry(config);
  const sessions = new SessionManager(config, registry);
  await sessions.init();
  const results = await sessions.search(query);
  if (results.length === 0) {
    console.log("(no matches)");
    return;
  }
  for (const r of results) {
    console.log(`${r.sessionId}  ${r.direction.padEnd(3)} ${r.ts}  ${r.snippet}`);
  }
}

async function cmdStatus(): Promise<void> {
  const config = await loadConfig();
  const { base, headers } = daemonBase(config);
  try {
    await ensureDaemonRunning(config);
    const health = await fetch(`${base}/healthz`, { headers }).then((r) => r.json());
    const auth = await fetch(`${base}/v1/auth/status`, { headers }).then((r) => r.json());
    console.log(JSON.stringify({ health, auth }, null, 2));
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  }
}

async function cmdSessionsStop(id: string): Promise<void> {
  const config = await loadConfig();
  const { base, headers } = daemonBase(config);
  try {
    await ensureDaemonRunning(config);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
    return;
  }
  const res = await fetch(`${base}/v1/sessions/${id}/stop`, { method: "POST", headers });
  console.log(await res.text());
  if (!res.ok) process.exitCode = 1;
}

async function cmdSessionsRm(id: string): Promise<void> {
  const config = await loadConfig();
  const { base, headers } = daemonBase(config);
  try {
    await ensureDaemonRunning(config);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
    return;
  }
  const res = await fetch(`${base}/v1/sessions/${id}`, { method: "DELETE", headers });
  console.log(await res.text());
  if (!res.ok) process.exitCode = 1;
}

async function cmdSchedulesList(): Promise<void> {
  const config = await loadConfig();
  const registry = new BackendRegistry(config);
  const sessions = new SessionManager(config, registry);
  await sessions.init();
  const scheduler = new Scheduler(config, sessions);
  await scheduler.init();
  const list = scheduler.list();
  if (list.length === 0) {
    console.log("(no schedules)");
    return;
  }
  for (const s of list) {
    console.log(`${s.id}  ${(s.enabled ? "enabled " : "disabled").padEnd(8)} ${s.cron.padEnd(13)} next=${s.nextFireAt}  ${s.backend}@${s.cwd}  ${s.prompt.slice(0, 50)}`);
  }
}

async function cmdSchedulesRun(id: string): Promise<void> {
  const config = await loadConfig();
  const { base, headers } = daemonBase(config);
  try {
    await ensureDaemonRunning(config);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
    return;
  }
  const res = await fetch(`${base}/v1/schedules/${id}/run`, { method: "POST", headers });
  console.log(await res.text());
  if (!res.ok) process.exitCode = 1;
}

async function cmdSchedulesRm(id: string): Promise<void> {
  const config = await loadConfig();
  const { base, headers } = daemonBase(config);
  try {
    await ensureDaemonRunning(config);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
    return;
  }
  const res = await fetch(`${base}/v1/schedules/${id}`, { method: "DELETE", headers });
  console.log(await res.text());
  if (!res.ok) process.exitCode = 1;
}

async function cmdSessionsAttach(id: string): Promise<void> {
  const config = await loadConfig();
  try {
    await ensureDaemonRunning(config);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
    return;
  }
  const url = new URL(`ws://${config.bindHost}:${config.port}/v1/sessions/${id}/attach`);
  if (config.apiKey) url.searchParams.set("token", config.apiKey);
  const ws = new WebSocket(url);
  ws.on("open", () => console.log(`attached to ${id} — type a message and press enter; Ctrl-D to detach`));
  ws.on("message", (raw) => console.log(raw.toString()));
  ws.on("close", (code, reason) => {
    console.log(`disconnected (${code} ${reason.toString()})`);
    process.exit(0);
  });
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) ws.send(JSON.stringify({ text }));
  });
  process.stdin.on("end", () => ws.close());
}

/** Bypasses the daemon entirely: runs exactly one real turn straight
 * against a backend adapter (a real OAuth-authenticated API call) and
 * prints every normalized event as it streams, without touching session
 * persistence or the HTTP API. */
async function cmdVerify(backendArg: string, prompt: string, cwd: string): Promise<void> {
  if (!isBackendId(backendArg)) {
    console.error(`unknown backend "${backendArg}" — expected claude | codex | gemini`);
    process.exitCode = 1;
    return;
  }
  const config = await loadConfig();
  const registry = new BackendRegistry(config);
  const backend = registry.get(backendArg);
  console.log(`running one real turn against ${backend.adapter.displayName} in ${cwd} ...\n`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.defaultTurnTimeoutMs);
  let ok = false;
  try {
    for await (const event of backend.adapter.runTurn({
      cwd,
      prompt,
      history: [],
      permission: "edit",
      homeDir: backend.homeDir,
      signal: controller.signal,
      timeoutMs: config.defaultTurnTimeoutMs,
    })) {
      console.log(JSON.stringify(event));
      if (event.type === "turn_complete") ok = event.ok;
    }
  } finally {
    clearTimeout(timer);
  }
  console.log(ok ? "\nOK — adapter call succeeded." : "\nFAILED — see events above.");
  if (!ok) process.exitCode = 1;
}

function printUsage(): void {
  console.log(
    [
      "usage: pkwn [command]",
      "  (no command)                  start the interactive chat TUI (same as `chat`)",
      "  chat                          start the interactive chat TUI — /connect, /model, /help once inside",
      "  daemon                        run the connector daemon in the foreground",
      "  init                          write a default ~/.pkwn/config.json",
      "  auth status                   show login state for every backend",
      "  auth login <backend> [dir]    run that backend's own login flow (optionally with an isolated home dir)",
      "  verify <backend> <prompt> [cwd]  run one real turn directly against a backend, bypassing the daemon",
      "  sessions list                 list persisted sessions",
      "  sessions search <text>        full-text search across every session's transcript",
      "  sessions attach <id>          attach to a session's live event stream over the daemon's API",
      "  sessions stop <id>            abort an in-flight turn on a running daemon",
      "  sessions rm <id>              delete a session from a running daemon",
      "  schedules list                 list cron-scheduled automations",
      "  schedules run <id>              fire a schedule immediately, out of band from its cron cadence",
      "  schedules rm <id>               delete a schedule from a running daemon",
      "  gateway telegram              run the Telegram messaging gateway in the foreground (see README for setup)",
      "  status                        query a running daemon's health + auth status",
      "  help                          show this list",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const [, , cmd, sub, ...rest] = process.argv;
  if (!cmd || cmd === "chat") return runChatTui();
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printUsage();
    return;
  }
  if (cmd === "daemon") return cmdDaemon();
  if (cmd === "init") {
    const path = await writeDefaultConfigIfMissing();
    console.log(`config at ${path}`);
    return;
  }
  if (cmd === "auth" && sub === "status") return cmdAuthStatus();
  if (cmd === "auth" && sub === "login") return cmdAuthLogin(rest[0] ?? "", rest[1]);
  if (cmd === "sessions" && sub === "list") return cmdSessionsList();
  if (cmd === "sessions" && sub === "search" && rest[0]) return cmdSessionsSearch(rest.join(" "));
  if (cmd === "sessions" && sub === "attach" && rest[0]) return cmdSessionsAttach(rest[0]);
  if (cmd === "sessions" && sub === "stop" && rest[0]) return cmdSessionsStop(rest[0]);
  if (cmd === "sessions" && sub === "rm" && rest[0]) return cmdSessionsRm(rest[0]);
  if (cmd === "schedules" && sub === "list") return cmdSchedulesList();
  if (cmd === "schedules" && sub === "run" && rest[0]) return cmdSchedulesRun(rest[0]);
  if (cmd === "schedules" && sub === "rm" && rest[0]) return cmdSchedulesRm(rest[0]);
  if (cmd === "verify" && sub && rest[0]) return cmdVerify(sub, rest[0], rest[1] ?? process.cwd());
  if (cmd === "status") return cmdStatus();
  if (cmd === "gateway" && sub === "telegram") return cmdGatewayTelegram();

  console.error(`unknown command "${cmd}"\n`);
  printUsage();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
  // `process.exitCode` alone only takes effect once the event loop
  // drains on its own — `daemon` starts the scheduler's interval timer
  // before attempting to bind its HTTP port, so a bind failure (e.g.
  // the EADDRINUSE race ensureDaemonRunning's own doc comment promises
  // "exits immediately") would otherwise leave an orphaned process
  // still running a second scheduler against the same schedules.db.
  process.exit(process.exitCode);
});
