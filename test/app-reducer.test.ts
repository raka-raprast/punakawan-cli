import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, reducer } from "../src/tui/App.js";
import type { SessionMetaResponse } from "../src/cli-shared.js";

function meta(overrides: Partial<SessionMetaResponse> = {}): SessionMetaResponse {
  return { id: "s1", backend: "claude", cwd: "/tmp", permission: "edit", status: "idle", updatedAt: "2024-01-01T00:00:00.000Z", ...overrides };
}

test("a message submitted while a turn is in flight queues instead of clobbering liveTurn", () => {
  let state = reducer(initialState, { type: "SET_ACTIVE", meta: meta() });
  state = reducer(state, { type: "START_TURN", userText: "first" });
  // Simulate what sendLine now does when state.liveTurn is already set:
  // it must NOT dispatch another START_TURN (that's the bug being fixed).
  state = reducer(state, { type: "QUEUE_MESSAGE", text: "second" });

  assert.equal(state.liveTurn?.userText, "first", "the in-flight turn's label must not be overwritten");
  assert.deepEqual(state.queuedMessages, ["second"]);
});

test("events for the in-flight turn keep landing on it while a message is queued", () => {
  let state = reducer(initialState, { type: "SET_ACTIVE", meta: meta() });
  state = reducer(state, { type: "START_TURN", userText: "first" });
  state = reducer(state, { type: "QUEUE_MESSAGE", text: "second" });
  state = reducer(state, { type: "AGENT_EVENT", event: { type: "text", role: "assistant", text: "partial reply", partial: true } });

  assert.equal(state.liveTurn?.userText, "first");
  assert.equal(state.liveTurn?.events.length, 1);
  assert.deepEqual(state.queuedMessages, ["second"], "queue is untouched by events belonging to the current turn");
});

test("turn_complete finalizes the in-flight turn into scrollback and leaves the queue for the drain effect", () => {
  let state = reducer(initialState, { type: "SET_ACTIVE", meta: meta() });
  state = reducer(state, { type: "START_TURN", userText: "first" });
  state = reducer(state, { type: "QUEUE_MESSAGE", text: "second" });
  state = reducer(state, { type: "AGENT_EVENT", event: { type: "turn_complete", ok: true } });

  assert.equal(state.liveTurn, undefined);
  assert.equal(state.scrollback.length, 1);
  assert.equal(state.scrollback[0]!.kind, "turn");
  assert.equal(state.scrollback[0]!.kind === "turn" && state.scrollback[0]!.userText, "first");
  assert.deepEqual(state.queuedMessages, ["second"], "still queued — draining is the live component's job, not the reducer's");
});

test("DEQUEUE_MESSAGE pops in FIFO order", () => {
  let state = { ...initialState, queuedMessages: ["a", "b", "c"] };
  state = reducer(state, { type: "DEQUEUE_MESSAGE" });
  assert.deepEqual(state.queuedMessages, ["b", "c"]);
});

test("switching sessions drops any queue left over from the previous one", () => {
  let state = { ...initialState, queuedMessages: ["stale"] };
  state = reducer(state, { type: "SET_ACTIVE", meta: meta({ id: "s2" }) });
  assert.deepEqual(state.queuedMessages, []);

  state = { ...initialState, queuedMessages: ["stale-2"] };
  state = reducer(state, { type: "SET_PENDING", backend: "codex", permission: "edit", cwd: "/tmp" });
  assert.deepEqual(state.queuedMessages, []);
});

test("CLEAR_SCROLLBACK empties the transcript without touching other state", () => {
  let state = reducer(initialState, { type: "SET_ACTIVE", meta: meta() });
  state = reducer(state, { type: "SYSTEM_MESSAGE", text: "old conversation line 1" });
  state = reducer(state, { type: "SYSTEM_MESSAGE", text: "old conversation line 2" });
  assert.equal(state.scrollback.length, 2);

  state = reducer(state, { type: "CLEAR_SCROLLBACK" });
  assert.deepEqual(state.scrollback, []);
  // The active session/backend info itself is untouched — /new's clear
  // is purely a display reset, not a disconnect.
  assert.equal(state.activeId, "s1");
  assert.equal(state.activeBackend, "claude");
});

test("CLEAR_SCROLLBACK bumps scrollbackGeneration so Static remounts instead of silently hiding replayed items", () => {
  const before = reducer(initialState, { type: "SYSTEM_MESSAGE", text: "x" });
  const after = reducer(before, { type: "CLEAR_SCROLLBACK" });
  assert.equal(after.scrollbackGeneration, before.scrollbackGeneration + 1);
});

test("LOAD_SCROLLBACK bumps scrollbackGeneration even when the replacement has the same length as before — the exact bug that made /resume silently show no history", () => {
  // Reproduces the real failure: two scrollback items already present
  // (e.g. the welcome banner + a "ready:" message) before /resume, and
  // the resumed session also happens to replay exactly two turns. Ink's
  // <Static> only tracks a length counter, not identity — a same-length
  // replacement would otherwise never re-trigger it, and the "new"
  // turns would never actually print.
  let state = reducer(initialState, { type: "SYSTEM_MESSAGE", text: "welcome" });
  state = reducer(state, { type: "SYSTEM_MESSAGE", text: "ready" });
  assert.equal(state.scrollback.length, 2);
  const generationBefore = state.scrollbackGeneration;

  state = reducer(state, {
    type: "LOAD_SCROLLBACK",
    turns: [
      { userText: "first", events: [] },
      { userText: "second", events: [] },
    ],
  });

  assert.equal(state.scrollback.length, 2, "replacement happens to be the same length as before");
  assert.equal(state.scrollbackGeneration, generationBefore + 1, "generation MUST bump regardless of the length coincidence");
});
