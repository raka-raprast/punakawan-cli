import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReadSkill, runWriteSkill } from "../src/agent-tools/skills-tool.js";
import type { ToolContext } from "../src/agent-tools/types.js";
import { loadSkills, type Skill } from "../src/skills.js";

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: "/tmp", permission: "edit", signal: new AbortController().signal, ...overrides };
}

const SAMPLE_SKILL: Skill = { name: "sample-skill", description: "Use this when sampling.", body: "Do the sample thing.", scope: "project", path: "/x/SKILL.md" };

test("read_skill errors without a required 'name'", async () => {
  const result = await runReadSkill({}, ctx());
  assert.equal(result.isError, true);
  assert.match(result.output, /missing required 'name'/);
});

test("read_skill errors for a name not present in ctx.skills", async () => {
  const result = await runReadSkill({ name: "no-such-skill" }, ctx({ skills: [SAMPLE_SKILL] }));
  assert.equal(result.isError, true);
  assert.match(result.output, /no skill named "no-such-skill"/);
});

test("read_skill returns the full body for a matching skill", async () => {
  const result = await runReadSkill({ name: "sample-skill" }, ctx({ skills: [SAMPLE_SKILL] }));
  assert.equal(result.isError, false);
  assert.equal(result.output, "Do the sample thing.");
});

test("write_skill errors when required fields are missing", async () => {
  const result = await runWriteSkill({ name: "x" }, ctx({ pkwnHome: "/tmp" }));
  assert.equal(result.isError, true);
  assert.match(result.output, /missing required/);
});

test("write_skill errors when unavailable in this context (no pkwnHome)", async () => {
  const result = await runWriteSkill({ name: "x", description: "y", body: "z" }, ctx());
  assert.equal(result.isError, true);
  assert.match(result.output, /unavailable in this context/);
});

test("write_skill errors on invalid input before touching disk", async () => {
  const result = await runWriteSkill({ name: "Not Valid", description: "y", body: "z" }, ctx({ pkwnHome: "/nonexistent-should-not-be-touched" }));
  assert.equal(result.isError, true);
  assert.match(result.output, /invalid skill name/);
});

test("write_skill writes a real skill to disk (default scope 'project') and it's readable via loadSkills", async () => {
  const pkwnHome = await mkdtemp(join(tmpdir(), "pkwn-skills-tool-test-"));
  const cwd = await mkdtemp(join(tmpdir(), "pkwn-skills-tool-cwd-"));
  try {
    const result = await runWriteSkill(
      { name: "learned-this", description: "Use this when you've learned a thing.", body: "The full procedure." },
      ctx({ cwd, pkwnHome }),
    );
    assert.equal(result.isError, false);
    assert.match(result.output, /wrote skill "learned-this" \(project\)/);

    const skills = await loadSkills(pkwnHome, cwd);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.name, "learned-this");
    assert.equal(skills[0]!.scope, "project");
  } finally {
    await rm(pkwnHome, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("write_skill honors an explicit scope: 'global'", async () => {
  const pkwnHome = await mkdtemp(join(tmpdir(), "pkwn-skills-tool-test-"));
  const cwd = await mkdtemp(join(tmpdir(), "pkwn-skills-tool-cwd-"));
  try {
    const result = await runWriteSkill({ name: "cross-project", description: "Use this everywhere.", body: "Body.", scope: "global" }, ctx({ cwd, pkwnHome }));
    assert.equal(result.isError, false);
    assert.match(result.output, /\(global\)/);
    const skills = await loadSkills(pkwnHome, cwd);
    assert.equal(skills[0]!.scope, "global");
  } finally {
    await rm(pkwnHome, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
