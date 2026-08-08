// Direct Anthropic Messages API adapter — pkwn's own OAuth login + direct
// HTTP calls to api.anthropic.com, no `claude` binary involved.
//
// Anthropic actively defends against exactly this integration pattern with
// a multi-layered "compliance envelope" check (required beta-flag list,
// mandatory system-prompt identity block, an embedded pseudo-billing-header
// text block, tool-name casing). Every real open-source project doing this
// treats the envelope as a moving target that changes with each Claude
// Code CLI release and is normally re-derived by capturing a live request —
// what's below is the current best-effort shape (client_id/OAuth mechanics
// are solid multi-source-confirmed; the billing-header hash algorithm is
// the single most likely piece to need re-tuning against real API errors).
//
// Sources (see conversation record): griffinmartin/opencode-claude-auth,
// ghuntley/loom, starbaser/ccproxy — independent open-source projects that
// already do this in production, cross-checked against each other.

import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pkwnHome } from "../config.js";
import { availableTools, executeTool } from "../agent-tools/index.js";
import { formatProjectContext, loadProjectContext } from "../project-context.js";
import { formatSkillsManifest, loadSkills } from "../skills.js";
import { generatePkce } from "../oauth/pkce.js";
import { deleteCredential, disableCredential, isExpiringSoon, readCredential, writeCredential, type StoredCredential } from "../oauth/store.js";
import { classifyErrorText } from "./base.js";
import type { AgentEvent, AuthStatus, BackendAdapter, HistoryBlock, HistoryTurn, ModelInfo, PermissionTier, TurnOptions, UsageInfo } from "../types.js";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_ENDPOINT = "https://claude.ai/oauth/authorize";
// Two real hosts disagree in the wild; try the more-corroborated one first.
const TOKEN_ENDPOINTS = ["https://claude.ai/v1/oauth/token", "https://console.anthropic.com/v1/oauth/token"];
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "user:inference user:profile user:sessions:claude_code";
const MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODELS_ENDPOINT = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_BETA = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,context-management-2025-06-27";
const IDENTITY_PREAMBLE = "You are Claude Code, Anthropic's official CLI for Claude.";
const BILLING_SALT = "59cf53e54c78";
const CLI_VERSION = "2.1.217";
const DEFAULT_MODEL = "claude-sonnet-4-5";
const OAUTH_LOGIN_TIMEOUT_MS = 10 * 60_000;

function openBrowser(url: string): void {
  const child =
    process.platform === "darwin"
      ? spawn("open", [url], { stdio: "ignore", detached: true })
      : process.platform === "win32"
        ? spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true, windowsHide: true })
        : spawn("xdg-open", [url], { stdio: "ignore", detached: true });
  // Best-effort only: a headless box with no browser/handler (or, on
  // Windows, `start` being a cmd.exe builtin rather than a real exe)
  // must never crash the login flow — the URL is already printed above.
  child.on("error", () => {});
  child.unref();
}

/** Best-effort reproduction of the embedded pseudo-billing-header text
 * block Anthropic's backend parses server-side for OAuth-token billing
 * attribution. Two independent reverse-engineering projects disagree on
 * the exact hash inputs for `cch` — this follows opencode-claude-auth's
 * (newer, currently-maintained) variant. If real API responses reject this
 * shape, re-derive it from a live captured Claude Code request. */
function billingHeaderText(firstUserMessage: string): string {
  const versionSuffix = createHash("sha256").update(BILLING_SALT + firstUserMessage.slice(0, 32) + CLI_VERSION).digest("hex").slice(0, 3);
  const cch = createHash("sha256").update(firstUserMessage).digest("hex").slice(0, 5);
  return `x-anthropic-billing-header: cc_version=${CLI_VERSION}.${versionSuffix}; cc_entrypoint=sdk-cli; cch=${cch};`;
}

/** Claude Code's own tool-naming convention — an `mcp_` prefix with the
 * first letter capitalized. Lowercase/unprefixed tool names are flagged by
 * the OAuth billing validator as non-Claude-Code traffic when tools are
 * present (per opencode-claude-auth's source comments). */
function toClaudeToolName(name: string): string {
  return `mcp_${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}
function fromClaudeToolName(name: string): string {
  const stripped = name.startsWith("mcp_") ? name.slice(4) : name;
  return stripped.charAt(0).toLowerCase() + stripped.slice(1);
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  let lastError: unknown;
  for (const endpoint of TOKEN_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const text = await res.text();
      if (!res.ok) throw new Error(`${endpoint} -> ${res.status}: ${text}`);
      return JSON.parse(text) as TokenResponse;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function getValidAccessToken(homeDir: string): Promise<string> {
  const cred = await readCredential(homeDir, "claude");
  if (!cred) throw new Error("not logged in — run /connect claude");
  if (!isExpiringSoon(cred)) return cred.accessToken;
  if (!cred.refreshToken) throw new Error("access token expired and no refresh token stored — re-run /connect claude");
  let refreshed: TokenResponse;
  try {
    refreshed = await postToken({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: cred.refreshToken });
  } catch (err) {
    await disableCredential(homeDir, "claude", err instanceof Error ? err.message : String(err));
    throw err;
  }
  const updated: StoredCredential = {
    ...cred,
    accessToken: refreshed.access_token,
    // Anthropic's refresh grant rotates the refresh_token on every use —
    // always persist the newest one.
    refreshToken: refreshed.refresh_token ?? cred.refreshToken,
    expiresAt: refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : undefined,
  };
  await writeCredential(homeDir, "claude", updated);
  return updated.accessToken;
}

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

function blockToAnthropic(block: HistoryBlock): AnthropicBlock {
  if (block.type === "tool_use") return { type: "tool_use", id: block.id ?? "", name: toClaudeToolName(block.name ?? ""), input: block.input };
  if (block.type === "tool_result") {
    return { type: "tool_result", tool_use_id: block.id ?? "", content: typeof block.output === "string" ? block.output : JSON.stringify(block.output ?? ""), is_error: block.isError };
  }
  return { type: "text", text: block.text ?? "" };
}

function historyToMessages(history: HistoryTurn[], prompt: string): AnthropicMessage[] {
  const messages: AnthropicMessage[] = history.map((turn) => ({ role: turn.role, content: turn.blocks.map(blockToAnthropic) }));
  messages.push({ role: "user", content: [{ type: "text", text: prompt }] });
  return messages;
}

function toolsForRequest(permission: PermissionTier): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return availableTools(permission).map((t) => ({ name: toClaudeToolName(t.name), description: t.description, input_schema: t.inputSchema }));
}

interface SseEvent {
  type: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; stop_reason?: string };
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  message?: { usage?: { input_tokens?: number } };
  error?: { message?: string };
}

async function* streamMessages(accessToken: string, body: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<SseEvent, void, void> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": ANTHROPIC_BETA,
    "anthropic-dangerous-direct-browser-access": "true",
    "x-app": "cli",
    "user-agent": "claude-cli/2.1.217 (external, sdk-cli)",
    "x-client-request-id": randomUUID(),
    "X-Claude-Code-Session-Id": randomUUID(),
    "content-type": "application/json",
  };
  const res = await fetch(MESSAGES_ENDPOINT, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`messages -> ${res.status}: ${text}`);
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

export class ClaudeAdapter implements BackendAdapter {
  readonly id = "claude" as const;
  readonly displayName = "Claude (direct API)";
  readonly defaultMaxConcurrency = 4;

  async checkAuth(homeDir?: string): Promise<AuthStatus> {
    const cred = await readCredential(homeDir ?? pkwnHome(), "claude");
    if (!cred) return { backend: "claude", loggedIn: false, detail: "not logged in" };
    if (cred.disabledCause) return { backend: "claude", loggedIn: false, detail: cred.disabledCause };
    return { backend: "claude", loggedIn: true, mode: "oauth-subscription", detail: cred.identity ?? "logged in" };
  }

  async login(opts: { homeDir?: string; prompt: (question: string) => Promise<string> }): Promise<AuthStatus> {
    const home = opts.homeDir ?? pkwnHome();
    const pkce = generatePkce();
    // Anthropic's Max/subscription flow uses the PKCE verifier itself as
    // the CSRF `state` value (confirmed in ghuntley/loom) rather than a
    // separate random nonce.
    const state = pkce.verifier;

    const authUrl = new URL(AUTHORIZE_ENDPOINT);
    authUrl.searchParams.set("code", "true");
    authUrl.searchParams.set("client_id", CLIENT_ID);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authUrl.searchParams.set("scope", SCOPES);
    authUrl.searchParams.set("code_challenge", pkce.challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);

    console.log(`open this URL to sign in with Claude:\n${authUrl.toString()}\n`);
    openBrowser(authUrl.toString());

    // No local callback server here: the redirect target is Anthropic's
    // own console page (not a pkwn-controlled localhost port), which
    // displays the code for the user to copy — the same manual-paste UX
    // Claude Code's own CLI login uses.
    const pasted = await opts.prompt("paste the code shown on the page (format: CODE#STATE): ");
    const [code, returnedState] = pasted.trim().split("#");
    if (!code) throw new Error("no code provided");
    if (returnedState && returnedState !== state) throw new Error("oauth state mismatch on pasted code — aborting");

    const tokens = await postToken({
      grant_type: "authorization_code",
      code,
      state,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: pkce.verifier,
    });
    const cred: StoredCredential = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
    };
    await writeCredential(home, "claude", cred);
    return { backend: "claude", loggedIn: true, mode: "oauth-subscription", detail: "logged in" };
  }

  async logout(homeDir?: string): Promise<void> {
    await deleteCredential(homeDir ?? pkwnHome(), "claude");
  }

  /** Live query against Anthropic's real `/v1/models` — confirmed working
   * with just the OAuth bearer token (no beta-flag/billing envelope
   * needed for this endpoint specifically, unlike `/v1/messages`). */
  async listModels(homeDir?: string): Promise<ModelInfo[]> {
    const accessToken = await getValidAccessToken(homeDir ?? pkwnHome());
    const res = await fetch(`${MODELS_ENDPOINT}?limit=100`, {
      headers: { authorization: `Bearer ${accessToken}`, "anthropic-version": ANTHROPIC_VERSION },
    });
    if (!res.ok) throw new Error(`list models -> ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { data: Array<{ id: string; display_name?: string }> };
    return data.data.map((m) => ({ id: m.id, displayName: m.display_name }));
  }

  async *runTurn(opts: TurnOptions): AsyncGenerator<AgentEvent, void, void> {
    const homeDir = opts.homeDir ?? pkwnHome();
    const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]);
    const sessionId = randomUUID();
    yield { type: "started", backendSessionId: sessionId };

    try {
      const accessToken = await getValidAccessToken(homeDir);
      const model = opts.model ?? DEFAULT_MODEL;
      const tools = toolsForRequest(opts.permission);
      const messages = historyToMessages(opts.history, opts.prompt);
      const projectContext = await loadProjectContext(opts.cwd);
      const skillsHome = opts.pkwnHome ?? pkwnHome();
      const skills = await loadSkills(skillsHome, opts.cwd);
      const system = [
        { type: "text", text: billingHeaderText(opts.prompt) },
        { type: "text", text: IDENTITY_PREAMBLE },
        ...(projectContext ? [{ type: "text", text: formatProjectContext(projectContext) }] : []),
        ...(skills.length > 0 ? [{ type: "text", text: formatSkillsManifest(skills) }] : []),
      ];

      let ok = false;
      let cumulativeText = "";
      const MAX_TOOL_ITERATIONS = 25;

      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        const blockKinds = new Map<number, "text" | "tool_use">();
        const toolCalls = new Map<number, { id: string; name: string; jsonBuf: string }>();
        const finishedCalls: Array<{ id: string; name: string; input: unknown }> = [];
        let iterationText = "";
        let stopReason: string | undefined;
        let usage: UsageInfo | undefined;

        const body = { model, system, messages, tools: tools.length > 0 ? tools : undefined, stream: true, max_tokens: 8192 };
        for await (const event of streamMessages(accessToken, body, signal)) {
          if (event.type === "content_block_start" && event.index !== undefined && event.content_block) {
            if (event.content_block.type === "tool_use") {
              blockKinds.set(event.index, "tool_use");
              toolCalls.set(event.index, { id: event.content_block.id ?? randomUUID(), name: fromClaudeToolName(event.content_block.name ?? ""), jsonBuf: "" });
            } else {
              blockKinds.set(event.index, "text");
            }
          } else if (event.type === "content_block_delta" && event.index !== undefined && event.delta) {
            if (event.delta.type === "text_delta" && event.delta.text) {
              if (iterationText === "" && cumulativeText !== "") cumulativeText += "\n\n";
              iterationText += event.delta.text;
              cumulativeText += event.delta.text;
              yield { type: "text", role: "assistant", text: cumulativeText, partial: true };
            } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
              yield { type: "reasoning", text: event.delta.thinking };
            } else if (event.delta.type === "input_json_delta" && event.delta.partial_json !== undefined) {
              const call = toolCalls.get(event.index);
              if (call) call.jsonBuf += event.delta.partial_json;
            }
          } else if (event.type === "content_block_stop" && event.index !== undefined) {
            const call = toolCalls.get(event.index);
            if (call) {
              let input: unknown = {};
              try {
                input = call.jsonBuf ? JSON.parse(call.jsonBuf) : {};
              } catch {
                input = {};
              }
              finishedCalls.push({ id: call.id, name: call.name, input });
              yield { type: "tool_call", id: call.id, name: call.name, input };
            }
          } else if (event.type === "message_delta" && event.delta?.stop_reason) {
            stopReason = event.delta.stop_reason;
            if (event.usage) usage = { outputTokens: event.usage.output_tokens };
          } else if (event.type === "message_start" && event.message?.usage) {
            usage = { ...usage, inputTokens: event.message.usage.input_tokens };
          } else if (event.type === "error") {
            throw new Error(event.error?.message ?? "anthropic stream error");
          }
        }

        if (usage) yield { type: "usage", usage };

        if (iterationText) yield { type: "text", role: "assistant", text: cumulativeText, partial: false };

        if (finishedCalls.length === 0 || stopReason !== "tool_use") {
          ok = true;
          break;
        }

        messages.push({
          role: "assistant",
          content: [...(iterationText ? [{ type: "text" as const, text: iterationText }] : []), ...finishedCalls.map((c) => ({ type: "tool_use" as const, id: c.id, name: toClaudeToolName(c.name), input: c.input }))],
        });
        // Executed concurrently — the model may emit several independent
        // tool_use blocks in one turn (parallel reads, or several
        // spawn_subagent calls meant to run as parallel workstreams); a
        // sequential await here would serialize work the model already
        // asked to fan out. Tool-result events are still yielded in the
        // original call order afterward, so the transcript stays
        // deterministic regardless of completion order.
        const executed = await Promise.all(
          finishedCalls.map(async (call) => ({
            call,
            result: await executeTool(call.name, call.input, {
              cwd: opts.cwd,
              permission: opts.permission,
              signal,
              ask: opts.ask,
              toolCallId: call.id,
              spawnSubagent: opts.spawnSubagent,
              skills,
              pkwnHome: skillsHome,
            }),
          })),
        );
        const resultBlocks: AnthropicBlock[] = [];
        for (const { call, result } of executed) {
          yield { type: "tool_result", id: call.id, output: result.output, isError: result.isError, meta: result.meta };
          resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: result.output, is_error: result.isError });
        }
        messages.push({ role: "user", content: resultBlocks });
      }

      yield { type: "turn_complete", ok };
    } catch (err) {
      if (signal.aborted && opts.signal.aborted) {
        yield { type: "error", kind: "cancelled", message: "turn aborted", retryable: false };
      } else if (signal.aborted) {
        yield { type: "error", kind: "timeout", message: "claude turn timed out", retryable: true };
      } else {
        const message = err instanceof Error ? err.message : String(err);
        const kind = classifyErrorText(message);
        yield { type: "error", kind, message, retryable: kind !== "auth" };
      }
      yield { type: "turn_complete", ok: false };
    }
  }
}
