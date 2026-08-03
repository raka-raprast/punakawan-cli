// Shell tool. Reuses `runProcess` (process-group kill on timeout/abort —
// the same primitive the old CLI-shelling adapters used) rather than a raw
// `child_process.spawn` here.
//
// IMPORTANT SCOPE NOTE: this is a denylist heuristic, not a sandbox. It
// blocks the most obviously destructive command shapes but is trivially
// bypassable (encoding, indirection, etc.) by a sufficiently adversarial
// prompt. Real sandboxing (seccomp/Landlock/seatbelt, the kind Claude
// Code/Codex/Gemini CLI's own compiled binaries implement) is out of scope
// for this pass — permission "safe" mode simply never offers this tool at
// all, which is the actual safety boundary pkwn provides today.

import { runProcess } from "../process/cli-runner.js";
import type { ToolContext, ToolDefinition, ToolExecutionResult } from "./types.js";

const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f\b.*\B(\/|~)\s*$/i, // rm -rf / or rm -rf ~
  /\bmkfs\b/i,
  /\bdd\s+.*of=\/dev\//i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // classic fork bomb
  /\bcurl\b.*\|\s*(ba)?sh\b/i,
  /\bwget\b.*\|\s*(ba)?sh\b/i,
];

export const runBashTool: ToolDefinition = {
  name: "run_bash",
  description: "Run a shell command in the session's working directory. Only available in 'edit' or 'full' permission mode.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout_ms: { type: "integer", description: "Max runtime before the command is killed (default 120000)." },
    },
    required: ["command"],
  },
};

export async function runBash(input: unknown, ctx: ToolContext): Promise<ToolExecutionResult> {
  const args = input as { command?: string; timeout_ms?: number };
  if (!args.command) return { output: "error: missing required 'command'", isError: true };

  if (ctx.permission !== "full" && DANGEROUS_PATTERNS.some((pattern) => pattern.test(args.command!))) {
    return { output: "error: command blocked by pkwn's basic safety denylist (not a sandbox — use permission 'full' to bypass)", isError: true };
  }

  const timeoutMs = args.timeout_ms ?? 120_000;
  const startedAt = Date.now();
  const proc = runProcess("bash", ["-lc", args.command], {
    cwd: ctx.cwd,
    env: process.env,
    signal: ctx.signal,
    timeoutMs,
  });

  const lines: string[] = [];
  for await (const line of proc.lines) lines.push(line);
  const result = await proc.done;
  const meta = { durationMs: Date.now() - startedAt, timeoutMs };

  const stdout = lines.join("\n");
  const combined = [stdout, result.stderr.trim()].filter(Boolean).join("\n[stderr]\n");
  if (result.timedOut) return { output: `${combined}\n(timed out)`, isError: true, meta };
  if (result.aborted) return { output: `${combined}\n(aborted)`, isError: true, meta };
  return { output: combined || "(no output)", isError: result.code !== 0, meta };
}
