// Direct ChatGPT-backend Codex adapter — pkwn's own OAuth login + direct
// HTTP calls to chatgpt.com/backend-api/codex, no `codex` binary involved.
//
// OAuth client_id and every endpoint below are read directly out of
// OpenAI's own open-source codex-rs implementation (github.com/openai/codex),
// not guessed. The `originator`/`User-Agent` values intentionally mirror
// the official Rust CLI's own values (`codex_cli_rs`) — the backend
// classifies requests by this header (source: `is_first_party_originator()`
// helpers in codex-rs), so an honestly-different value would very likely
// just be rejected outright rather than "work but be labeled differently."
// This is exactly the ToS-risk tradeoff already accepted for this feature.

import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pkwnHome } from "../config.js";
import { availableTools, executeTool } from "../agent-tools/index.js";
import { formatProjectContext, loadProjectContext } from "../project-context.js";
import { isPortAvailable, waitForOAuthCallback } from "../oauth/callback-server.js";
import { CloudflareCookieJar } from "../oauth/cookie-jar.js";
import { generatePkce, generateState } from "../oauth/pkce.js";
import { deleteCredential, disableCredential, isExpiringSoon, readCredential, writeCredential, type StoredCredential } from "../oauth/store.js";
import { classifyErrorText } from "./base.js";
import type { AgentEvent, AuthStatus, BackendAdapter, HistoryBlock, HistoryTurn, ModelInfo, PermissionTier, TurnOptions, UsageInfo } from "../types.js";

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CALLBACK_PORTS = [1455, 1457]; // server-side allow-listed — no other port will work
const SCOPES = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CHATGPT_CODEX_BASE = "https://chatgpt.com/backend-api/codex";
const ORIGINATOR = "codex_cli_rs";
// The models endpoint 400s without this — confirmed empirically against
// the real endpoint; matches the installed codex CLI's own version at
// research time. Bump if OpenAI starts rejecting it as too old.
const CLIENT_VERSION = "0.146.0";
// Confirmed against the real codex-cli's live models_cache.json (fetched
// from chatgpt.com/backend-api on 2026-08-02): "gpt-5-codex" is stale and
// rejected for ChatGPT-account auth with a 400. Priority-1 model at that
// snapshot was "gpt-5.6-sol" — verify this against a fresh `codex` CLI
// install if OpenAI reshuffles the catalog again.
const DEFAULT_MODEL = "gpt-5.6-sol";
const OAUTH_LOGIN_TIMEOUT_MS = 5 * 60_000;

function userAgent(): string {
  const platform = process.platform === "darwin" ? "Mac OS" : process.platform === "win32" ? "Windows" : "Linux";
  return `${ORIGINATOR}/0.1.0 (${platform}; ${process.arch}) pkwn`;
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const segment = token.split(".")[1];
  if (!segment) return {};
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

interface ChatgptClaims {
  email?: string;
  chatgpt_account_id?: string;
  chatgpt_plan_type?: string;
  chatgpt_account_is_fedramp?: boolean;
}

function chatgptClaims(idToken: string): ChatgptClaims {
  const payload = decodeJwtPayload(idToken);
  const profile = payload["https://api.openai.com/profile"];
  const auth = payload["https://api.openai.com/auth"];
  const email = typeof profile === "object" && profile && "email" in profile ? String((profile as Record<string, unknown>)["email"]) : undefined;
  const authRecord = typeof auth === "object" && auth ? (auth as Record<string, unknown>) : {};
  return {
    email,
    chatgpt_account_id: typeof authRecord["chatgpt_account_id"] === "string" ? (authRecord["chatgpt_account_id"] as string) : undefined,
    chatgpt_plan_type: typeof authRecord["chatgpt_plan_type"] === "string" ? (authRecord["chatgpt_plan_type"] as string) : undefined,
    chatgpt_account_is_fedramp: authRecord["chatgpt_account_is_fedramp"] === true,
  };
}

interface TokenResponse {
  id_token: string;
  access_token: string;
  refresh_token?: string;
}

async function findAllowedCallback(): Promise<{ port: number; redirectUri: string }> {
  for (const port of CALLBACK_PORTS) {
    if (await isPortAvailable(port)) return { port, redirectUri: `http://localhost:${port}/auth/callback` };
  }
  throw new Error(`neither of codex's allow-listed callback ports (${CALLBACK_PORTS.join(", ")}) is free`);
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`codex token refresh -> ${res.status}: ${text}`);
  return JSON.parse(text) as TokenResponse;
}

async function getValidAccessToken(homeDir: string): Promise<{ accessToken: string; accountId?: string; fedramp: boolean }> {
  const cred = await readCredential(homeDir, "codex");
  if (!cred) throw new Error("not logged in — run /connect codex");
  const extra = (cred.extra ?? {}) as { chatgptAccountId?: string; fedramp?: boolean };
  if (!isExpiringSoon(cred)) return { accessToken: cred.accessToken, accountId: extra.chatgptAccountId, fedramp: extra.fedramp ?? false };
  if (!cred.refreshToken) throw new Error("access token expired and no refresh token stored — re-run /connect codex");

  let refreshed: TokenResponse;
  try {
    refreshed = await refreshAccessToken(cred.refreshToken);
  } catch (err) {
    await disableCredential(homeDir, "codex", err instanceof Error ? err.message : String(err));
    throw err;
  }
  const claims = chatgptClaims(refreshed.id_token);
  const updated: StoredCredential = {
    accessToken: refreshed.access_token,
    // OpenAI's refresh grant DOES rotate refresh tokens and enforces
    // single-use (a reused stale token is a hard failure server-side) —
    // always persist whatever the response returns.
    refreshToken: refreshed.refresh_token ?? cred.refreshToken,
    identity: claims.email ?? cred.identity,
    extra: { chatgptAccountId: claims.chatgpt_account_id, fedramp: claims.chatgpt_account_is_fedramp ?? false, planType: claims.chatgpt_plan_type },
  };
  await writeCredential(homeDir, "codex", updated);
  return { accessToken: updated.accessToken, accountId: claims.chatgpt_account_id, fedramp: claims.chatgpt_account_is_fedramp ?? false };
}

type ResponseItem =
  | { type: "message"; role: "user" | "assistant"; content: Array<{ type: "input_text" | "output_text"; text: string }> }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

function blockToItems(role: "user" | "assistant", block: HistoryBlock): ResponseItem {
  if (block.type === "tool_use") return { type: "function_call", call_id: block.id ?? "", name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) };
  if (block.type === "tool_result") return { type: "function_call_output", call_id: block.id ?? "", output: typeof block.output === "string" ? block.output : JSON.stringify(block.output ?? "") };
  return { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text: block.text ?? "" }] };
}

function historyToInput(history: HistoryTurn[], prompt: string): ResponseItem[] {
  const items = history.flatMap((turn) => turn.blocks.map((block) => blockToItems(turn.role, block)));
  items.push({ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] });
  return items;
}

function toolsForRequest(permission: PermissionTier): Array<{ type: "function"; name: string; description: string; strict: boolean; parameters: Record<string, unknown> }> {
  return availableTools(permission).map((t) => ({ type: "function", name: t.name, description: t.description, strict: false, parameters: t.inputSchema }));
}

interface SseEvent {
  type: string;
  delta?: string;
  item?: { type?: string; call_id?: string; name?: string; arguments?: string; content?: Array<{ type?: string; text?: string }> };
  response?: { usage?: { input_tokens?: number; output_tokens?: number; cached_tokens?: number } };
}

async function* streamResponses(
  accessToken: string,
  accountId: string | undefined,
  fedramp: boolean,
  cookies: CloudflareCookieJar,
  body: Record<string, unknown>,
  signal: AbortSignal,
): AsyncGenerator<SseEvent, void, void> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    accept: "text/event-stream",
    originator: ORIGINATOR,
    "user-agent": userAgent(),
    "session-id": randomUUID(),
    "x-client-request-id": randomUUID(),
    "x-codex-installation-id": randomUUID(),
  };
  if (accountId) headers["ChatGPT-Account-ID"] = accountId;
  if (fedramp) headers["X-OpenAI-Fedramp"] = "true";
  const cookieHeader = cookies.header();
  if (cookieHeader) headers["cookie"] = cookieHeader;

  const res = await fetch(`${CHATGPT_CODEX_BASE}/responses`, { method: "POST", headers, body: JSON.stringify(body), signal });
  cookies.absorb(res.headers);
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`codex responses -> ${res.status}: ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.startsWith("data: ")) {
        dataLines.push(line.slice(6).trim());
      } else if (line === "" && dataLines.length > 0) {
        const chunk = dataLines.join("\n");
        dataLines = [];
        try {
          yield JSON.parse(chunk) as SseEvent;
        } catch {
          // skip a malformed/partial SSE frame
        }
      }
    }
  }
}

export class CodexAdapter implements BackendAdapter {
  readonly id = "codex" as const;
  readonly displayName = "Codex (direct API)";
  readonly defaultMaxConcurrency = 1; // OpenAI's OAuth refresh token is documented as unsafe under concurrent use

  async checkAuth(homeDir?: string): Promise<AuthStatus> {
    const cred = await readCredential(homeDir ?? pkwnHome(), "codex");
    if (!cred) return { backend: "codex", loggedIn: false, detail: "not logged in" };
    if (cred.disabledCause) return { backend: "codex", loggedIn: false, detail: cred.disabledCause };
    return { backend: "codex", loggedIn: true, mode: "oauth-subscription", detail: cred.identity ?? "logged in" };
  }

  async login(opts: { homeDir?: string }): Promise<AuthStatus> {
    const home = opts.homeDir ?? pkwnHome();
    const { port, redirectUri } = await findAllowedCallback();
    const pkce = generatePkce();
    const state = generateState();

    const authUrl = new URL(`${ISSUER}/oauth/authorize`);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", SCOPES);
    authUrl.searchParams.set("code_challenge", pkce.challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("id_token_add_organizations", "true");
    authUrl.searchParams.set("codex_cli_simplified_flow", "true");
    authUrl.searchParams.set("originator", ORIGINATOR);
    authUrl.searchParams.set("state", state);

    console.log(`open this URL to sign in with ChatGPT:\n${authUrl.toString()}\n`);
    openBrowser(authUrl.toString());

    const callback = await waitForOAuthCallback({ port, path: "/auth/callback", timeoutMs: OAUTH_LOGIN_TIMEOUT_MS });
    if (callback.state !== state) throw new Error("oauth state mismatch on callback — aborting");

    const res = await fetch(`${ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.code,
        redirect_uri: redirectUri,
        client_id: CLIENT_ID,
        code_verifier: pkce.verifier,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`codex token exchange -> ${res.status}: ${text}`);
    const tokens = JSON.parse(text) as TokenResponse;
    const claims = chatgptClaims(tokens.id_token);

    const cred: StoredCredential = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      identity: claims.email,
      extra: { chatgptAccountId: claims.chatgpt_account_id, fedramp: claims.chatgpt_account_is_fedramp ?? false, planType: claims.chatgpt_plan_type },
    };
    await writeCredential(home, "codex", cred);
    return { backend: "codex", loggedIn: true, mode: "oauth-subscription", detail: claims.email ?? "logged in" };
  }

  async logout(homeDir?: string): Promise<void> {
    await deleteCredential(homeDir ?? pkwnHome(), "codex");
  }

  /** Live query against the same `chatgpt.com/backend-api/codex/models`
   * endpoint the real CLI's `models_cache.json` is populated from
   * (confirmed via direct curl with a real token: 400 without
   * `client_version`, 200 with it — this is not guessed). Filters out
   * `visibility !== "list"` entries (e.g. `codex-auto-review`, an
   * internal-only reviewer model the CLI itself never shows a user). */
  async listModels(homeDir?: string): Promise<ModelInfo[]> {
    const { accessToken, accountId } = await getValidAccessToken(homeDir ?? pkwnHome());
    const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
    if (accountId) headers["chatgpt-account-id"] = accountId;
    const res = await fetch(`${CHATGPT_CODEX_BASE}/models?client_version=${encodeURIComponent(CLIENT_VERSION)}`, { headers });
    if (!res.ok) throw new Error(`list models -> ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { models: Array<{ slug: string; display_name?: string; description?: string; visibility?: string }> };
    return data.models.filter((m) => m.visibility === "list").map((m) => ({ id: m.slug, displayName: m.display_name, description: m.description }));
  }

  async *runTurn(opts: TurnOptions): AsyncGenerator<AgentEvent, void, void> {
    const homeDir = opts.homeDir ?? pkwnHome();
    const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]);
    const sessionId = randomUUID();
    yield { type: "started", backendSessionId: sessionId };

    try {
      const { accessToken, accountId, fedramp } = await getValidAccessToken(homeDir);
      const cookies = new CloudflareCookieJar();
      const model = opts.model ?? DEFAULT_MODEL;
      const tools = toolsForRequest(opts.permission);
      const input = historyToInput(opts.history, opts.prompt);
      const projectContext = await loadProjectContext(opts.cwd);
      const instructions = projectContext ? formatProjectContext(projectContext) : undefined;

      let ok = false;
      let cumulativeText = "";
      const pendingCallArgs = new Map<string, string>();
      const MAX_TOOL_ITERATIONS = 25;

      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        const finishedCalls: Array<{ id: string; name: string; args: unknown }> = [];
        let iterationText = "";
        let usage: UsageInfo | undefined;

        const body = { model, input, tools, tool_choice: "auto", parallel_tool_calls: true, stream: true, store: false, instructions };
        for await (const event of streamResponses(accessToken, accountId, fedramp, cookies, body, signal)) {
          if (event.type === "response.output_text.delta" && event.delta) {
            if (iterationText === "" && cumulativeText !== "") cumulativeText += "\n\n";
            iterationText += event.delta;
            cumulativeText += event.delta;
            yield { type: "text", role: "assistant", text: cumulativeText, partial: true };
          } else if (event.type === "response.reasoning_summary_text.delta" && event.delta) {
            yield { type: "reasoning", text: event.delta };
          } else if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
            const id = event.item.call_id ?? randomUUID();
            let args: unknown = {};
            try {
              args = JSON.parse(event.item.arguments ?? "{}");
            } catch {
              args = {};
            }
            finishedCalls.push({ id, name: event.item.name ?? "", args });
            pendingCallArgs.set(id, event.item.arguments ?? "{}");
            yield { type: "tool_call", id, name: event.item.name ?? "", input: args };
          } else if (event.type === "response.completed" && event.response?.usage) {
            const u = event.response.usage;
            usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cachedInputTokens: u.cached_tokens };
          } else if (event.type === "response.failed" || event.type === "response.incomplete") {
            throw new Error(`codex ${event.type}`);
          }
        }

        if (usage) yield { type: "usage", usage };

        if (iterationText) yield { type: "text", role: "assistant", text: cumulativeText, partial: false };

        if (finishedCalls.length === 0) {
          ok = true;
          break;
        }

        if (iterationText) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: iterationText }] });
        for (const call of finishedCalls) {
          input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: pendingCallArgs.get(call.id) ?? "{}" });
          const result = await executeTool(call.name, call.args, { cwd: opts.cwd, permission: opts.permission, signal, ask: opts.ask, toolCallId: call.id });
          yield { type: "tool_result", id: call.id, output: result.output, isError: result.isError, meta: result.meta };
          input.push({ type: "function_call_output", call_id: call.id, output: result.output });
        }
      }

      yield { type: "turn_complete", ok };
    } catch (err) {
      if (signal.aborted && opts.signal.aborted) {
        yield { type: "error", kind: "cancelled", message: "turn aborted", retryable: false };
      } else if (signal.aborted) {
        yield { type: "error", kind: "timeout", message: "codex turn timed out", retryable: true };
      } else {
        const message = err instanceof Error ? err.message : String(err);
        const kind = classifyErrorText(message);
        yield { type: "error", kind, message, retryable: kind !== "auth" };
      }
      yield { type: "turn_complete", ok: false };
    }
  }
}
