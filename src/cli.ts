#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { WebSocket } from "ws";
import { loadConfig, writeDefaultConfigIfMissing } from "./config.js";
import { BackendRegistry } from "./backends/registry.js";
import { SessionManager } from "./session-manager.js";
import { createApiServer } from "./api/server.js";
import type { PkwnConfig } from "./config.js";
import type { AgentEvent, BackendId, PermissionTier } from "./types.js";

const HOME_ENV_VAR: Record<BackendId, string> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  gemini: "GEMINI_CLI_HOME",
};

function isBackendId(value: string): value is BackendId {
  return value === "claude" || value === "codex" || value === "gemini";
}

async function cmdDaemon(): Promise<void> {
  const config = await loadConfig();
  const registry = new BackendRegistry(config);
  const sessions = new SessionManager(config, registry);
  await sessions.init();
  const server = createApiServer(config, registry, sessions);

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

/** Login is always delegated to the backend's own CLI — this process never
 * touches OAuth tokens, it just gives the user a terminal to complete
 * whatever browser/device-code flow that CLI already implements. */
function loginCommand(backend: BackendId, env: NodeJS.ProcessEnv): { cmd: string; args: string[] } {
  switch (backend) {
    case "claude":
      return { cmd: "claude", args: ["auth", "login"] };
    case "codex":
      return { cmd: "codex", args: ["login"] };
    case "gemini":
      // gemini-cli has no dedicated login subcommand: any invocation without
      // cached credentials triggers its OAuth flow. NO_BROWSER forces the
      // paste-a-code path, which is what a headless VPS needs.
      env["NO_BROWSER"] = env["NO_BROWSER"] ?? "true";
      return { cmd: "gemini", args: [] };
  }
}

async function cmdAuthLogin(backendArg: string, homeDir?: string): Promise<void> {
  if (!isBackendId(backendArg)) {
    console.error(`unknown backend "${backendArg}" — expected claude | codex | gemini`);
    process.exitCode = 1;
    return;
  }
  const env = { ...process.env };
  if (homeDir) env[HOME_ENV_VAR[backendArg]] = homeDir;
  const { cmd, args } = loginCommand(backendArg, env);

  console.log(`launching: ${cmd} ${args.join(" ")}${homeDir ? ` (${HOME_ENV_VAR[backendArg]}=${homeDir})` : ""}`);
  const child = spawn(cmd, args, { stdio: "inherit", env });
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
}

async function cmdSessionsList(): Promise<void> {
  const config = await loadConfig();
  const registry = new BackendRegistry(config);
  const sessions = new SessionManager(config, registry);
  await sessions.init();
  const list = sessions.list();
  for (const meta of list) {
    console.log(`${meta.id}  ${meta.backend.padEnd(7)} ${meta.status.padEnd(11)} ${meta.cwd}`);
  }
  if (list.length === 0) console.log("(no sessions)");
}

function daemonBase(config: PkwnConfig): { base: string; headers: Record<string, string> } {
  return {
    base: `http://${config.bindHost}:${config.port}`,
    headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
  };
}

interface SessionMetaResponse {
  id: string;
  backend: BackendId;
  cwd: string;
  model?: string;
  permission: PermissionTier;
  status: string;
}
interface SessionListResponse {
  sessions: SessionMetaResponse[];
}

/** Thin typed fetch wrapper for the REPL's daemon calls. `Response.json()`
 * is untyped by the fetch spec — this is the one place that boundary is
 * cast, with each call site naming the shape it expects. */
async function apiRequest<T>(config: PkwnConfig, method: string, path: string, body?: unknown): Promise<T> {
  const { base, headers } = daemonBase(config);
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { ...headers, "content-type": "application/json" } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // not JSON — fall back to the raw response text
    }
    throw new Error(`${method} ${path} -> ${res.status}: ${message}`);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

async function cmdStatus(): Promise<void> {
  const { base, headers } = daemonBase(await loadConfig());
  try {
    const health = await fetch(`${base}/healthz`, { headers }).then((r) => r.json());
    const auth = await fetch(`${base}/v1/auth/status`, { headers }).then((r) => r.json());
    console.log(JSON.stringify({ health, auth }, null, 2));
  } catch (err) {
    console.error(`could not reach daemon at ${base}: ${String(err)}`);
    process.exitCode = 1;
  }
}

async function cmdSessionsStop(id: string): Promise<void> {
  const { base, headers } = daemonBase(await loadConfig());
  const res = await fetch(`${base}/v1/sessions/${id}/stop`, { method: "POST", headers });
  console.log(await res.text());
  if (!res.ok) process.exitCode = 1;
}

async function cmdSessionsRm(id: string): Promise<void> {
  const { base, headers } = daemonBase(await loadConfig());
  const res = await fetch(`${base}/v1/sessions/${id}`, { method: "DELETE", headers });
  console.log(await res.text());
  if (!res.ok) process.exitCode = 1;
}

async function cmdSessionsAttach(id: string): Promise<void> {
  const config = await loadConfig();
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

/** The `omp`/`hermes`-style entry point: an interactive REPL, backed by an
 * already-running daemon (never spawns one itself — daemon lifecycle stays
 * systemd's job, not a REPL's, so we never risk a second/orphaned daemon).
 * Plain lines are sent as messages to the active session; `/`-prefixed
 * lines are commands (`/connect`, `/model`, ...). */
async function cmdChat(): Promise<void> {
  const config = await loadConfig();
  const { base, headers } = daemonBase(config);

  try {
    const res = await fetch(`${base}/healthz`, { headers, signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`unexpected status ${res.status}`);
  } catch (err) {
    console.error(`could not reach the pkwn daemon at ${base}: ${String(err)}`);
    console.error("start it first — foreground: `pkwn daemon`   production: `systemctl start pkwn@$(whoami)`");
    process.exitCode = 1;
    return;
  }

  let activeId: string | undefined;
  let ws: WebSocket | undefined;
  let printedLen = 0;
  let streaming = false;

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "pkwn> ", terminal: true });

  const printLine = (text: string): void => {
    if (streaming) process.stdout.write("\n");
    streaming = false;
    console.log(text);
  };

  const handleEvent = (event: AgentEvent): void => {
    switch (event.type) {
      case "text": {
        const delta = event.text.slice(printedLen);
        if (delta) {
          process.stdout.write(delta);
          printedLen = event.text.length;
          streaming = true;
        }
        break;
      }
      case "tool_call":
        printLine(`  → ${event.name}(${JSON.stringify(event.input).slice(0, 200)})`);
        break;
      case "tool_result":
        printLine(event.isError ? `  ✗ tool error: ${event.error ?? "unknown"}` : "  ✓ tool result");
        break;
      case "warning":
        printLine(`! ${event.message}`);
        break;
      case "error":
        printLine(`! error (${event.kind}): ${event.message}`);
        break;
      case "turn_complete":
        if (streaming) process.stdout.write("\n");
        streaming = false;
        printedLen = 0;
        rl.prompt();
        break;
      case "reasoning":
      case "usage":
      case "started":
        break;
    }
  };

  const connectWs = (id: string): void => {
    ws?.removeAllListeners();
    ws?.close();
    const wsUrl = new URL(`ws://${config.bindHost}:${config.port}/v1/sessions/${id}/attach`);
    if (config.apiKey) wsUrl.searchParams.set("token", config.apiKey);
    ws = new WebSocket(wsUrl);
    ws.on("message", (raw) => {
      try {
        handleEvent(JSON.parse(raw.toString()) as AgentEvent);
      } catch {
        // ignore malformed frames rather than crashing the REPL
      }
    });
    ws.on("error", (err) => printLine(`! connection error: ${String(err)}`));
  };

  const printHelp = (): void => {
    console.log(
      [
        "/connect <claude|codex|gemini> [cwd] [model]   start a new session",
        "/model [model-id]                               show, or set, the active session's model",
        "/permission [safe|edit|full]                    show, or set, the active session's permission tier",
        "/new                                             fresh conversation, same backend/cwd/model",
        "/switch <session-id>                             attach to an existing session",
        "/sessions                                        list sessions (* marks the active one)",
        "/stop                                            abort the active session's in-flight turn",
        "/rm [session-id]                                 delete a session (defaults to active)",
        "/help                                            show this list",
        "/exit, /quit                                     leave (Ctrl-D also works)",
      ].join("\n"),
    );
  };

  const requireActive = (): string | undefined => {
    if (activeId) return activeId;
    console.log("no active session — /connect <claude|codex|gemini> [cwd] first");
    return undefined;
  };

  const handleCommand = async (line: string): Promise<void> => {
    const [cmd, ...args] = line.slice(1).split(/\s+/);
    try {
      switch (cmd) {
        case "connect": {
          const backend = args[0] ?? "";
          if (!isBackendId(backend)) {
            console.log("usage: /connect <claude|codex|gemini> [cwd] [model]");
            break;
          }
          const cwd = args[1] ?? process.cwd();
          const model = args[2];
          const meta = await apiRequest<SessionMetaResponse>(config, "POST", "/v1/sessions", { backend, cwd, model });
          activeId = meta.id;
          printedLen = 0;
          connectWs(meta.id);
          console.log(`connected — session ${meta.id} (${backend} @ ${cwd}${model ? `, model=${model}` : ""})`);
          break;
        }
        case "model": {
          const id = requireActive();
          if (!id) break;
          if (!args[0]) {
            const meta = await apiRequest<SessionMetaResponse>(config, "GET", `/v1/sessions/${id}`);
            console.log(`current model: ${meta.model ?? "(backend default)"}`);
            break;
          }
          const meta = await apiRequest<SessionMetaResponse>(config, "PATCH", `/v1/sessions/${id}`, { model: args[0] });
          console.log(`model set to ${meta.model}`);
          break;
        }
        case "permission": {
          const id = requireActive();
          if (!id) break;
          if (!args[0]) {
            const meta = await apiRequest<SessionMetaResponse>(config, "GET", `/v1/sessions/${id}`);
            console.log(`current permission: ${meta.permission}`);
            break;
          }
          if (args[0] !== "safe" && args[0] !== "edit" && args[0] !== "full") {
            console.log("usage: /permission <safe|edit|full>");
            break;
          }
          const meta = await apiRequest<SessionMetaResponse>(config, "PATCH", `/v1/sessions/${id}`, { permission: args[0] });
          console.log(`permission set to ${meta.permission}`);
          break;
        }
        case "new": {
          const id = requireActive();
          if (!id) break;
          const current = await apiRequest<SessionMetaResponse>(config, "GET", `/v1/sessions/${id}`);
          const meta = await apiRequest<SessionMetaResponse>(config, "POST", "/v1/sessions", {
            backend: current.backend,
            cwd: current.cwd,
            model: current.model,
            permission: current.permission,
          });
          activeId = meta.id;
          printedLen = 0;
          connectWs(meta.id);
          console.log(`started a fresh conversation — session ${meta.id}`);
          break;
        }
        case "switch": {
          if (!args[0]) {
            console.log("usage: /switch <session-id>");
            break;
          }
          const meta = await apiRequest<SessionMetaResponse>(config, "GET", `/v1/sessions/${args[0]}`);
          activeId = meta.id;
          printedLen = 0;
          connectWs(meta.id);
          console.log(`switched to session ${meta.id} (${meta.backend} @ ${meta.cwd})`);
          break;
        }
        case "sessions": {
          const { sessions: list } = await apiRequest<SessionListResponse>(config, "GET", "/v1/sessions");
          if (list.length === 0) {
            console.log("(no sessions)");
            break;
          }
          for (const s of list) {
            console.log(`${s.id === activeId ? "*" : " "} ${s.id}  ${s.backend.padEnd(7)} ${s.status.padEnd(11)} ${s.cwd}`);
          }
          break;
        }
        case "stop": {
          const id = requireActive();
          if (!id) break;
          await apiRequest(config, "POST", `/v1/sessions/${id}/stop`);
          console.log("stop requested");
          break;
        }
        case "rm": {
          const target = args[0] ?? activeId;
          if (!target) {
            console.log("usage: /rm [session-id]");
            break;
          }
          await apiRequest(config, "DELETE", `/v1/sessions/${target}`);
          if (target === activeId) {
            activeId = undefined;
            ws?.close();
            ws = undefined;
          }
          console.log(`deleted ${target}`);
          break;
        }
        case "help":
          printHelp();
          break;
        case "exit":
        case "quit":
          rl.close();
          return;
        default:
          console.log(`unknown command /${cmd} — try /help`);
      }
    } catch (err) {
      console.log(`! ${err instanceof Error ? err.message : String(err)}`);
    }
    rl.prompt();
  };

  rl.on("line", (raw) => {
    const line = raw.trim();
    if (!line) {
      rl.prompt();
      return;
    }
    if (line.startsWith("/")) {
      void handleCommand(line);
      return;
    }
    if (!ws || !activeId) {
      console.log("no active session — /connect <claude|codex|gemini> [cwd] first (try /help)");
      rl.prompt();
      return;
    }
    printedLen = 0;
    ws.send(JSON.stringify({ text: line }));
    // No rl.prompt() here — turn_complete redraws it once the reply finishes
    // streaming, so an empty prompt line doesn't interrupt the live output.
  });
  rl.on("close", () => {
    ws?.close();
    process.exit(0);
  });

  console.log("pkwn — connected. /connect <claude|codex|gemini> [cwd] to start, /help for commands, Ctrl-D to exit.");
  rl.prompt();
}

/** Bypasses the daemon entirely: runs exactly one real turn straight
 * against a backend adapter and prints every normalized event as it
 * streams. This is the fast way to check that a freshly-installed CLI's
 * actual output still matches what the adapter expects, without touching
 * session persistence or the HTTP API. */
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
  console.log(ok ? "\nOK — adapter parsing matched real CLI output." : "\nFAILED — see events above.");
  if (!ok) process.exitCode = 1;
}

function printUsage(): void {
  console.log(
    [
      "usage: pkwn [command]",
      "  (no command)                  start the interactive chat REPL (same as `chat`)",
      "  chat                          start the interactive chat REPL — /connect, /model, /help once inside",
      "  daemon                        run the connector daemon in the foreground",
      "  init                          write a default ~/.pkwn/config.json",
      "  auth status                   show login state for every backend",
      "  auth login <backend> [dir]    run that backend's own login flow (optionally with an isolated home dir)",
      "  verify <backend> <prompt> [cwd]  run one real turn directly against a backend, bypassing the daemon",
      "  sessions list                 list persisted sessions",
      "  sessions attach <id>          attach to a session's live event stream over the daemon's API",
      "  sessions stop <id>            abort an in-flight turn on a running daemon",
      "  sessions rm <id>              delete a session from a running daemon",
      "  status                        query a running daemon's health + auth status",
      "  help                          show this list",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const [, , cmd, sub, ...rest] = process.argv;
  if (!cmd || cmd === "chat") return cmdChat();
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
  if (cmd === "sessions" && sub === "attach" && rest[0]) return cmdSessionsAttach(rest[0]);
  if (cmd === "sessions" && sub === "stop" && rest[0]) return cmdSessionsStop(rest[0]);
  if (cmd === "sessions" && sub === "rm" && rest[0]) return cmdSessionsRm(rest[0]);
  if (cmd === "verify" && sub && rest[0]) return cmdVerify(sub, rest[0], rest[1] ?? process.cwd());
  if (cmd === "status") return cmdStatus();

  console.error(`unknown command "${cmd}"\n`);
  printUsage();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
