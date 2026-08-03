// Skills — reusable procedural knowledge the model can read on demand
// instead of re-deriving, hermes-agent's "skills system" pillar. Storage
// and format follow the open agentskills.io standard (directory-per-skill,
// `SKILL.md` with YAML frontmatter + Markdown body) for the required
// core (`name`/`description`); optional fields the spec defines
// (`license`, `compatibility`, `metadata`, `allowed-tools`) are preserved
// on disk (any frontmatter pkwn doesn't recognize is simply ignored, not
// rejected) but not yet acted on here.
//
// Two scopes, merged with project taking priority on a name collision:
//   - global:  <pkwnHome>/skills/<name>/SKILL.md   — every project on this install
//   - project: <cwd>/.pkwn/skills/<name>/SKILL.md  — this repo only, meant to be committed
//
// "Progressive disclosure" (the standard's own term): every turn's system
// prompt gets the full list of `name`+`description` pairs (cheap), and
// the model reads a specific skill's full body on demand via the
// `read_skill` tool — never the other way around. `write_skill` lets the
// model persist a new skill during a turn; there is no separate
// background "mine past sessions for skills" job — see README for why
// that's explicitly out of scope for this pass.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type SkillScope = "global" | "project";

export interface Skill {
  name: string;
  description: string;
  body: string;
  scope: SkillScope;
  path: string;
}

export interface SkillWriteInput {
  name: string;
  description: string;
  body: string;
  scope: SkillScope;
}

const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_DESCRIPTION_LENGTH = 1024;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Extracts one top-level scalar `field: value` line from a frontmatter
 * block — deliberately not a full YAML parser (nested maps/lists like
 * `metadata:` or `allowed-tools:` are left untouched on disk, just never
 * surfaced here), so a real agentskills.io skill with fields pkwn
 * doesn't use yet still loads instead of failing to parse. Multi-line
 * block-scalar (`|`/`>`) values aren't supported — `name`/`description`
 * are specified as short plain scalars, which this covers. */
function extractFrontmatterField(frontmatter: string, field: string): string | undefined {
  const match = new RegExp(`^${field}:[ \\t]*(.*)$`, "m").exec(frontmatter);
  if (!match) return undefined;
  let value = match[1]!.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    value = value.slice(1, -1);
  }
  return value.length > 0 ? value : undefined;
}

/** Parses one `SKILL.md`'s content. Returns `undefined` (never throws)
 * for anything unusable — missing frontmatter delimiters, missing
 * `name`/`description`, or a `name` that fails the standard's naming
 * rule — so one malformed skill file never breaks loading every other
 * one. */
function parseSkillFile(raw: string, path: string, scope: SkillScope): Skill | undefined {
  const match = FRONTMATTER.exec(raw);
  if (!match) return undefined;
  const frontmatter = match[1]!;
  const body = match[2]!;
  const name = extractFrontmatterField(frontmatter, "name");
  const description = extractFrontmatterField(frontmatter, "description");
  if (!name || !NAME_PATTERN.test(name) || !description) return undefined;
  const trimmedBody = body.trim();
  if (!trimmedBody) return undefined;
  return { name, description, body: trimmedBody, scope, path };
}

async function scanSkillsDir(dir: string, scope: SkillScope): Promise<Skill[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // no skills directory here yet — normal, not an error
  }
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name, "SKILL.md");
    try {
      const parsed = parseSkillFile(await readFile(path, "utf8"), path, scope);
      if (parsed) skills.push(parsed);
    } catch {
      // No SKILL.md in this directory, or unreadable — skip it.
    }
  }
  return skills;
}

/** Loads every skill visible to a turn in `cwd`: global (`<pkwnHome>/skills`)
 * merged with project-local (`<cwd>/.pkwn/skills`), project winning a
 * name collision. Sorted by name for a stable, diffable manifest. */
export async function loadSkills(pkwnHome: string, cwd: string): Promise<Skill[]> {
  const [global, project] = await Promise.all([scanSkillsDir(join(pkwnHome, "skills"), "global"), scanSkillsDir(join(cwd, ".pkwn", "skills"), "project")]);
  const byName = new Map<string, Skill>();
  for (const skill of global) byName.set(skill.name, skill);
  for (const skill of project) byName.set(skill.name, skill);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The "progressive disclosure" manifest folded into the system prompt:
 * names + descriptions only, never the bodies — those cost context only
 * when `read_skill` actually pulls one in. */
export function formatSkillsManifest(skills: Skill[]): string {
  const lines = skills.map((s) => `- ${s.name} (${s.scope}): ${s.description}`);
  return `Available skills — call read_skill with the exact name to load one's full instructions before attempting a task it clearly matches:\n${lines.join("\n")}`;
}

/** `undefined` when valid; otherwise a human-readable reason, meant to
 * be surfaced straight back to the model as a tool error. */
export function validateSkillWrite(input: SkillWriteInput): string | undefined {
  if (!NAME_PATTERN.test(input.name)) {
    return `invalid skill name "${input.name}" — must be lowercase alphanumeric and hyphens, max 64 chars, and cannot start or end with a hyphen`;
  }
  if (!input.description.trim()) return "description must not be empty";
  if (input.description.length > MAX_DESCRIPTION_LENGTH) return `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`;
  if (!input.body.trim()) return "body must not be empty";
  return undefined;
}

function escapeFrontmatterValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
}

/** Writes (or overwrites) `<base>/<name>/SKILL.md`, `base` chosen by
 * scope. Caller is responsible for `validateSkillWrite` first — this
 * just writes what it's given. Returns the path written, for the
 * calling tool's confirmation message. */
export async function writeSkill(pkwnHome: string, cwd: string, input: SkillWriteInput): Promise<string> {
  const base = input.scope === "global" ? join(pkwnHome, "skills") : join(cwd, ".pkwn", "skills");
  const dir = join(base, input.name);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  const content = `---\nname: ${input.name}\ndescription: ${escapeFrontmatterValue(input.description)}\n---\n\n${input.body.trim()}\n`;
  await writeFile(path, content, "utf8");
  return path;
}
