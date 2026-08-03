import { test } from "node:test";
import assert from "node:assert/strict";
import { runBash } from "../src/agent-tools/bash-tool.js";
import type { ToolContext } from "../src/agent-tools/types.js";

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: "/tmp", permission: "edit", signal: new AbortController().signal, ...overrides };
}

test("runBash reports wall-clock duration and the effective timeout in meta", async () => {
  const result = await runBash({ command: "echo hi" }, ctx());
  assert.equal(result.isError, false);
  assert.equal(result.output, "hi");
  assert.ok(result.meta, "expected meta to be present");
  assert.equal(typeof result.meta!["durationMs"], "number");
  assert.ok((result.meta!["durationMs"] as number) >= 0);
  assert.equal(result.meta!["timeoutMs"], 120_000, "should report the default timeout when none was requested");
});

test("runBash's meta reflects a caller-supplied timeout_ms", async () => {
  const result = await runBash({ command: "echo hi", timeout_ms: 5_000 }, ctx());
  assert.equal(result.meta!["timeoutMs"], 5_000);
});

test("runBash still reports meta on a failing command", async () => {
  const result = await runBash({ command: "exit 1" }, ctx());
  assert.equal(result.isError, true);
  assert.ok(result.meta);
  assert.equal(typeof result.meta!["durationMs"], "number");
});
