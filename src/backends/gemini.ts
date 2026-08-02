// Adapter for Google's `gemini` CLI (google-gemini/gemini-cli), driven
// headlessly via `-p --output-format stream-json`. Auth is whatever
// Google-account OAuth login already cached at `~/.gemini/oauth_creds.json`
// (Google AI Pro/Ultra subscription) — this adapter never reads that token,
// only the non-secret `google_accounts.json` sidecar to detect who's signed in.
//
// Note: "Antigravity" is Google's separate IDE/agent product; its own CLI
// (`agy`) has no documented headless/automation contract as of this writing,
// so Gemini-account access here goes through the officially documented,
// scriptable `gemini` CLI instead (see README for the full rationale).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../process/cli-runner.js";
import { classifyErrorText, isRecord, tryParseJson } from "./base.js";
import type {
  AgentEvent,
  AuthStatus,
  BackendAdapter,
  ErrorKind,
  PermissionTier,
  TurnOptions,
} from "../types.js";

function approvalMode(tier: PermissionTier): string {
  switch (tier) {
    case "safe":
      return "plan";
    case "edit":
      return "auto_edit";
    case "full":
      return "yolo";
  }
}

function buildArgs(opts: TurnOptions): string[] {
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--approval-mode",
    approvalMode(opts.permission),
    "--skip-trust",
  ];
  if (opts.model) args.push("-m", opts.model);
  if (opts.resumeId) args.push("--resume", opts.resumeId);
  return args;
}

function buildEnv(opts: TurnOptions): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (opts.homeDir) env["GEMINI_CLI_HOME"] = opts.homeDir;
  return env;
}

/** Exit codes thrown by gemini-cli's FatalError subclasses (packages/core/src/utils/errors.ts). */
function classifyExitCode(code: number | null): ErrorKind | undefined {
  switch (code) {
    case 41:
      return "auth";
    case 42:
    case 52:
      return "config";
    case 44:
      return "sandbox";
    case 53:
      return "rate_limit"; // turn-limit exceeded: treat like a quota condition
    case 54:
      return "tool";
    case 55:
      return "config";
    case 130:
      return "cancelled";
    default:
      return undefined;
  }
}

async function* translate(
  lines: AsyncIterable<string>,
): AsyncGenerator<AgentEvent, void, void> {
  let assistantText = "";
  for await (const line of lines) {
    const msg = tryParseJson(line);
    if (!isRecord(msg)) continue;

    switch (msg["type"]) {
      case "init":
        if (typeof msg["session_id"] === "string") {
          yield { type: "started", backendSessionId: msg["session_id"] };
        }
        break;
      case "message": {
        if (msg["role"] !== "assistant") break;
        const delta = msg["delta"];
        if (typeof delta === "string") {
          assistantText += delta;
        } else if (typeof msg["content"] === "string") {
          assistantText = msg["content"];
        }
        yield { type: "text", role: "assistant", text: assistantText, partial: true };
        break;
      }
      case "tool_use":
        yield {
          type: "tool_call",
          id: String(msg["tool_id"] ?? ""),
          name: String(msg["tool_name"] ?? ""),
          input: msg["parameters"],
        };
        break;
      case "tool_result": {
        const error = msg["error"];
        yield {
          type: "tool_result",
          id: String(msg["tool_id"] ?? ""),
          output: msg["output"],
          isError: msg["status"] === "error",
          error: isRecord(error) ? String(error["message"] ?? "") : undefined,
        };
        break;
      }
      case "error": {
        const message = String(msg["message"] ?? "unknown error");
        if (msg["severity"] === "warning") {
          yield { type: "warning", message };
        } else {
          yield { type: "error", kind: classifyErrorText(message), message, retryable: true };
        }
        break;
      }
      case "result": {
        const stats = msg["stats"];
        if (isRecord(stats)) {
          yield {
            type: "usage",
            usage: {
              inputTokens: Number(stats["input_tokens"] ?? 0),
              outputTokens: Number(stats["output_tokens"] ?? 0),
              cachedInputTokens: Number(stats["cached"] ?? 0),
            },
          };
        }
        if (assistantText) {
          yield { type: "text", role: "assistant", text: assistantText, partial: false };
        }
        const ok = msg["status"] === "success";
        if (!ok) {
          const error = msg["error"];
          const message = isRecord(error) ? String(error["message"] ?? "unknown error") : "unknown error";
          const errType = isRecord(error) ? String(error["type"] ?? "") : "";
          const kind = /resource_exhausted/i.test(errType) ? "rate_limit" : classifyErrorText(message);
          yield { type: "error", kind, message, retryable: kind !== "auth" };
        }
        yield { type: "turn_complete", ok };
        break;
      }
      default:
        break;
    }
  }
}

export class GeminiAdapter implements BackendAdapter {
  readonly id = "gemini" as const;
  readonly displayName = "Gemini CLI";
  readonly defaultMaxConcurrency = 3;

  async checkAuth(homeDir?: string): Promise<AuthStatus> {
    const accountsPath = join(homeDir ?? homedir(), ".gemini", "google_accounts.json");
    try {
      const raw = await readFile(accountsPath, "utf8");
      const parsed = tryParseJson(raw);
      const active = isRecord(parsed) && typeof parsed["active"] === "string" ? parsed["active"] : null;
      return {
        backend: "gemini",
        loggedIn: active !== null,
        mode: active !== null ? "oauth-subscription" : undefined,
        detail: active ?? "no active Google account cached",
      };
    } catch {
      return { backend: "gemini", loggedIn: false, detail: `no credentials at ${accountsPath}` };
    }
  }

  async *runTurn(opts: TurnOptions): AsyncGenerator<AgentEvent, void, void> {
    const proc = runProcess("gemini", buildArgs(opts), {
      cwd: opts.cwd,
      env: buildEnv(opts),
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });
    let sawTurnComplete = false;
    for await (const event of translate(proc.lines)) {
      if (event.type === "turn_complete") sawTurnComplete = true;
      yield event;
    }
    const result = await proc.done;
    if (!sawTurnComplete) {
      if (result.timedOut) {
        yield { type: "error", kind: "timeout", message: "gemini timed out", retryable: true };
      } else if (result.aborted) {
        yield { type: "error", kind: "cancelled", message: "turn aborted", retryable: false };
      } else if (result.code !== 0) {
        const kind = classifyExitCode(result.code) ?? classifyErrorText(result.stderr);
        yield { type: "error", kind, message: result.stderr.trim() || `exit ${result.code}`, retryable: kind !== "auth" };
      }
      yield { type: "turn_complete", ok: result.code === 0 };
    }
  }
}
