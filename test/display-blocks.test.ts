import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveDisplayBlocks } from "../src/tui/displayBlocks.js";
import type { AgentEvent } from "../src/types.js";

test("deriveDisplayBlocks merges a run_bash tool_call/tool_result pair into one bash block", () => {
  const events: AgentEvent[] = [
    { type: "started", backendSessionId: "s1" },
    { type: "tool_call", id: "call-1", name: "run_bash", input: { command: "ls -la", timeout_ms: 5000 } },
    { type: "tool_result", id: "call-1", output: "file1\nfile2", isError: false, meta: { durationMs: 42, timeoutMs: 5000 } },
    { type: "turn_complete", ok: true },
  ];
  const blocks = deriveDisplayBlocks(events);
  const bashBlocks = blocks.filter((b) => b.kind === "bash");
  assert.equal(bashBlocks.length, 1);
  const block = bashBlocks[0]!;
  assert.equal(block.command, "ls -la");
  assert.equal(block.timeoutMs, 5000);
  assert.equal(block.output, "file1\nfile2");
  assert.equal(block.isError, false);
  assert.equal(block.durationMs, 42);
  // No separate generic tool_call/tool_result blocks were also emitted.
  assert.equal(blocks.some((b) => b.kind === "tool_call"), false);
  assert.equal(blocks.some((b) => b.kind === "tool_result"), false);
});

test("deriveDisplayBlocks shows a run_bash call with no output yet as still running", () => {
  const events: AgentEvent[] = [{ type: "tool_call", id: "call-1", name: "run_bash", input: { command: "sleep 5" } }];
  const blocks = deriveDisplayBlocks(events);
  assert.equal(blocks.length, 1);
  const block = blocks[0]!;
  assert.equal(block.kind, "bash");
  assert.equal(block.kind === "bash" && block.output, undefined);
});

test("deriveDisplayBlocks leaves non-bash tool calls as separate tool_call/tool_result blocks", () => {
  const events: AgentEvent[] = [
    { type: "tool_call", id: "call-1", name: "read_file", input: { path: "a.txt" } },
    { type: "tool_result", id: "call-1", output: "contents", isError: false },
  ];
  const blocks = deriveDisplayBlocks(events);
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["tool_call", "tool_result"],
  );
  assert.equal(blocks.every((b) => b.kind !== "bash"), true);
});
