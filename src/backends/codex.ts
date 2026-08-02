// Adapter for OpenAI's `codex` CLI, driven headlessly via `codex exec --json`
// (or `codex exec resume <id> --json` to continue). Auth is whatever
// `codex login` already established in $CODEX_HOME/auth.json — this adapter
// never reads or copies that file, only shells out to `codex login status`.
//
// IMPORTANT concurrency note (grounded in OpenAI's own CI/CD auth guide):
// concurrent `codex exec` processes sharing one ChatGPT-OAuth auth.json can
// race on refresh-token rotation and invalidate each other's session. The
// registry (registry.ts) enforces maxConcurrency=1 for this backend unless
// each session is given its own CODEX_HOME (homeDir) with an independently
// logged-in account.

import { runProcess } from "../process/cli-runner.js";
import { classifyErrorText, isRecord, tryParseJson } from "./base.js";
import type {
  AgentEvent,
  AuthStatus,
  BackendAdapter,
  PermissionTier,
  TurnOptions,
} from "../types.js";

function sandboxArgs(tier: PermissionTier): string[] {
  switch (tier) {
    case "safe":
      return ["--sandbox", "read-only"];
    case "edit":
      return ["--sandbox", "workspace-write", "--approve-for-me"];
    case "full":
      return ["--dangerously-bypass-approvals-and-sandbox"];
  }
}

function buildArgs(opts: TurnOptions): string[] {
  const common = ["--json", "-C", opts.cwd, ...sandboxArgs(opts.permission)];
  if (opts.model) common.push("-m", opts.model);
  if (opts.resumeId) {
    return ["exec", "resume", opts.resumeId, ...common, opts.prompt];
  }
  return ["exec", ...common, opts.prompt];
}

function buildEnv(opts: TurnOptions): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (opts.homeDir) env["CODEX_HOME"] = opts.homeDir;
  return env;
}

function itemToEvents(item: unknown): AgentEvent[] {
  if (!isRecord(item)) return [];
  const out: AgentEvent[] = [];
  const id = String(item["id"] ?? "");
  switch (item["type"]) {
    case "agent_message":
      out.push({
        type: "text",
        role: "assistant",
        text: String(item["text"] ?? ""),
        partial: true, // corrected to false on item.completed by caller
      });
      break;
    case "reasoning":
      out.push({ type: "reasoning", text: String(item["text"] ?? "") });
      break;
    case "command_execution":
      out.push({
        type: "tool_call",
        id,
        name: "bash",
        input: { command: item["command"] },
      });
      if (item["status"] === "completed" || item["status"] === "failed") {
        out.push({
          type: "tool_result",
          id,
          output: item["aggregated_output"],
          isError: item["status"] === "failed",
        });
      }
      break;
    case "file_change":
      out.push({ type: "tool_call", id, name: "file_change", input: item["changes"] });
      if (item["status"] === "completed" || item["status"] === "failed") {
        out.push({ type: "tool_result", id, output: item["changes"], isError: item["status"] === "failed" });
      }
      break;
    case "mcp_tool_call":
      out.push({
        type: "tool_call",
        id,
        name: `${item["server"]}.${item["tool"]}`,
        input: item["arguments"],
      });
      if (item["result"] !== undefined || item["error"] !== undefined) {
        const err = item["error"];
        out.push({
          type: "tool_result",
          id,
          output: item["result"],
          isError: err !== null && err !== undefined,
          error: isRecord(err) ? String(err["message"] ?? "") : undefined,
        });
      }
      break;
    case "web_search":
      out.push({ type: "tool_call", id, name: "web_search", input: { query: item["query"] } });
      break;
    case "todo_list":
      out.push({ type: "tool_result", id, output: item["items"], isError: false });
      break;
    case "error":
      out.push({
        type: "error",
        kind: classifyErrorText(String(item["message"] ?? "")),
        message: String(item["message"] ?? ""),
        retryable: true,
      });
      break;
    default:
      break;
  }
  return out;
}

async function* translate(
  lines: AsyncIterable<string>,
): AsyncGenerator<AgentEvent, void, void> {
  for await (const line of lines) {
    const msg = tryParseJson(line);
    if (!isRecord(msg)) continue;

    switch (msg["type"]) {
      case "thread.started":
        if (typeof msg["thread_id"] === "string") {
          yield { type: "started", backendSessionId: msg["thread_id"] };
        }
        break;
      case "item.started":
      case "item.updated":
        for (const ev of itemToEvents(msg["item"])) yield ev;
        break;
      case "item.completed": {
        const item = msg["item"];
        for (const ev of itemToEvents(item)) {
          // agent_message is only truly final on item.completed.
          yield ev.type === "text" ? { ...ev, partial: false } : ev;
        }
        break;
      }
      case "turn.completed": {
        const usage = msg["usage"];
        yield {
          type: "usage",
          usage: isRecord(usage)
            ? {
                inputTokens: Number(usage["input_tokens"] ?? 0),
                outputTokens: Number(usage["output_tokens"] ?? 0),
                cachedInputTokens: Number(usage["cached_input_tokens"] ?? 0),
              }
            : {},
        };
        yield { type: "turn_complete", ok: true };
        break;
      }
      case "turn.failed": {
        const error = msg["error"];
        const message = isRecord(error) ? String(error["message"] ?? "unknown error") : "unknown error";
        const kind = classifyErrorText(message);
        yield { type: "error", kind, message, retryable: kind !== "auth" };
        yield { type: "turn_complete", ok: false };
        break;
      }
      case "error": {
        const message = String(msg["message"] ?? "unknown error");
        yield { type: "error", kind: classifyErrorText(message), message, retryable: false };
        break;
      }
      default:
        break;
    }
  }
}

export class CodexAdapter implements BackendAdapter {
  readonly id = "codex" as const;
  readonly displayName = "Codex CLI";
  // See file header: sharing one ChatGPT-OAuth auth.json across concurrent
  // `codex exec` processes risks refresh-token races. Keep this at 1 unless
  // the deployment gives every session its own logged-in CODEX_HOME.
  readonly defaultMaxConcurrency = 1;

  async checkAuth(homeDir?: string): Promise<AuthStatus> {
    const env = { ...process.env };
    if (homeDir) env["CODEX_HOME"] = homeDir;
    const proc = runProcess("codex", ["login", "status"], {
      cwd: process.cwd(),
      env,
      timeoutMs: 15_000,
    });
    for await (const _line of proc.lines) {
      /* codex login status writes to stderr, not stdout; drain stdout anyway */
    }
    const result = await proc.done;
    return {
      backend: "codex",
      loggedIn: result.code === 0,
      mode: /chatgpt/i.test(result.stderr) ? "oauth-subscription" : /api key/i.test(result.stderr) ? "api-key" : undefined,
      detail: result.stderr.trim(),
    };
  }

  async *runTurn(opts: TurnOptions): AsyncGenerator<AgentEvent, void, void> {
    const proc = runProcess("codex", buildArgs(opts), {
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
        yield { type: "error", kind: "timeout", message: "codex timed out", retryable: true };
      } else if (result.aborted) {
        yield { type: "error", kind: "cancelled", message: "turn aborted", retryable: false };
      } else if (result.code !== 0) {
        const kind = classifyErrorText(result.stderr);
        yield { type: "error", kind, message: result.stderr.trim() || `exit ${result.code}`, retryable: kind !== "auth" };
      }
      yield { type: "turn_complete", ok: result.code === 0 };
    }
  }
}
