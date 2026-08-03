// File-system tools: read/list are available at every permission tier
// (they're inherently non-destructive); write/edit require "edit" or
// "full" — enforced by the registry in index.ts, not repeated here.

import { readFile, readdir, stat, writeFile as fsWriteFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ToolContext, ToolDefinition, ToolExecutionResult } from "./types.js";

function resolvePath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "Read a text file. `path` may be absolute or relative to the session's working directory. Returns the content with 1-based line numbers.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to cwd." },
      offset: { type: "integer", description: "1-based line number to start from (default 1)." },
      limit: { type: "integer", description: "Max lines to return (default: whole file)." },
    },
    required: ["path"],
  },
};

export async function runReadFile(input: unknown, ctx: ToolContext): Promise<ToolExecutionResult> {
  const args = input as { path?: string; offset?: number; limit?: number };
  if (!args.path) return { output: "error: missing required 'path'", isError: true };
  try {
    const raw = await readFile(resolvePath(args.path, ctx.cwd), "utf8");
    const lines = raw.split("\n");
    const start = Math.max(1, args.offset ?? 1);
    const end = args.limit ? start + args.limit - 1 : lines.length;
    const numbered = lines.slice(start - 1, end).map((line, i) => `${start + i}:${line}`);
    return { output: numbered.join("\n"), isError: false };
  } catch (err) {
    return { output: `error reading ${args.path}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

export const listDirectoryTool: ToolDefinition = {
  name: "list_directory",
  description: "List entries in a directory. `path` may be absolute or relative to the session's working directory.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Directory path, absolute or relative to cwd." } },
    required: ["path"],
  },
};

export async function runListDirectory(input: unknown, ctx: ToolContext): Promise<ToolExecutionResult> {
  const args = input as { path?: string };
  const path = args.path ?? ".";
  try {
    const dir = resolvePath(path, ctx.cwd);
    const entries = await readdir(dir, { withFileTypes: true });
    const lines = await Promise.all(
      entries.map(async (entry) => {
        if (entry.isDirectory()) return `${entry.name}/`;
        const size = await stat(join(dir, entry.name)).then((s) => s.size).catch(() => undefined);
        return size === undefined ? entry.name : `${entry.name} (${size}B)`;
      }),
    );
    return { output: lines.sort().join("\n") || "(empty)", isError: false };
  } catch (err) {
    return { output: `error listing ${path}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

type DiffOp = { type: "same" | "del" | "add"; text: string };

/** Minimal LCS-based line diff — O(n*m), fine for tool-call-sized file diffs. */
function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const oldLine = oldLines[i]!;
    const newLine = newLines[j]!;
    if (oldLine === newLine) {
      ops.push({ type: "same", text: oldLine });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "del", text: oldLine });
      i++;
    } else {
      ops.push({ type: "add", text: newLine });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", text: oldLines[i++]! });
  while (j < m) ops.push({ type: "add", text: newLines[j++]! });
  return ops;
}

/** Renders a context-free unified-style diff between two full texts. */
function formatDiff(path: string, oldText: string, newText: string): string {
  const ops = diffLines(oldText.split("\n"), newText.split("\n"));
  const hunks: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.type === "same") {
      oldLine++;
      newLine++;
      i++;
      continue;
    }
    const hunkOldStart = oldLine;
    const hunkNewStart = newLine;
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    while (i < ops.length && ops[i]!.type !== "same") {
      const op = ops[i]!;
      if (op.type === "del") {
        body.push(`-${op.text}`);
        oldLine++;
        oldCount++;
      } else {
        body.push(`+${op.text}`);
        newLine++;
        newCount++;
      }
      i++;
    }
    hunks.push(`@@ -${hunkOldStart},${oldCount} +${hunkNewStart},${newCount} @@`);
    hunks.push(...body);
  }
  if (hunks.length === 0) return `no changes to ${path}`;
  return [`--- ${path}`, `+++ ${path}`, ...hunks].join("\n");
}

/** Renders a whole-file diff for a brand-new file: every line reported as added. */
function formatCreateDiff(path: string, content: string): string {
  const lines = content.split("\n");
  const body = lines.map((line) => `+${line}`);
  return [`--- /dev/null`, `+++ ${path}`, `@@ -0,0 +1,${lines.length} @@`, ...body].join("\n");
}

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description: "Create or overwrite a text file with the given content. `path` may be absolute or relative to the session's working directory. Only available in 'edit' or 'full' permission mode.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
};

export async function runWriteFile(input: unknown, ctx: ToolContext): Promise<ToolExecutionResult> {
  const args = input as { path?: string; content?: string };
  if (!args.path || args.content === undefined) return { output: "error: 'path' and 'content' are required", isError: true };
  const resolved = resolvePath(args.path, ctx.cwd);
  try {
    let oldContent: string | null = null;
    try {
      oldContent = await readFile(resolved, "utf8");
    } catch (err) {
      if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await fsWriteFile(resolved, args.content, "utf8");
    const diff = oldContent === null ? formatCreateDiff(args.path, args.content) : formatDiff(args.path, oldContent, args.content);
    return { output: diff, isError: false };
  } catch (err) {
    return { output: `error writing ${args.path}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description:
    "Replace an exact, unique text match in a file. `old_text` must match exactly once in the file's current content, or the edit is rejected. Only available in 'edit' or 'full' permission mode.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_text: { type: "string", description: "Exact text to find — must be unique in the file." },
      new_text: { type: "string", description: "Replacement text." },
    },
    required: ["path", "old_text", "new_text"],
  },
};

export async function runEditFile(input: unknown, ctx: ToolContext): Promise<ToolExecutionResult> {
  const args = input as { path?: string; old_text?: string; new_text?: string };
  if (!args.path || args.old_text === undefined || args.new_text === undefined) {
    return { output: "error: 'path', 'old_text', and 'new_text' are required", isError: true };
  }
  const resolved = resolvePath(args.path, ctx.cwd);
  try {
    const content = await readFile(resolved, "utf8");
    const occurrences = content.split(args.old_text).length - 1;
    if (occurrences === 0) return { output: `error: old_text not found in ${args.path}`, isError: true };
    if (occurrences > 1) return { output: `error: old_text matches ${occurrences} times in ${args.path} — must be unique`, isError: true };
    const updated = content.replace(args.old_text, args.new_text);
    await fsWriteFile(resolved, updated, "utf8");
    return { output: formatDiff(args.path, args.old_text, args.new_text), isError: false };
  } catch (err) {
    return { output: `error editing ${args.path}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
