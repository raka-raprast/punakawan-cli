import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { PkwnConfig } from "../src/config.js";
import { BackendRegistry } from "../src/backends/registry.js";
import { SessionManager } from "../src/session-manager.js";
import { createApiServer } from "../src/api/server.js";
import { FakeAdapter } from "./helpers/fake-adapter.js";

interface SkillInfo {
  name: string;
  description: string;
  scope: string;
}
interface SkillListResponse {
  skills: SkillInfo[];
}

async function withServer(fn: (base: string, pkwnHome: string, cwd: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pkwn-skills-api-test-"));
  const pkwnHome = join(root, "home");
  const cwd = join(root, "repo");
  await mkdir(pkwnHome, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const config: PkwnConfig = { pkwnHome, port: 0, bindHost: "127.0.0.1", defaultTurnTimeoutMs: 5_000, maxTurnRetries: 1, backends: {} };
  const registry = new BackendRegistry(config, [new FakeAdapter("claude")]);
  const sessions = new SessionManager(config, registry);
  await sessions.init();
  const server = createApiServer(config, registry, sessions);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, pkwnHome, cwd);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

async function putSkill(baseDir: string, name: string, description: string): Promise<void> {
  const dir = join(baseDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`, "utf8");
}

test("GET /v1/skills requires ?cwd=", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/v1/skills`);
    assert.equal(res.status, 400);
  });
});

test("GET /v1/skills returns an empty list when no skills exist yet", async () => {
  await withServer(async (base, _pkwnHome, cwd) => {
    const res = await fetch(`${base}/v1/skills?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as SkillListResponse;
    assert.deepEqual(body.skills, []);
  });
});

test("GET /v1/skills lists global and project skills, without leaking the body", async () => {
  await withServer(async (base, pkwnHome, cwd) => {
    await putSkill(join(pkwnHome, "skills"), "global-one", "Use this globally.");
    await putSkill(join(cwd, ".pkwn", "skills"), "project-one", "Use this for this repo.");
    const res = await fetch(`${base}/v1/skills?cwd=${encodeURIComponent(cwd)}`);
    const body = (await res.json()) as SkillListResponse;
    const byName = Object.fromEntries(body.skills.map((s) => [s.name, s]));
    assert.equal(byName["global-one"]?.scope, "global");
    assert.equal(byName["project-one"]?.scope, "project");
    assert.ok(!("body" in body.skills[0]!), "the listing endpoint must not include full skill bodies");
  });
});

test("GET /v1/skills scopes results to the requested cwd — a different repo's skills don't leak in", async () => {
  await withServer(async (base, pkwnHome, cwd) => {
    await putSkill(join(cwd, ".pkwn", "skills"), "this-repo-only", "x");
    const otherCwd = join(pkwnHome, "..", "other-repo");
    await mkdir(otherCwd, { recursive: true });
    const res = await fetch(`${base}/v1/skills?cwd=${encodeURIComponent(otherCwd)}`);
    const body = (await res.json()) as SkillListResponse;
    assert.deepEqual(body.skills, []);
  });
});
