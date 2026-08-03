// Skill retrieval + authoring tools — the model-facing half of
// src/skills.ts. `read_skill` is the "progressive disclosure" pull side
// (available everywhere: reading instructions is never destructive);
// `write_skill` is the authoring side (gated to edit/full, like
// write_file/edit_file, since it writes to disk).

import { validateSkillWrite, writeSkill, type SkillScope } from "../skills.js";
import type { ToolContext, ToolDefinition, ToolExecutionResult } from "./types.js";

export const readSkillTool: ToolDefinition = {
  name: "read_skill",
  description:
    "Read the full instructions for a skill named in your system prompt's skills manifest. Skills hold specialized, " +
    "reusable procedures — read one before attempting a task it clearly matches, rather than re-deriving the approach.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", description: "Exact skill name, as listed in the manifest." } },
    required: ["name"],
  },
};

export async function runReadSkill(input: unknown, ctx: ToolContext): Promise<ToolExecutionResult> {
  const args = input as { name?: string };
  if (!args.name) return { output: "error: missing required 'name'", isError: true };
  const skill = ctx.skills?.find((s) => s.name === args.name);
  if (!skill) {
    return { output: `error: no skill named "${args.name}" — check the exact name in the skills manifest in your system prompt`, isError: true };
  }
  return { output: skill.body, isError: false };
}

export const writeSkillTool: ToolDefinition = {
  name: "write_skill",
  description:
    "Persist a reusable procedure you've worked out as a new skill (or overwrite one you authored before), so a " +
    "future turn can read it back via read_skill instead of re-deriving it. Only write a skill for something " +
    "genuinely reusable — a specific debugging technique, a repo convention, a multi-step procedure you'd want " +
    "to skip re-figuring-out next time — never for a one-off answer.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Lowercase alphanumeric + hyphens, max 64 chars, e.g. 'debug-flaky-e2e-tests'." },
      description: { type: "string", description: "Imperative phrasing, e.g. 'Use this skill when...'. Max 1024 chars." },
      body: { type: "string", description: "Full Markdown instructions for the skill." },
      scope: {
        type: "string",
        enum: ["project", "global"],
        description: "'project' (default): this repo only, under .pkwn/skills/, meant to be committed. 'global': every project on this pkwn install.",
      },
    },
    required: ["name", "description", "body"],
  },
};

export async function runWriteSkill(input: unknown, ctx: ToolContext): Promise<ToolExecutionResult> {
  const args = input as { name?: string; description?: string; body?: string; scope?: SkillScope };
  if (!args.name || !args.description || !args.body) {
    return { output: "error: missing required 'name', 'description', or 'body'", isError: true };
  }
  if (!ctx.pkwnHome) {
    return { output: "error: write_skill is unavailable in this context (no pkwnHome configured)", isError: true };
  }
  const skillInput = { name: args.name, description: args.description, body: args.body, scope: args.scope ?? ("project" as SkillScope) };
  const validationError = validateSkillWrite(skillInput);
  if (validationError) return { output: `error: ${validationError}`, isError: true };
  const path = await writeSkill(ctx.pkwnHome, ctx.cwd, skillInput);
  return { output: `wrote skill "${skillInput.name}" (${skillInput.scope}) to ${path}`, isError: false };
}
