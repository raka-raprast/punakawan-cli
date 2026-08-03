// Subagent delegation tool — spawns an isolated child session (a real,
// independently-persisted pkwn session, same kind as one created through
// the Sessions API) to work a self-contained task end to end, then hands
// back only its final answer. The parent's context pays for one tool
// result, not the child's whole transcript — hermes-agent-style "parallel
// workstreams collapsed into zero-context-cost turns", backed here by
// SessionManager.sendMessage rather than a bespoke execution path.
//
// The child inherits the parent's backend and model always (no
// cross-backend delegation — that would mean juggling a second OAuth
// login the parent has no say over) and its cwd/permission by default.
// `permission` may only narrow the parent's own tier, never escalate past
// it — checked here, before the request ever reaches SessionManager.

import type { PermissionTier } from "../types.js";
import type { ToolContext, ToolDefinition, ToolExecutionResult } from "./types.js";

const PERMISSION_RANK: Record<PermissionTier, number> = { safe: 0, edit: 1, full: 2 };

export const spawnSubagentTool: ToolDefinition = {
  name: "spawn_subagent",
  description:
    "Delegate a self-contained task to an isolated subagent session and block until it produces a final answer. " +
    "Use this for independent workstreams that don't need your ongoing context — the subagent starts with no " +
    "memory of this conversation, and only its final text comes back to you, not its intermediate steps, so it " +
    "costs your context nothing beyond that answer. Give it a complete, self-contained prompt: state the goal, " +
    "the relevant paths, and what 'done' looks like. Emit multiple calls in one turn to run several subagents in " +
    "parallel. Subagents cannot themselves spawn further subagents (delegation is one level deep).",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Complete, self-contained task instructions for the subagent." },
      cwd: { type: "string", description: "Working directory for the subagent (defaults to this session's cwd)." },
      permission: {
        type: "string",
        enum: ["safe", "edit", "full"],
        description: "Permission tier for the subagent (defaults to this session's tier; cannot exceed it).",
      },
    },
    required: ["prompt"],
  },
};

export async function runSpawnSubagent(input: unknown, ctx: ToolContext): Promise<ToolExecutionResult> {
  const args = input as { prompt?: string; cwd?: string; permission?: PermissionTier };
  if (!args.prompt) return { output: "error: missing required 'prompt'", isError: true };
  if (!ctx.spawnSubagent) {
    return {
      output: "error: spawn_subagent is unavailable in this context (no session manager backing this turn, or this is already a subagent turn — delegation is capped at one level deep)",
      isError: true,
    };
  }
  if (args.permission && PERMISSION_RANK[args.permission] > PERMISSION_RANK[ctx.permission]) {
    return { output: `error: subagent permission '${args.permission}' cannot exceed this session's own tier '${ctx.permission}'`, isError: true };
  }

  const result = await ctx.spawnSubagent({
    prompt: args.prompt,
    cwd: args.cwd ?? ctx.cwd,
    permission: args.permission ?? ctx.permission,
  });
  const meta = { subagentSessionId: result.sessionId };
  if (!result.ok) return { output: `subagent failed: ${result.finalText || "(no output)"}`, isError: true, meta };
  return { output: result.finalText || "(subagent produced no text output)", isError: false, meta };
}
