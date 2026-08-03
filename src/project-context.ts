// Loads a project's own persistent agent instructions. `/init` (the chat
// TUI command) writes this file using the model's own tools; every
// backend adapter then folds its content into the system prompt for
// every future turn in this directory — the same idea as Claude Code's
// CLAUDE.md, just backend-agnostic since pkwn talks to claude/codex/gemini.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const PROJECT_CONTEXT_FILENAME = "AGENTS.md";

/** Returns trimmed file content, or `undefined` if there's no
 * `AGENTS.md` yet (or it's empty/unreadable) — `/init` hasn't run here,
 * which is a perfectly normal state, not an error. */
export async function loadProjectContext(cwd: string): Promise<string | undefined> {
  try {
    const content = await readFile(join(cwd, PROJECT_CONTEXT_FILENAME), "utf8");
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/** Wraps the file's content with a header identifying where it came
 * from, so the model doesn't confuse it with the user's own message. */
export function formatProjectContext(content: string): string {
  return `Project-specific instructions from ${PROJECT_CONTEXT_FILENAME}:\n\n${content}`;
}
