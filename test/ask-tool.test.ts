import { test } from "node:test";
import assert from "node:assert/strict";
import { runAskUserQuestion } from "../src/agent-tools/ask-tool.js";
import type { ToolContext } from "../src/agent-tools/types.js";

function baseCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: "/tmp", permission: "edit", signal: new AbortController().signal, ...overrides };
}

test("ask_user_question errors without a required field", async () => {
  const noQuestion = await runAskUserQuestion({ options: [{ label: "a" }] }, baseCtx());
  assert.equal(noQuestion.isError, true);
  assert.match(noQuestion.output, /missing required 'question'/);

  const noOptions = await runAskUserQuestion({ question: "pick one", options: [] }, baseCtx());
  assert.equal(noOptions.isError, true);
  assert.match(noOptions.output, /must contain at least one item/);
});

test("ask_user_question errors when no interactive user is attached", async () => {
  const result = await runAskUserQuestion({ question: "pick one", options: [{ label: "a" }] }, baseCtx());
  assert.equal(result.isError, true);
  assert.match(result.output, /no interactive user attached/);
});

test("ask_user_question returns the chosen label(s) from ctx.ask", async () => {
  const ctx = baseCtx({
    toolCallId: "call-1",
    ask: async (request) => {
      assert.equal(request.id, "call-1");
      assert.equal(request.question, "which stack?");
      assert.deepEqual(
        request.options.map((o) => o.label),
        ["Next.js", "Express"],
      );
      return ["Next.js"];
    },
  });
  const result = await runAskUserQuestion(
    { question: "which stack?", options: [{ label: "Next.js" }, { label: "Express" }] },
    ctx,
  );
  assert.equal(result.isError, false);
  assert.equal(result.output, "user chose: Next.js");
});

test("ask_user_question treats an empty answer as a dismissal, not an error", async () => {
  const ctx = baseCtx({ ask: async () => [] });
  const result = await runAskUserQuestion({ question: "which stack?", options: [{ label: "a" }] }, ctx);
  assert.equal(result.isError, false);
  assert.match(result.output, /dismissed/);
});

test("ask_user_question gives up once the turn's signal aborts, instead of hanging forever", async () => {
  const controller = new AbortController();
  const ctx = baseCtx({
    signal: controller.signal,
    ask: () => new Promise(() => {}), // never resolves on its own
  });
  const pending = runAskUserQuestion({ question: "which stack?", options: [{ label: "a" }] }, ctx);
  controller.abort();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(result.output, /turn aborted/);
});
