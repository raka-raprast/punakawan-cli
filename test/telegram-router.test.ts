import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkTelegramText, routeTelegramMessage } from "../src/gateway/telegram-router.js";
import type { TelegramRouterDeps } from "../src/gateway/telegram-router.js";
import type { DaemonClient } from "../src/gateway/daemon-client.js";
import type { BindingsStore } from "../src/gateway/bindings.js";

/** In-memory fakes — same "fake, not mocked-network" testing style as
 * `FakeAdapter` for backends: exercises the real router logic without
 * hitting Telegram or a real daemon. */
function fakeBindings(initial: Record<string, string> = {}): BindingsStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    async get(chatId) {
      return data[chatId];
    },
    async set(chatId, sessionId) {
      data[chatId] = sessionId;
    },
    async clear(chatId) {
      delete data[chatId];
    },
  };
}

interface FakeDaemon extends DaemonClient {
  createCalls: number;
  sendCalls: Array<{ sessionId: string; text: string }>;
  sessions: Map<string, { id: string; model?: string; permission: "safe" | "edit" | "full" }>;
  nextResult: { ok: boolean; finalText: string };
  failSendOnce: boolean;
}

function fakeDaemon(): FakeDaemon {
  let counter = 0;
  const sessions = new Map<string, { id: string; model?: string; permission: "safe" | "edit" | "full" }>();
  return {
    createCalls: 0,
    sendCalls: [],
    sessions,
    nextResult: { ok: true, finalText: "done" },
    failSendOnce: false,
    async createSession(input) {
      this.createCalls++;
      const id = `session-${++counter}`;
      sessions.set(id, { id, permission: input.permission ?? "edit" });
      return { id };
    },
    async sendMessage(sessionId, text) {
      if (this.failSendOnce) {
        this.failSendOnce = false;
        throw new Error("no such session (simulated)");
      }
      this.sendCalls.push({ sessionId, text });
      return this.nextResult;
    },
    async getSession(sessionId) {
      return sessions.get(sessionId);
    },
    async patchSession(sessionId, patch) {
      const existing = sessions.get(sessionId);
      if (!existing) throw new Error("no such session");
      if (patch.model !== undefined) existing.model = patch.model;
      if (patch.permission !== undefined) existing.permission = patch.permission;
      return existing;
    },
  };
}

function deps(overrides: Partial<TelegramRouterDeps> = {}): { deps: TelegramRouterDeps; daemon: FakeDaemon; bindings: ReturnType<typeof fakeBindings> } {
  const daemon = fakeDaemon();
  const bindings = fakeBindings();
  return {
    daemon,
    bindings,
    deps: {
      daemon,
      bindings,
      allowedChatIds: new Set(["42"]),
      defaults: { backend: "claude", cwd: "/repo", permission: "edit" },
      ...overrides,
    },
  };
}

test("chunkTelegramText splits long text into Telegram-sized chunks", () => {
  const chunks = chunkTelegramText("a".repeat(9000), 4000);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]!.length, 4000);
  assert.equal(chunks[2]!.length, 1000);
  assert.equal(chunks.join(""), "a".repeat(9000));
});

test("chunkTelegramText never returns an empty array for empty text", () => {
  assert.deepEqual(chunkTelegramText(""), ["(no output)"]);
});

test("an unauthorized chat is told its id and nothing is forwarded", async () => {
  const { deps: d, daemon } = deps({ allowedChatIds: new Set() });
  const replies = await routeTelegramMessage(d, "999", "hello");
  assert.equal(replies.length, 1);
  assert.match(replies[0]!, /999/);
  assert.match(replies[0]!, /not authorized|isn't authorized/);
  assert.equal(daemon.createCalls, 0, "an unauthorized chat must never create a session");
});

test("a plain message from a new chat creates a session with the configured defaults", async () => {
  const { deps: d, daemon, bindings } = deps();
  const replies = await routeTelegramMessage(d, "42", "add a health check endpoint");
  assert.equal(daemon.createCalls, 1);
  assert.equal(daemon.sendCalls.length, 1);
  assert.equal(daemon.sendCalls[0]!.text, "add a health check endpoint");
  assert.deepEqual(replies, ["done"]);
  assert.equal(bindings.data["42"], "session-1", "the chat should now be bound to the created session");
});

test("a second message from the same chat reuses the bound session instead of creating another", async () => {
  const { deps: d, daemon } = deps();
  await routeTelegramMessage(d, "42", "first");
  await routeTelegramMessage(d, "42", "second");
  assert.equal(daemon.createCalls, 1, "only the first message should create a session");
  assert.deepEqual(daemon.sendCalls.map((c) => c.sessionId), ["session-1", "session-1"]);
});

test("a failed turn is surfaced with a warning prefix", async () => {
  const { deps: d, daemon } = deps();
  daemon.nextResult = { ok: false, finalText: "crashed" };
  const replies = await routeTelegramMessage(d, "42", "do something");
  assert.deepEqual(replies, ["⚠️ turn failed: crashed"]);
});

test("a stale binding pointing at a deleted session self-heals by creating a fresh one", async () => {
  const { deps: d, daemon, bindings } = deps();
  await bindings.set("42", "session-stale");
  daemon.failSendOnce = true;
  const replies = await routeTelegramMessage(d, "42", "hello again");
  assert.deepEqual(replies, ["done"]);
  assert.equal(daemon.createCalls, 1, "should have created exactly one replacement session");
  assert.equal(bindings.data["42"], "session-1", "the binding should now point at the freshly created session");
});

test("/new clears the binding without touching the daemon", async () => {
  const { deps: d, daemon, bindings } = deps();
  await bindings.set("42", "session-existing");
  const replies = await routeTelegramMessage(d, "42", "/new");
  assert.deepEqual(replies, ["started a fresh session — send a message to begin."]);
  assert.equal(bindings.data["42"], undefined);
  assert.equal(daemon.createCalls, 0);
  assert.equal(daemon.sendCalls.length, 0);
});

test("/id reports the bound session, or that there isn't one yet", async () => {
  const { deps: d, bindings } = deps();
  assert.deepEqual(await routeTelegramMessage(d, "42", "/id"), ["(no active session yet — send a message to start one)"]);
  await bindings.set("42", "session-7");
  assert.deepEqual(await routeTelegramMessage(d, "42", "/id"), ["bound to session session-7"]);
});

test("/model requires an active session and a model id", async () => {
  const { deps: d, bindings, daemon } = deps();
  assert.deepEqual(await routeTelegramMessage(d, "42", "/model gpt-5"), ["no active session yet — send a message first, then /model <id>."]);
  daemon.sessions.set("session-7", { id: "session-7", permission: "edit" });
  await bindings.set("42", "session-7");
  assert.deepEqual(await routeTelegramMessage(d, "42", "/model"), ["usage: /model <model-id>"]);
  assert.deepEqual(await routeTelegramMessage(d, "42", "/model gpt-5"), ["model set to gpt-5"]);
});

test("/permission validates the tier and requires an active session", async () => {
  const { deps: d, bindings, daemon } = deps();
  assert.deepEqual(await routeTelegramMessage(d, "42", "/permission nonsense"), ["usage: /permission safe|edit|full"]);
  daemon.sessions.set("session-7", { id: "session-7", permission: "edit" });
  await bindings.set("42", "session-7");
  assert.deepEqual(await routeTelegramMessage(d, "42", "/permission safe"), ["permission set to safe"]);
});

test("a long final answer is chunked across multiple Telegram messages", async () => {
  const { deps: d, daemon } = deps();
  daemon.nextResult = { ok: true, finalText: "x".repeat(9000) };
  const replies = await routeTelegramMessage(d, "42", "give me a lot of output");
  assert.equal(replies.length, 3);
  assert.equal(replies.join("").length, 9000);
});
