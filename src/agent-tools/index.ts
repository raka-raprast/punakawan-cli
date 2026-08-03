// Permission-tier-gated tool registry shared by every direct-API adapter.
//
//   safe  — read_file / list_directory / ask_user_question only (no
//           writes, no shell — asking a clarifying question is never
//           destructive, so it's available everywhere).
//   edit  — adds write_file / edit_file / run_bash (run_bash still screens
//           against the basic denylist in bash-tool.ts).
//   full  — same tool set as edit; run_bash skips the denylist too.
//
// This IS the safety boundary pkwn provides in direct-API mode — there is
// no OS-level sandbox here, unlike the vendor CLIs' own compiled sandboxing.

import type { PermissionTier } from "../types.js";
import { askUserQuestionTool, runAskUserQuestion } from "./ask-tool.js";
import { runBash, runBashTool } from "./bash-tool.js";
import { editFileTool, listDirectoryTool, readFileTool, runEditFile, runListDirectory, runReadFile, runWriteFile, writeFileTool } from "./fs-tools.js";
import type { ToolContext, ToolDefinition, ToolExecutionResult } from "./types.js";

export type { ToolContext, ToolDefinition, ToolExecutionResult } from "./types.js";

const ALWAYS_AVAILABLE_TOOLS: ToolDefinition[] = [readFileTool, listDirectoryTool, askUserQuestionTool];
const WRITE_TOOLS: ToolDefinition[] = [writeFileTool, editFileTool, runBashTool];

export function availableTools(permission: PermissionTier): ToolDefinition[] {
  return permission === "safe" ? ALWAYS_AVAILABLE_TOOLS : [...ALWAYS_AVAILABLE_TOOLS, ...WRITE_TOOLS];
}

const HANDLERS: Record<string, (input: unknown, ctx: ToolContext) => Promise<ToolExecutionResult>> = {
  read_file: runReadFile,
  list_directory: runListDirectory,
  ask_user_question: runAskUserQuestion,
  write_file: runWriteFile,
  edit_file: runEditFile,
  run_bash: runBash,
};

export async function executeTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolExecutionResult> {
  const handler = HANDLERS[name];
  if (!handler) return { output: `error: unknown tool "${name}"`, isError: true };
  if (ctx.permission === "safe" && WRITE_TOOLS.some((t) => t.name === name)) {
    return { output: `error: "${name}" is not available in 'safe' permission mode`, isError: true };
  }
  return handler(input, ctx);
}
