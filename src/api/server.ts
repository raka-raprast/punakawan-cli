import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { PkwnConfig } from "../config.js";
import type { BackendRegistry } from "../backends/registry.js";
import { SessionManager } from "../session-manager.js";
import type { Scheduler, ScheduleInput, SchedulePatch } from "../scheduler.js";
import { loadSkills } from "../skills.js";
import { Router, type RouteContext } from "./router.js";
import { HttpError, readJsonBody, sendJson, SseWriter } from "./http-utils.js";
import type { AgentEvent, BackendId, PermissionTier } from "../types.js";

const PERMISSION_TIERS = new Set(["safe", "edit", "full"]);
const BACKEND_IDS = new Set<BackendId>(["claude", "codex", "gemini"]);

function isBackendId(value: unknown): value is BackendId {
  return typeof value === "string" && BACKEND_IDS.has(value as BackendId);
}

function isPermissionTier(value: unknown): value is PermissionTier {
  return typeof value === "string" && PERMISSION_TIERS.has(value);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Extract the text a user actually typed from an OpenAI-shaped message content field. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part["text"] === "string" ? part["text"] : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function buildPrompt(messages: unknown[], includeHistory: boolean): string {
  const nonSystem = messages.filter((m) => isRecord(m) && m["role"] !== "system");
  if (!includeHistory || nonSystem.length <= 1) {
    const lastUser = [...messages].reverse().find((m) => isRecord(m) && m["role"] === "user");
    return isRecord(lastUser) ? messageText(lastUser["content"]) : "";
  }
  // The backend has no memory of this being a *first* turn beyond what we
  // send it, so with real multi-message history we fold every prior
  // user/assistant turn into one role-labeled prompt. A lone message needs
  // no such framing — send its text verbatim.
  const lines: string[] = [];
  for (const m of nonSystem) {
    if (!isRecord(m)) continue;
    const text = messageText(m["content"]);
    if (!text) continue;
    lines.push(`[${m["role"]}] ${text}`);
  }
  return lines.join("\n\n");
}

export function createApiServer(config: PkwnConfig, registry: BackendRegistry, sessions: SessionManager, scheduler?: Scheduler): Server {
  const router = new Router();
  registerRoutes(router, registry, sessions, config, scheduler);

  const server = createServer((req, res) => {
    handleRequest(config, router, req, res).catch((err) => {
      if (!res.headersSent) {
        const status = err instanceof HttpError ? err.status : 500;
        sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
      }
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://internal");
    const match = /^\/v1\/sessions\/([^/]+)\/attach$/.exec(url.pathname);
    if (!match) {
      socket.destroy();
      return;
    }
    if (!authorize(config, req, url)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const sessionId = decodeURIComponent(match[1]!);
    wss.handleUpgrade(req, socket, head, (ws) => attachSocket(ws, sessionId, sessions));
  });

  return server;
}

function authorize(config: PkwnConfig, req: IncomingMessage, url: URL): boolean {
  if (!config.apiKey) return true;
  const header = req.headers["authorization"];
  const bearer = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;
  const queryToken = url.searchParams.get("token") ?? undefined;
  return bearer === config.apiKey || queryToken === config.apiKey;
}

async function handleRequest(
  config: PkwnConfig,
  router: Router,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://internal");
  if (url.pathname !== "/healthz" && !authorize(config, req, url)) {
    sendJson(res, 401, { error: "missing or invalid bearer token" });
    return;
  }
  const match = router.match(req.method ?? "GET", url.pathname);
  if (!match) {
    sendJson(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
    return;
  }
  const ctx: RouteContext = { req, res, params: match.params, query: url.searchParams };
  await match.handler(ctx);
}

function attachSocket(ws: WebSocket, sessionId: string, sessions: SessionManager): void {
  if (!sessions.get(sessionId)) {
    ws.close(4404, "no such session");
    return;
  }
  const unsubscribe = sessions.subscribe(sessionId, (event: AgentEvent) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  });
  ws.on("message", (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed frame
    }
    if (!isRecord(parsed)) return;

    if (typeof parsed["askId"] === "string" && Array.isArray(parsed["answer"])) {
      const answer = parsed["answer"].filter((v): v is string => typeof v === "string");
      sessions.answerAsk(sessionId, parsed["askId"], answer);
      return;
    }

    if (typeof parsed["text"] === "string") {
      sessions.sendMessage(sessionId, parsed["text"]).catch((err) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "error", kind: "crash", message: String(err), retryable: false }));
        }
      });
    }
  });
  ws.on("close", () => {
    unsubscribe();
    sessions.cancelPendingAsks(sessionId);
  });
}

function registerRoutes(
  router: Router,
  registry: BackendRegistry,
  sessions: SessionManager,
  config: PkwnConfig,
  scheduler?: Scheduler,
): void {
  router.get("/healthz", (ctx) => {
    sendJson(ctx.res, 200, { ok: true, uptimeSec: process.uptime(), sessions: sessions.list().length });
  });

  router.get("/v1/models", (ctx) => {
    sendJson(ctx.res, 200, {
      object: "list",
      data: registry.list().map((b) => ({
        id: b.adapter.id,
        object: "model",
        owned_by: b.adapter.displayName,
        note: "pass a concrete model id as '<backend>:<model>', e.g. 'claude:sonnet' or 'codex:gpt-5.1-codex'",
      })),
    });
  });

  router.get("/v1/backends/:backend/models", async (ctx) => {
    const id = ctx.params["backend"];
    if (!isBackendId(id)) throw new HttpError(400, `unknown backend "${id}" — expected claude | codex | gemini`);
    const backend = registry.get(id);
    const models = await backend.adapter.listModels(backend.homeDir);
    sendJson(ctx.res, 200, { models });
  });

  router.get("/v1/auth/status", async (ctx) => {
    const statuses = await Promise.all(registry.list().map((b) => b.adapter.checkAuth(b.homeDir)));
    sendJson(ctx.res, 200, { backends: statuses });
  });

  router.get("/v1/skills", async (ctx) => {
    const cwd = ctx.query.get("cwd");
    if (!cwd) throw new HttpError(400, "expected ?cwd=<path>");
    const skills = await loadSkills(config.pkwnHome, cwd);
    sendJson(ctx.res, 200, { skills: skills.map((s) => ({ name: s.name, description: s.description, scope: s.scope })) });
  });

  router.post("/v1/sessions", async (ctx) => {
    const body = await readJsonBody(ctx.req);
    if (!isRecord(body) || !isBackendId(body["backend"]) || typeof body["cwd"] !== "string") {
      throw new HttpError(400, "expected { backend: 'claude'|'codex'|'gemini', cwd: string, model?, permission? }");
    }
    if (body["permission"] !== undefined && !isPermissionTier(body["permission"])) {
      throw new HttpError(400, "permission must be one of 'safe' | 'edit' | 'full'");
    }
    const meta = await sessions.create({
      backend: body["backend"],
      cwd: body["cwd"],
      model: typeof body["model"] === "string" ? body["model"] : undefined,
      permission: body["permission"] as PermissionTier | undefined,
    });
    sendJson(ctx.res, 201, meta);
  });

  router.get("/v1/sessions", (ctx) => {
    sendJson(ctx.res, 200, { sessions: sessions.list() });
  });

  router.get("/v1/sessions/search", async (ctx) => {
    const q = ctx.query.get("q");
    if (!q) throw new HttpError(400, "expected ?q=<search text>");
    const limit = Number(ctx.query.get("limit") ?? 20);
    sendJson(ctx.res, 200, { results: await sessions.search(q, limit) });
  });

  router.get("/v1/sessions/:id", async (ctx) => {
    const meta = sessions.get(ctx.params["id"]!);
    if (!meta) throw new HttpError(404, "no such session");
    const tail = Number(ctx.query.get("tail") ?? 50);
    sendJson(ctx.res, 200, { ...meta, transcriptTail: await sessions.transcriptTail(meta.id, tail) });
  });

  router.delete("/v1/sessions/:id", async (ctx) => {
    const id = ctx.params["id"]!;
    if (!sessions.get(id)) throw new HttpError(404, "no such session");
    await sessions.remove(id);
    sendJson(ctx.res, 200, { ok: true });
  });

  router.patch("/v1/sessions/:id", async (ctx) => {
    const id = ctx.params["id"]!;
    if (!sessions.get(id)) throw new HttpError(404, "no such session");
    const body = await readJsonBody(ctx.req);
    if (!isRecord(body)) throw new HttpError(400, "expected a JSON object body");
    if (body["model"] !== undefined && typeof body["model"] !== "string") {
      throw new HttpError(400, "model must be a string");
    }
    if (body["permission"] !== undefined && !isPermissionTier(body["permission"])) {
      throw new HttpError(400, "permission must be one of 'safe' | 'edit' | 'full'");
    }
    const meta = await sessions.update(id, {
      model: body["model"] as string | undefined,
      permission: body["permission"] as PermissionTier | undefined,
    });
    sendJson(ctx.res, 200, meta);
  });

  router.post("/v1/sessions/:id/stop", (ctx) => {
    const stopped = sessions.stop(ctx.params["id"]!);
    sendJson(ctx.res, 200, { stopped });
  });

  router.post("/v1/sessions/:id/messages", async (ctx) => {
    const id = ctx.params["id"]!;
    if (!sessions.get(id)) throw new HttpError(404, "no such session");
    const body = await readJsonBody(ctx.req);
    if (!isRecord(body) || typeof body["text"] !== "string") {
      throw new HttpError(400, "expected { text: string }");
    }

    if (ctx.query.get("stream") === "1") {
      const sse = new SseWriter(ctx.res);
      const unsubscribe = sessions.subscribe(id, (event) => sse.send(event));
      try {
        const result = await sessions.sendMessage(id, body["text"]);
        sse.send({ type: "done", ok: result.ok, finalText: result.finalText }, "done");
      } finally {
        unsubscribe();
        sse.close();
      }
      return;
    }

    const result = await sessions.sendMessage(id, body["text"]);
    sendJson(ctx.res, 200, result);
  });

  router.post("/v1/chat/completions", (ctx) => handleChatCompletions(ctx, registry, sessions, config));
  if (scheduler) registerScheduleRoutes(router, scheduler);
}

function registerScheduleRoutes(router: Router, scheduler: Scheduler): void {
  router.post("/v1/schedules", async (ctx) => {
    const body = await readJsonBody(ctx.req);
    if (!isRecord(body) || typeof body["cron"] !== "string" || typeof body["prompt"] !== "string" || !isBackendId(body["backend"]) || typeof body["cwd"] !== "string") {
      throw new HttpError(400, "expected { cron, prompt, backend: 'claude'|'codex'|'gemini', cwd, model?, permission?, sessionId?, notifyTelegramChatId?, enabled? }");
    }
    if (body["permission"] !== undefined && !isPermissionTier(body["permission"])) {
      throw new HttpError(400, "permission must be one of 'safe' | 'edit' | 'full'");
    }
    const input: ScheduleInput = {
      cron: body["cron"],
      prompt: body["prompt"],
      backend: body["backend"],
      cwd: body["cwd"],
      model: typeof body["model"] === "string" ? body["model"] : undefined,
      permission: body["permission"] as PermissionTier | undefined,
      sessionId: typeof body["sessionId"] === "string" ? body["sessionId"] : undefined,
      notifyTelegramChatId: typeof body["notifyTelegramChatId"] === "string" ? body["notifyTelegramChatId"] : undefined,
      enabled: typeof body["enabled"] === "boolean" ? body["enabled"] : undefined,
    };
    try {
      sendJson(ctx.res, 201, await scheduler.create(input));
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
  });

  router.get("/v1/schedules", (ctx) => {
    sendJson(ctx.res, 200, { schedules: scheduler.list() });
  });

  router.get("/v1/schedules/:id", (ctx) => {
    const meta = scheduler.get(ctx.params["id"]!);
    if (!meta) throw new HttpError(404, "no such schedule");
    sendJson(ctx.res, 200, meta);
  });

  router.patch("/v1/schedules/:id", async (ctx) => {
    const id = ctx.params["id"]!;
    if (!scheduler.get(id)) throw new HttpError(404, "no such schedule");
    const body = await readJsonBody(ctx.req);
    if (!isRecord(body)) throw new HttpError(400, "expected a JSON object body");
    if (body["permission"] !== undefined && !isPermissionTier(body["permission"])) {
      throw new HttpError(400, "permission must be one of 'safe' | 'edit' | 'full'");
    }
    const patch: SchedulePatch = {
      cron: typeof body["cron"] === "string" ? body["cron"] : undefined,
      prompt: typeof body["prompt"] === "string" ? body["prompt"] : undefined,
      model: typeof body["model"] === "string" ? body["model"] : undefined,
      permission: body["permission"] as PermissionTier | undefined,
      notifyTelegramChatId: typeof body["notifyTelegramChatId"] === "string" ? body["notifyTelegramChatId"] : undefined,
      enabled: typeof body["enabled"] === "boolean" ? body["enabled"] : undefined,
    };
    try {
      sendJson(ctx.res, 200, await scheduler.update(id, patch));
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
  });

  router.delete("/v1/schedules/:id", async (ctx) => {
    const id = ctx.params["id"]!;
    if (!scheduler.get(id)) throw new HttpError(404, "no such schedule");
    await scheduler.remove(id);
    sendJson(ctx.res, 200, { ok: true });
  });

  router.post("/v1/schedules/:id/run", async (ctx) => {
    const id = ctx.params["id"]!;
    if (!scheduler.get(id)) throw new HttpError(404, "no such schedule");
    sendJson(ctx.res, 200, await scheduler.runNow(id));
  });
}

async function handleChatCompletions(
  ctx: RouteContext,
  registry: BackendRegistry,
  sessions: SessionManager,
  config: PkwnConfig,
): Promise<void> {
  const body = await readJsonBody(ctx.req);
  if (!isRecord(body) || typeof body["model"] !== "string" || !Array.isArray(body["messages"])) {
    throw new HttpError(400, "expected OpenAI-shaped { model: '<backend>:<model>', messages: [...] }");
  }
  const sep = body["model"].indexOf(":");
  if (sep < 0 || !isBackendId(body["model"].slice(0, sep))) {
    throw new HttpError(400, "model must be '<backend>:<model-id>', e.g. 'claude:sonnet'");
  }
  const backend = body["model"].slice(0, sep) as BackendId;
  const modelId = body["model"].slice(sep + 1) || undefined;
  registry.get(backend); // validates existence

  const existingId = typeof body["session_id"] === "string" ? body["session_id"] : undefined;
  let sessionId: string;
  if (existingId) {
    if (!sessions.get(existingId)) throw new HttpError(404, `no such session_id ${existingId}`);
    sessionId = existingId;
  } else {
    if (typeof body["cwd"] !== "string") {
      throw new HttpError(400, "cwd is required to start a new session (or pass an existing session_id)");
    }
    const permission = isPermissionTier(body["permission"]) ? body["permission"] : undefined;
    const meta = await sessions.create({ backend, cwd: body["cwd"], model: modelId, permission });
    sessionId = meta.id;
  }

  const prompt = buildPrompt(body["messages"], !existingId);
  const model = body["model"];
  const ephemeral = body["ephemeral"] === true;

  if (body["stream"] === true) {
    await streamChatCompletion(ctx, sessions, sessionId, prompt, model, ephemeral);
    return;
  }

  const result = await sessions.sendMessage(sessionId, prompt);
  if (ephemeral && !existingId) await sessions.remove(sessionId).catch(() => undefined);
  sendJson(ctx.res, 200, {
    id: `chatcmpl-${sessionId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    pkwn_session_id: ephemeral ? undefined : sessionId,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.finalText },
        finish_reason: result.ok ? "stop" : "error",
      },
    ],
    usage: summarizeUsage(result.events),
  });
}

function summarizeUsage(events: AgentEvent[]): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const event of events) {
    if (event.type === "usage") {
      inputTokens += event.usage.inputTokens ?? 0;
      outputTokens += event.usage.outputTokens ?? 0;
    }
  }
  return { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
}

async function streamChatCompletion(
  ctx: RouteContext,
  sessions: SessionManager,
  sessionId: string,
  prompt: string,
  model: string,
  ephemeral: boolean,
): Promise<void> {
  const sse = new SseWriter(ctx.res);
  let sentLen = 0;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    sse.send({
      id: `chatcmpl-${sessionId}`,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });

  const unsubscribe = sessions.subscribe(sessionId, (event) => {
    if (event.type === "text") {
      if (event.text.length > sentLen) {
        chunk({ content: event.text.slice(sentLen) });
        sentLen = event.text.length;
      }
    }
  });
  try {
    const result = await sessions.sendMessage(sessionId, prompt);
    if (result.finalText.length > sentLen) chunk({ content: result.finalText.slice(sentLen) });
    chunk({}, result.ok ? "stop" : "error");
    sse.sendRaw("[DONE]");
  } finally {
    unsubscribe();
    if (ephemeral) await sessions.remove(sessionId).catch(() => undefined);
    sse.close();
  }
}
