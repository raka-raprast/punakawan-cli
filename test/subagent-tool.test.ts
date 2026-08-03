import { test } from "node:test";
import assert from "node:assert/strict";
import { runSpawnSubagent } from "../src/agent-tools/subagent-tool.js";
import type { ToolContext } from "../src/agent-tools/types.js";
import type { SubagentRequest, SubagentResult } from "../src/types.js";

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: "/tmp", permission: "edit", signal: new AbortController().signal, ...overrides };
}

test("spawn_subagent errors without a required 'prompt'", async () => {
  const result = await runSpawnSubagent({}, ctx());
  assert.equal(result.isError, true);
  assert.match(result.output, /missing required 'prompt'/);
});

test("spawn_subagent errors when unavailable in this context (no session manager, or already a subagent turn)", async () => {
  const result = await runSpawnSubagent({ prompt: "do a thing" }, ctx());
  assert.equal(result.isError, true);
  assert.match(result.output, /unavailable in this context/);
});

test("spawn_subagent rejects a requested permission tier above its own session's tier", async () => {
  const spawnSubagent = async (): Promise<SubagentResult> => {
    throw new Error("must not be called");
  };
  const result = await runSpawnSubagent({ prompt: "do a thing", permission: "full" }, ctx({ permission: "safe", spawnSubagent }));
  assert.equal(result.isError, true);
  assert.match(result.output, /cannot exceed this session's own tier 'safe'/);
});

test("spawn_subagent defaults cwd/permission to the current session's and returns the subagent's final text", async () => {
  let captured: SubagentRequest | undefined;
  const spawnSubagent = async (request: SubagentRequest): Promise<SubagentResult> => {
    captured = request;
    return { ok: true, finalText: "done: added the health check endpoint", sessionId: "child-1" };
  };
  const result = await runSpawnSubagent({ prompt: "add a health check endpoint" }, ctx({ cwd: "/repo", permission: "edit", spawnSubagent }));

  assert.deepEqual(captured, { prompt: "add a health check endpoint", cwd: "/repo", permission: "edit" });
  assert.equal(result.isError, false);
  assert.equal(result.output, "done: added the health check endpoint");
  assert.equal(result.meta?.["subagentSessionId"], "child-1");
});

test("spawn_subagent honors an explicit cwd/permission narrower than the parent's", async () => {
  let captured: SubagentRequest | undefined;
  const spawnSubagent = async (request: SubagentRequest): Promise<SubagentResult> => {
    captured = request;
    return { ok: true, finalText: "ok", sessionId: "child-2" };
  };
  await runSpawnSubagent({ prompt: "look around", cwd: "/other", permission: "safe" }, ctx({ cwd: "/repo", permission: "edit", spawnSubagent }));
  assert.deepEqual(captured, { prompt: "look around", cwd: "/other", permission: "safe" });
});

test("spawn_subagent surfaces a failed subagent as an error result", async () => {
  const spawnSubagent = async (): Promise<SubagentResult> => ({ ok: false, finalText: "crashed midway", sessionId: "child-3" });
  const result = await runSpawnSubagent({ prompt: "do a thing" }, ctx({ spawnSubagent }));
  assert.equal(result.isError, true);
  assert.equal(result.output, "subagent failed: crashed midway");
  assert.equal(result.meta?.["subagentSessionId"], "child-3");
});
