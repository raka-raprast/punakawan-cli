import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSkillsManifest, loadSkills, validateSkillWrite, writeSkill } from "../src/skills.js";

async function withTempDirs(fn: (pkwnHome: string, cwd: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pkwn-skills-test-"));
  try {
    const pkwnHome = join(root, "home");
    const cwd = join(root, "repo");
    await mkdir(pkwnHome, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await fn(pkwnHome, cwd);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function putSkill(baseDir: string, name: string, content: string): Promise<void> {
  const dir = join(baseDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content, "utf8");
}

test("loadSkills returns nothing when no skills directories exist", async () => {
  await withTempDirs(async (pkwnHome, cwd) => {
    assert.deepEqual(await loadSkills(pkwnHome, cwd), []);
  });
});

test("loadSkills parses a well-formed global skill", async () => {
  await withTempDirs(async (pkwnHome, cwd) => {
    await putSkill(
      join(pkwnHome, "skills"),
      "debug-flaky-tests",
      `---\nname: debug-flaky-tests\ndescription: Use this skill when a test fails intermittently.\n---\n\n# Steps\n1. Rerun 10x.\n`,
    );
    const skills = await loadSkills(pkwnHome, cwd);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.name, "debug-flaky-tests");
    assert.equal(skills[0]!.description, "Use this skill when a test fails intermittently.");
    assert.equal(skills[0]!.scope, "global");
    assert.match(skills[0]!.body, /Rerun 10x/);
  });
});

test("loadSkills parses a project-local skill from .pkwn/skills", async () => {
  await withTempDirs(async (pkwnHome, cwd) => {
    await putSkill(join(cwd, ".pkwn", "skills"), "repo-conventions", `---\nname: repo-conventions\ndescription: Use this skill for this repo's style rules.\n---\n\nAlways use tabs.\n`);
    const skills = await loadSkills(pkwnHome, cwd);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.scope, "project");
  });
});

test("a project skill overrides a global skill with the same name", async () => {
  await withTempDirs(async (pkwnHome, cwd) => {
    await putSkill(join(pkwnHome, "skills"), "shared-name", `---\nname: shared-name\ndescription: global version.\n---\n\nglobal body\n`);
    await putSkill(join(cwd, ".pkwn", "skills"), "shared-name", `---\nname: shared-name\ndescription: project version.\n---\n\nproject body\n`);
    const skills = await loadSkills(pkwnHome, cwd);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.scope, "project");
    assert.equal(skills[0]!.description, "project version.");
  });
});

test("loadSkills tolerates a malformed skill without breaking the others", async () => {
  await withTempDirs(async (pkwnHome, cwd) => {
    await putSkill(join(pkwnHome, "skills"), "broken-no-frontmatter", `just a body, no frontmatter at all\n`);
    await putSkill(join(pkwnHome, "skills"), "broken-bad-name", `---\nname: NotValid_Name\ndescription: x.\n---\n\nbody\n`);
    await putSkill(join(pkwnHome, "skills"), "broken-empty-body", `---\nname: broken-empty-body\ndescription: x.\n---\n\n   \n`);
    await putSkill(join(pkwnHome, "skills"), "good-one", `---\nname: good-one\ndescription: fine.\n---\n\nbody\n`);
    const skills = await loadSkills(pkwnHome, cwd);
    assert.deepEqual(skills.map((s) => s.name), ["good-one"]);
  });
});

test("loadSkills ignores an entry with no SKILL.md at all", async () => {
  await withTempDirs(async (pkwnHome, cwd) => {
    await mkdir(join(pkwnHome, "skills", "empty-dir"), { recursive: true });
    await writeFile(join(pkwnHome, "skills", "not-a-dir.txt"), "hi", "utf8");
    assert.deepEqual(await loadSkills(pkwnHome, cwd), []);
  });
});

test("skills load sorted by name", async () => {
  await withTempDirs(async (pkwnHome, cwd) => {
    await putSkill(join(pkwnHome, "skills"), "zebra", `---\nname: zebra\ndescription: z.\n---\n\nb\n`);
    await putSkill(join(pkwnHome, "skills"), "apple", `---\nname: apple\ndescription: a.\n---\n\nb\n`);
    const skills = await loadSkills(pkwnHome, cwd);
    assert.deepEqual(skills.map((s) => s.name), ["apple", "zebra"]);
  });
});

test("formatSkillsManifest lists name, scope, and description without the body", () => {
  const manifest = formatSkillsManifest([
    { name: "a", description: "does a thing", scope: "global", body: "SECRET BODY CONTENT", path: "/x" },
    { name: "b", description: "does another thing", scope: "project", body: "SECRET BODY CONTENT 2", path: "/y" },
  ]);
  assert.match(manifest, /a \(global\): does a thing/);
  assert.match(manifest, /b \(project\): does another thing/);
  assert.doesNotMatch(manifest, /SECRET BODY CONTENT/);
});

test("validateSkillWrite rejects an invalid name", () => {
  assert.match(validateSkillWrite({ name: "Not_Valid", description: "x", body: "y", scope: "project" }) ?? "", /invalid skill name/);
  assert.match(validateSkillWrite({ name: "-leading-hyphen", description: "x", body: "y", scope: "project" }) ?? "", /invalid skill name/);
  assert.match(validateSkillWrite({ name: "trailing-hyphen-", description: "x", body: "y", scope: "project" }) ?? "", /invalid skill name/);
  assert.equal(validateSkillWrite({ name: "a", description: "x", body: "y", scope: "project" }), undefined, "a single character is valid");
});

test("validateSkillWrite rejects an empty description or an oversized one", () => {
  assert.match(validateSkillWrite({ name: "ok-name", description: "  ", body: "y", scope: "project" }) ?? "", /description must not be empty/);
  assert.match(validateSkillWrite({ name: "ok-name", description: "x".repeat(1025), body: "y", scope: "project" }) ?? "", /at most 1024 characters/);
});

test("validateSkillWrite rejects an empty body", () => {
  assert.match(validateSkillWrite({ name: "ok-name", description: "x", body: "   ", scope: "project" }) ?? "", /body must not be empty/);
});

test("validateSkillWrite accepts a well-formed input", () => {
  assert.equal(validateSkillWrite({ name: "debug-flaky-tests", description: "Use this when tests flake.", body: "steps here", scope: "global" }), undefined);
});

test("writeSkill writes a project-scope skill under .pkwn/skills and it round-trips through loadSkills", async () => {
  await withTempDirs(async (pkwnHome, cwd) => {
    const path = await writeSkill(pkwnHome, cwd, { name: "new-skill", description: "Use this when testing.", body: "Do the thing.", scope: "project" });
    assert.equal(path, join(cwd, ".pkwn", "skills", "new-skill", "SKILL.md"));
    const skills = await loadSkills(pkwnHome, cwd);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.name, "new-skill");
    assert.equal(skills[0]!.description, "Use this when testing.");
    assert.equal(skills[0]!.body, "Do the thing.");
  });
});

test("writeSkill writes a global-scope skill under <pkwnHome>/skills", async () => {
  await withTempDirs(async (pkwnHome, cwd) => {
    await writeSkill(pkwnHome, cwd, { name: "global-thing", description: "Use this anywhere.", body: "Body.", scope: "global" });
    const skills = await loadSkills(pkwnHome, cwd);
    assert.equal(skills[0]!.scope, "global");
  });
});

test("writeSkill escapes a description containing quotes and newlines, and still round-trips", async () => {
  await withTempDirs(async (pkwnHome, cwd) => {
    const tricky = 'Use this when the user says "help" or\nsplits across lines.';
    await writeSkill(pkwnHome, cwd, { name: "tricky-desc", description: tricky, body: "body", scope: "project" });
    const raw = await readFile(join(cwd, ".pkwn", "skills", "tricky-desc", "SKILL.md"), "utf8");
    assert.match(raw, /^---\n/);
    const skills = await loadSkills(pkwnHome, cwd);
    assert.equal(skills[0]!.description, 'Use this when the user says "help" or splits across lines.');
  });
});

test("writeSkill overwrites an existing skill of the same name", async () => {
  await withTempDirs(async (pkwnHome, cwd) => {
    await writeSkill(pkwnHome, cwd, { name: "evolves", description: "v1", body: "body v1", scope: "project" });
    await writeSkill(pkwnHome, cwd, { name: "evolves", description: "v2", body: "body v2", scope: "project" });
    const skills = await loadSkills(pkwnHome, cwd);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.description, "v2");
  });
});
