// Adapter for Anthropic's `claude` CLI (Claude Code), driven headlessly via
// `-p --output-format stream-json`. Auth is whatever `claude auth login`
// already established on disk — this adapter never touches OAuth tokens
// directly, only shells out to the CLI's own subcommands.
//
// Session resume is scoped to `cwd` (Claude encodes the absolute cwd into
// the transcript path), so callers MUST keep cwd stable across turns of one
// logical session.

import { runProcess } from "../process/cli-runner.js";
import { classifyErrorText, isRecord, tryParseJson } from "./base.js";
import type {
  AgentEvent,
  AuthStatus,
  BackendAdapter,
  PermissionTier,
  TurnOptions,
} from "../types.js";

function permissionFlag(tier: PermissionTier): string {
  switch (tier) {
    case "safe":
      return "plan";
    case "edit":
      return "acceptEdits";
    case "full":
      return "bypassPermissions";
  }
}

function buildArgs(opts: TurnOptions): string[] {
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    permissionFlag(opts.permission),
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.resumeId) args.push("--resume", opts.resumeId);
  return args;
}

function buildEnv(opts: TurnOptions): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (opts.homeDir) env["CLAUDE_CONFIG_DIR"] = opts.homeDir;
  return env;
}

async function* translate(
  lines: AsyncIterable<string>,
): AsyncGenerator<AgentEvent, void, void> {
  let assistantText = "";
  for await (const line of lines) {
    const msg = tryParseJson(line);
    if (!isRecord(msg)) continue;

    switch (msg["type"]) {
      case "system": {
        if (msg["subtype"] === "init" && typeof msg["session_id"] === "string") {
          yield { type: "started", backendSessionId: msg["session_id"] };
        } else if (msg["subtype"] === "api_retry") {
          yield {
            type: "warning",
            message: `retrying (${msg["error"] ?? "unknown"}), attempt ${msg["attempt"]}/${msg["max_retries"]}`,
          };
        }
        break;
      }
      case "stream_event": {
        const event = msg["event"];
        if (isRecord(event) && event["type"] === "content_block_delta") {
          const delta = event["delta"];
          if (isRecord(delta) && delta["type"] === "text_delta" && typeof delta["text"] === "string") {
            assistantText += delta["text"];
            yield { type: "text", role: "assistant", text: assistantText, partial: true };
          }
        }
        break;
      }
      case "assistant": {
        const message = msg["message"];
        const content = isRecord(message) ? message["content"] : undefined;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!isRecord(block)) continue;
            if (block["type"] === "tool_use") {
              yield {
                type: "tool_call",
                id: String(block["id"] ?? ""),
                name: String(block["name"] ?? ""),
                input: block["input"],
              };
            }
            // "text" blocks are intentionally skipped here: the same content
            // already arrived as incremental stream_event text_delta chunks
            // (--include-partial-messages is always on). Emitting it again
            // here would duplicate the assistant's reply.
          }
        }
        break;
      }
      case "user": {
        const message = msg["message"];
        const content = isRecord(message) ? message["content"] : undefined;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!isRecord(block) || block["type"] !== "tool_result") continue;
            yield {
              type: "tool_result",
              id: String(block["tool_use_id"] ?? ""),
              output: block["content"],
              isError: Boolean(block["is_error"]),
            };
          }
        }
        break;
      }
      case "result": {
        const usage = msg["usage"];
        const ok = msg["subtype"] === "success" && msg["is_error"] !== true;
        if (ok && typeof msg["result"] === "string" && msg["result"].length >= assistantText.length) {
          yield { type: "text", role: "assistant", text: msg["result"], partial: false };
        }
        yield {
          type: "usage",
          usage: {
            inputTokens: isRecord(usage) ? Number(usage["input_tokens"] ?? 0) : undefined,
            outputTokens: isRecord(usage) ? Number(usage["output_tokens"] ?? 0) : undefined,
            cachedInputTokens: isRecord(usage)
              ? Number(usage["cache_read_input_tokens"] ?? 0)
              : undefined,
            costUsd: typeof msg["total_cost_usd"] === "number" ? msg["total_cost_usd"] : undefined,
          },
        };
        if (!ok) {
          const errors = Array.isArray(msg["errors"]) ? msg["errors"].join("; ") : String(msg["subtype"]);
          yield {
            type: "error",
            kind: classifyErrorText(errors),
            message: errors,
            retryable: classifyErrorText(errors) !== "auth",
          };
        }
        yield {
          type: "turn_complete",
          ok,
          stopReason: typeof msg["stop_reason"] === "string" ? msg["stop_reason"] : undefined,
        };
        break;
      }
      default:
        break;
    }
  }
}

export class ClaudeAdapter implements BackendAdapter {
  readonly id = "claude" as const;
  readonly displayName = "Claude Code";
  readonly defaultMaxConcurrency = 4;

  async checkAuth(homeDir?: string): Promise<AuthStatus> {
    const env = { ...process.env };
    if (homeDir) env["CLAUDE_CONFIG_DIR"] = homeDir;
    const proc = runProcess("claude", ["auth", "status"], {
      cwd: process.cwd(),
      env,
      timeoutMs: 15_000,
    });
    let stdout = "";
    for await (const line of proc.lines) stdout += line + "\n";
    const result = await proc.done;
    const parsed = tryParseJson(stdout);
    return {
      backend: "claude",
      loggedIn: result.code === 0,
      mode: result.code === 0 ? "oauth-subscription-or-api-key" : undefined,
      detail: isRecord(parsed) ? JSON.stringify(parsed) : stdout.trim() || result.stderr.trim(),
    };
  }

  async *runTurn(opts: TurnOptions): AsyncGenerator<AgentEvent, void, void> {
    const proc = runProcess("claude", buildArgs(opts), {
      cwd: opts.cwd,
      env: buildEnv(opts),
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });
    let sawResult = false;
    for await (const event of translate(proc.lines)) {
      if (event.type === "turn_complete") sawResult = true;
      yield event;
    }
    const result = await proc.done;
    if (!sawResult) {
      if (result.timedOut) {
        yield { type: "error", kind: "timeout", message: "claude timed out", retryable: true };
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
