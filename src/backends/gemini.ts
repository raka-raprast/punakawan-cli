// Direct Google Code Assist adapter — pkwn's own OAuth login + direct HTTP
// calls to cloudcode-pa.googleapis.com, no `gemini` CLI involved.
//
// OAuth client_id/client_secret are read from env rather than hardcoded:
// they're Google's own gemini-cli constants (its "installed application"
// OAuth pattern — the secret is not treated as secret for this flow; see
// https://developers.google.com/identity/protocols/oauth2#installed),
// confirmed against gemini-cli's own source
// (packages/core/src/code_assist/oauth2.ts), but committing the literal
// values here trips GitHub's push-protection secret scanner regardless of
// that nuance — see README for where to get them. Uses the "authWithWeb"
// flow (dynamic local callback port, no PKCE) rather than the paste-a-code
// flow — nicer UX for a headless daemon, and exactly what gemini-cli's
// default interactive login does.

import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pkwnHome } from "../config.js";
import { availableTools, executeTool } from "../agent-tools/index.js";
import { formatProjectContext, loadProjectContext } from "../project-context.js";
import { formatSkillsManifest, loadSkills } from "../skills.js";
import { findAvailablePort, waitForOAuthCallback } from "../oauth/callback-server.js";
import { isExpiringSoon, readCredential, writeCredential, deleteCredential, disableCredential, type StoredCredential } from "../oauth/store.js";
import { classifyErrorText, isRecord } from "./base.js";
import type { AgentEvent, AuthStatus, BackendAdapter, HistoryBlock, HistoryTurn, ModelInfo, PermissionTier, TurnOptions, UsageInfo } from "../types.js";

/** Both must be set (`PKWN_GEMINI_OAUTH_CLIENT_ID` / `_SECRET`) before
 * `login()` or a token refresh can run — see README for where to get
 * gemini-cli's own published "installed application" values. Read lazily
 * at the point of use, not module load, so importing this adapter (e.g.
 * the registry wiring up all three backends) never fails just because
 * Gemini specifically isn't configured yet. */
function requireOAuthClient(): { clientId: string; clientSecret: string } {
  const clientId = process.env["PKWN_GEMINI_OAUTH_CLIENT_ID"];
  const clientSecret = process.env["PKWN_GEMINI_OAUTH_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    throw new Error("gemini backend needs PKWN_GEMINI_OAUTH_CLIENT_ID and PKWN_GEMINI_OAUTH_CLIENT_SECRET set — see README's gemini setup section");
  }
  return { clientId, clientSecret };
}
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";
const CODE_ASSIST_BASE = "https://cloudcode-pa.googleapis.com/v1internal";
const DEFAULT_MODEL = "gemini-2.5-flash";
// Code Assist's internal API has no live model-list endpoint — confirmed:
// `POST .../v1internal:listModels` 404s (a generic-SDK method name found
// bundled in gemini-cli's own package, but it targets the *public*
// Gemini API / Vertex AI, a different backend than Code Assist). This is
// therefore a hand-maintained static list sourced from model id strings
// found in gemini-cli's own bundle — only `gemini-2.5-flash` (the
// DEFAULT_MODEL above) is actually confirmed working against Code Assist
// by a real completed turn; the rest are plausible but unverified against
// this specific API. Re-check against gemini-cli's docs/bundle if any
// of these 400.
const STATIC_GEMINI_MODELS: ModelInfo[] = [
  { id: "gemini-3.1-pro", description: "unverified against Code Assist — found in gemini-cli bundle" },
  { id: "gemini-3-pro", description: "unverified against Code Assist — found in gemini-cli bundle" },
  { id: "gemini-3-flash", description: "unverified against Code Assist — found in gemini-cli bundle" },
  { id: "gemini-2.5-pro", description: "unverified against Code Assist — found in gemini-cli bundle" },
  { id: "gemini-2.5-flash", description: "default — confirmed working via a real completed turn" },
  { id: "gemini-2.5-flash-lite", description: "unverified against Code Assist — found in gemini-cli bundle" },
];
const OAUTH_LOGIN_TIMEOUT_MS = 5 * 60_000;

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

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

async function postForm(url: string, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${text}`);
  return JSON.parse(text) as TokenResponse;
}

async function fetchEmail(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(USERINFO_ENDPOINT, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { email?: string };
    return data.email;
  } catch {
    return undefined;
  }
}

async function getValidAccessToken(homeDir: string): Promise<string> {
  const cred = await readCredential(homeDir, "gemini");
  if (!cred) throw new Error("not logged in — run /connect gemini");
  if (!isExpiringSoon(cred)) return cred.accessToken;
  if (!cred.refreshToken) throw new Error("access token expired and no refresh token stored — re-run /connect gemini");
  const { clientId, clientSecret } = requireOAuthClient();
  let refreshed: TokenResponse;
  try {
    refreshed = await postForm(TOKEN_ENDPOINT, {
      refresh_token: cred.refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    });
  } catch (err) {
    await disableCredential(homeDir, "gemini", err instanceof Error ? err.message : String(err));
    throw err;
  }
  const updated: StoredCredential = {
    ...cred,
    accessToken: refreshed.access_token,
    // Google's refresh grant is static/non-rotating in gemini-cli's own
    // client behavior — keep the original refresh_token unless a new one
    // genuinely comes back.
    refreshToken: refreshed.refresh_token ?? cred.refreshToken,
    expiresAt: refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : undefined,
  };
  await writeCredential(homeDir, "gemini", updated);
  return updated.accessToken;
}

// A credential's cloudaicompanionProject doesn't change within a process
// lifetime — avoid re-deriving it (an extra round trip) on every turn.
const projectCache = new Map<string, string | undefined>();

async function loadCodeAssist(accessToken: string, homeDir: string): Promise<string | undefined> {
  if (projectCache.has(homeDir)) return projectCache.get(homeDir);
  const res = await fetch(`${CODE_ASSIST_BASE}:loadCodeAssist`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`loadCodeAssist -> ${res.status}: ${text}`);
  const data = isRecord(JSON.parse(text)) ? (JSON.parse(text) as { cloudaicompanionProject?: string }) : {};
  projectCache.set(homeDir, data.cloudaicompanionProject);
  return data.cloudaicompanionProject;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { id?: string; name: string; args: unknown };
  functionResponse?: { id?: string; name: string; response: { output: unknown } };
}
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

function blockToPart(block: HistoryBlock): GeminiPart {
  if (block.type === "tool_use") return { functionCall: { id: block.id, name: block.name ?? "", args: block.input } };
  if (block.type === "tool_result") return { functionResponse: { id: block.id, name: block.name ?? "", response: { output: block.output } } };
  return { text: block.text ?? "" };
}

function historyToContents(history: HistoryTurn[], prompt: string): GeminiContent[] {
  const contents: GeminiContent[] = history.map((turn) => ({
    role: turn.role === "assistant" ? "model" : "user",
    parts: turn.blocks.map(blockToPart),
  }));
  contents.push({ role: "user", parts: [{ text: prompt }] });
  return contents;
}

function toolsForRequest(permission: PermissionTier): Array<{ functionDeclarations: Array<{ name: string; description: string; parametersJsonSchema: Record<string, unknown> }> }> | undefined {
  const tools = availableTools(permission);
  if (tools.length === 0) return undefined;
  return [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema })) }];
}

interface StreamEnvelope {
  response?: {
    candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
  };
}

async function* streamGenerateContent(
  accessToken: string,
  project: string | undefined,
  model: string,
  contents: GeminiContent[],
  tools: ReturnType<typeof toolsForRequest>,
  signal: AbortSignal,
  systemInstruction?: string,
): AsyncGenerator<StreamEnvelope, void, void> {
  const res = await fetch(`${CODE_ASSIST_BASE}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      project,
      user_prompt_id: randomUUID(),
      request: {
        contents,
        tools,
        generationConfig: {},
        session_id: randomUUID(),
        ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
      },
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`streamGenerateContent -> ${res.status}: ${text}`);
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
          yield JSON.parse(chunk) as StreamEnvelope;
        } catch {
          // skip a malformed/partial SSE frame rather than crash the turn
        }
      }
    }
  }
}

interface PendingCall {
  id: string;
  name: string;
  args: unknown;
}

export class GeminiAdapter implements BackendAdapter {
  readonly id = "gemini" as const;
  readonly displayName = "Gemini (direct API)";
  readonly defaultMaxConcurrency = 3;

  async checkAuth(homeDir?: string): Promise<AuthStatus> {
    const cred = await readCredential(homeDir ?? pkwnHome(), "gemini");
    if (!cred) return { backend: "gemini", loggedIn: false, detail: "not logged in" };
    if (cred.disabledCause) return { backend: "gemini", loggedIn: false, detail: cred.disabledCause };
    return { backend: "gemini", loggedIn: true, mode: "oauth-subscription", detail: cred.identity ?? "logged in" };
  }

  async login(opts: { homeDir?: string }): Promise<AuthStatus> {
    const home = opts.homeDir ?? pkwnHome();
    const port = await findAvailablePort();
    const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
    const state = randomBytes(16).toString("hex");
    const { clientId, clientSecret } = requireOAuthClient();

    const authUrl = new URL(AUTH_ENDPOINT);
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", OAUTH_SCOPES.join(" "));
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent"); // Google only issues a refresh_token on first consent (or when forced)
    authUrl.searchParams.set("state", state);

    console.log(`open this URL to sign in with Google:\n${authUrl.toString()}\n`);
    openBrowser(authUrl.toString());

    const callback = await waitForOAuthCallback({ port, path: "/oauth2callback", timeoutMs: OAUTH_LOGIN_TIMEOUT_MS });
    if (callback.state !== state) throw new Error("oauth state mismatch on callback — aborting");

    const tokens = await postForm(TOKEN_ENDPOINT, {
      code: callback.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    const email = await fetchEmail(tokens.access_token);
    const cred: StoredCredential = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
      identity: email,
    };
    await writeCredential(home, "gemini", cred);
    return { backend: "gemini", loggedIn: true, mode: "oauth-subscription", detail: email ?? "logged in" };
  }

  async logout(homeDir?: string): Promise<void> {
    await deleteCredential(homeDir ?? pkwnHome(), "gemini");
  }

  async listModels(): Promise<ModelInfo[]> {
    return STATIC_GEMINI_MODELS;
  }

  async *runTurn(opts: TurnOptions): AsyncGenerator<AgentEvent, void, void> {
    const homeDir = opts.homeDir ?? pkwnHome();
    const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]);
    const sessionId = randomUUID();
    yield { type: "started", backendSessionId: sessionId };

    try {
      const accessToken = await getValidAccessToken(homeDir);
      const project = await loadCodeAssist(accessToken, homeDir);
      const model = opts.model ?? DEFAULT_MODEL;
      const tools = toolsForRequest(opts.permission);
      const contents = historyToContents(opts.history, opts.prompt);
      const projectContext = await loadProjectContext(opts.cwd);
      const skillsHome = opts.pkwnHome ?? pkwnHome();
      const skills = await loadSkills(skillsHome, opts.cwd);
      const systemInstruction =
        [projectContext ? formatProjectContext(projectContext) : undefined, skills.length > 0 ? formatSkillsManifest(skills) : undefined].filter((s): s is string => Boolean(s)).join("\n\n") ||
        undefined;

      let ok = false;
      let cumulativeText = "";
      const MAX_TOOL_ITERATIONS = 25;

      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        const pendingCalls: PendingCall[] = [];
        let iterationText = "";
        let usage: UsageInfo | undefined;

        for await (const envelope of streamGenerateContent(accessToken, project, model, contents, tools, signal, systemInstruction)) {
          const candidate = envelope.response?.candidates?.[0];
          for (const part of candidate?.content?.parts ?? []) {
            if (part.functionCall) {
              const id = part.functionCall.id ?? `call_${pendingCalls.length}_${Date.now()}`;
              pendingCalls.push({ id, name: part.functionCall.name, args: part.functionCall.args });
              yield { type: "tool_call", id, name: part.functionCall.name, input: part.functionCall.args };
            } else if (part.thought) {
              yield { type: "reasoning", text: part.text ?? "" };
            } else if (part.text) {
              if (iterationText === "" && cumulativeText !== "") cumulativeText += "\n\n";
              iterationText += part.text;
              cumulativeText += part.text;
              yield { type: "text", role: "assistant", text: cumulativeText, partial: true };
            }
          }
          if (envelope.response?.usageMetadata) {
            const u = envelope.response.usageMetadata;
            usage = { inputTokens: u.promptTokenCount, outputTokens: u.candidatesTokenCount, cachedInputTokens: u.cachedContentTokenCount };
          }
        }

        if (usage) yield { type: "usage", usage };

        if (iterationText) yield { type: "text", role: "assistant", text: cumulativeText, partial: false };

        if (pendingCalls.length === 0) {
          ok = true;
          break;
        }

        contents.push({
          role: "model",
          parts: [...(iterationText ? [{ text: iterationText }] : []), ...pendingCalls.map((c) => ({ functionCall: { id: c.id, name: c.name, args: c.args } }))],
        });
        // Executed concurrently — see claude.ts's identical comment.
        const executed = await Promise.all(
          pendingCalls.map(async (call) => ({
            call,
            result: await executeTool(call.name, call.args, {
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
        const resultParts: GeminiPart[] = [];
        for (const { call, result } of executed) {
          yield { type: "tool_result", id: call.id, output: result.output, isError: result.isError, meta: result.meta };
          resultParts.push({ functionResponse: { id: call.id, name: call.name, response: { output: result.output } } });
        }
        contents.push({ role: "user", parts: resultParts });
      }

      yield { type: "turn_complete", ok };
    } catch (err) {
      if (signal.aborted && opts.signal.aborted) {
        yield { type: "error", kind: "cancelled", message: "turn aborted", retryable: false };
      } else if (signal.aborted) {
        yield { type: "error", kind: "timeout", message: "gemini turn timed out", retryable: true };
      } else {
        const message = err instanceof Error ? err.message : String(err);
        const kind = classifyErrorText(message);
        yield { type: "error", kind, message, retryable: kind !== "auth" };
      }
      yield { type: "turn_complete", ok: false };
    }
  }
}
