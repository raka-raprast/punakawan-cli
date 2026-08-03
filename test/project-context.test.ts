import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatProjectContext, loadProjectContext, PROJECT_CONTEXT_FILENAME } from "../src/project-context.js";

test("loadProjectContext returns undefined when AGENTS.md doesn't exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pkwn-ctx-test-"));
  try {
    assert.equal(await loadProjectContext(dir), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadProjectContext returns trimmed file content when it exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pkwn-ctx-test-"));
  try {
    await writeFile(join(dir, PROJECT_CONTEXT_FILENAME), "\n\n  Build with `npm run build`.  \n\n", "utf8");
    assert.equal(await loadProjectContext(dir), "Build with `npm run build`.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadProjectContext treats a whitespace-only file as absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pkwn-ctx-test-"));
  try {
    await writeFile(join(dir, PROJECT_CONTEXT_FILENAME), "   \n  \n", "utf8");
    assert.equal(await loadProjectContext(dir), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("formatProjectContext labels the content as coming from AGENTS.md", () => {
  const formatted = formatProjectContext("use pnpm");
  assert.match(formatted, /AGENTS\.md/);
  assert.match(formatted, /use pnpm/);
});
