import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PkwnConfig } from "../src/config.js";
import { BackendRegistry } from "../src/backends/registry.js";
import { SessionManager } from "../src/session-manager.js";
import { FakeAdapter, successTurn, rateLimitedTurn, crashOnceTurn } from "./helpers/fake-adapter.js";

async function withTempConfig(fn: (config: PkwnConfig) => Promise<void>): Promise<void> {
  const pkwnHome = await mkdtemp(join(tmpdir(), "pkwn-test-"));
  try {
    await fn({
      pkwnHome,
      port: 0,
      bindHost: "127.0.0.1",
      defaultTurnTimeoutMs: 5_000,
      maxTurnRetries: 2,
      backends: {},
    });
  } finally {
    await rm(pkwnHome, { recursive: true, force: true });
  }
}

test("session runs a turn end to end and persists to disk", async () => {
  await withTempConfig(async (config) => {
    const fake = new FakeAdapter("claude");
    fake.script = [(opts) => successTurn(`hello from ${opts.prompt}`)];
    const registry = new BackendRegistry(config, [fake]);
    const sessions = new SessionManager(config, registry);
    await sessions.init();

    const meta = await sessions.create({ backend: "claude", cwd: "/tmp" });
    assert.equal(meta.status, "idle");

    const result = await sessions.sendMessage(meta.id, "world");
    assert.equal(result.ok, true);
    assert.equal(result.finalText, "hello from world");
    assert.equal(sessions.get(meta.id)?.status, "idle");
    assert.equal(sessions.get(meta.id)?.backendSessionId, "fake-session-1");
    assert.equal(sessions.get(meta.id)?.title, "world", "first message becomes the session title");

    const tail = await sessions.transcriptTail(meta.id, 100);
    assert.ok(tail.length > 0, "transcript should have entries");
  });
});

test("rate-limited turn marks the session rate_limited and does not retry", async () => {
  await withTempConfig(async (config) => {
    const fake = new FakeAdapter("codex");
    fake.script = [() => rateLimitedTurn()];
    const registry = new BackendRegistry(config, [fake]);
    const sessions = new SessionManager(config, registry);
    await sessions.init();

    const meta = await sessions.create({ backend: "codex", cwd: "/tmp" });
    const result = await sessions.sendMessage(meta.id, "hi");

    assert.equal(result.ok, false);
    assert.equal(fake.callCount, 1, "rate limit must not trigger an automatic retry");
    assert.equal(sessions.get(meta.id)?.status, "rate_limited");
  });
});

test("transient crash is retried and can succeed on a later attempt", async () => {
  await withTempConfig(async (config) => {
    const fake = new FakeAdapter("gemini");
    fake.script = [() => crashOnceTurn(), (opts) => successTurn(`recovered:${opts.prompt}`)];
    const registry = new BackendRegistry(config, [fake]);
    const sessions = new SessionManager(config, registry);
    await sessions.init();

    const meta = await sessions.create({ backend: "gemini", cwd: "/tmp" });
    const result = await sessions.sendMessage(meta.id, "retry-me");

    assert.equal(fake.callCount, 2, "should have retried once after the transient crash");
    assert.equal(result.ok, true);
    assert.equal(result.finalText, "recovered:retry-me");
  });
});

test("turns on one session are serialized, never concurrent", async () => {
  await withTempConfig(async (config) => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const fake = new FakeAdapter("claude");
    fake.script = [
      async function* (opts) {
        // Signals as soon as this turn's body actually begins executing.
        // Because SessionManager chains turns with `queue.then(...)`, a
        // second turn's generator provably cannot start running until this
        // one's promise settles — so once `started` resolves, callCount
        // staying at 1 is a guarantee, not a timing guess.
        started.resolve();
        yield { type: "started", backendSessionId: "fake-session-1" };
        await gate.promise;
        yield* successTurn(opts.prompt);
      },
    ];
    const registry = new BackendRegistry(config, [fake]);
    const sessions = new SessionManager(config, registry);
    await sessions.init();

    const meta = await sessions.create({ backend: "claude", cwd: "/tmp" });
    const first = sessions.sendMessage(meta.id, "a");
    const second = sessions.sendMessage(meta.id, "b");

    await started.promise;
    assert.equal(fake.callCount, 1, "second turn must not start until the first completes");

    gate.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(fake.callCount, 2);
    assert.equal(firstResult.ok, true);
    assert.equal(secondResult.ok, true);
  });
});

test("session surviving a restart is reloaded as interrupted if left running", async () => {
  await withTempConfig(async (config) => {
    const fake = new FakeAdapter("claude");
    const registry = new BackendRegistry(config, [fake]);
    const sessions = new SessionManager(config, registry);
    await sessions.init();
    const meta = await sessions.create({ backend: "claude", cwd: "/tmp" });

    // Simulate a daemon crash mid-turn: hand-write status "running" straight
    // into the sessions.db row, the same way a real crash would leave it.
    const db = new DatabaseSync(join(config.pkwnHome, "sessions.db"));
    db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run("running", meta.id);
    db.close();

    const reloaded = new SessionManager(config, registry);
    await reloaded.init();
    assert.equal(reloaded.get(meta.id)?.status, "interrupted");
  });
});

test("oversized transcript is rotated instead of growing forever", async () => {
  await withTempConfig(async (config) => {
    const fake = new FakeAdapter("claude");
    fake.script = [(opts) => successTurn(`ok:${opts.prompt}`)];
    const registry = new BackendRegistry(config, [fake]);
    const sessions = new SessionManager(config, registry);
    await sessions.init();
    const meta = await sessions.create({ backend: "claude", cwd: "/tmp" });

    // Bloat transcript_entries directly, well past the rotation threshold,
    // the same way a long-running session's own turns would over time.
    const db = new DatabaseSync(join(config.pkwnHome, "sessions.db"));
    const payload = JSON.stringify({ type: "warning", message: "x".repeat(500) });
    const insert = db.prepare("INSERT INTO transcript_entries (session_id, ts, direction, payload) VALUES (?, ?, 'out', ?)");
    const targetBytes = 21 * 1024 * 1024;
    const rowCount = Math.ceil(targetBytes / payload.length);
    for (let i = 0; i < rowCount; i++) insert.run(meta.id, new Date().toISOString(), payload);

    const sizeOf = (): number =>
      (db.prepare("SELECT COALESCE(SUM(LENGTH(payload)), 0) as total FROM transcript_entries WHERE session_id = ?").get(meta.id) as { total: number })
        .total;
    const before = sizeOf();
    assert.ok(before > 20 * 1024 * 1024, "test setup should exceed the rotation threshold");

    await sessions.sendMessage(meta.id, "trigger rotation");

    const after = sizeOf();
    // Rotation keeps ~half the prior rows (plus the newly appended turn),
    // so allow slack above exactly 50% instead of asserting a hairline cut.
    assert.ok(after < before * 0.6, "transcript should have been rotated down to roughly half its prior size");
    db.close();
  });
});

test("answerAsk resolves a pending ask_user_question tool call mid-turn", async () => {
  await withTempConfig(async (config) => {
    const { promise: registered, resolve: signalRegistered } = Promise.withResolvers<void>();
    const fake = new FakeAdapter("claude");
    fake.script = [
      async function* (opts) {
        yield { type: "started", backendSessionId: "fake-session-1" };
        // `opts.ask` registers its pending entry synchronously before
        // returning a promise, so signalling right after the call (and
        // before awaiting it) tells the test exactly when it's safe to
        // call `answerAsk` — no wall-clock guess needed.
        const askPromise = opts.ask!({
          id: "call-1",
          question: "which stack?",
          options: [{ label: "Next.js" }, { label: "Express" }],
          allowMultiple: false,
        });
        signalRegistered();
        const answer = await askPromise;
        yield { type: "tool_call", id: "call-1", name: "ask_user_question", input: { question: "which stack?" } };
        yield { type: "tool_result", id: "call-1", output: `user chose: ${answer.join(", ")}`, isError: false };
        yield { type: "text", role: "assistant", text: "ok", partial: false };
        yield { type: "turn_complete", ok: true };
      },
    ];
    const registry = new BackendRegistry(config, [fake]);
    const sessions = new SessionManager(config, registry);
    await sessions.init();
    const meta = await sessions.create({ backend: "claude", cwd: "/tmp" });
    sessions.subscribe(meta.id, () => {}); // simulates an attached interactive client

    const turn = sessions.sendMessage(meta.id, "pick a stack");
    await registered;
    assert.equal(sessions.answerAsk(meta.id, "call-1", ["Next.js"]), true);
    // A stale/unknown id is a harmless no-op, not an error.
    assert.equal(sessions.answerAsk(meta.id, "no-such-id", ["x"]), false);

    const result = await turn;
    assert.equal(result.ok, true);
    const toolResult = result.events.find((e) => e.type === "tool_result");
    assert.equal(toolResult?.output, "user chose: Next.js");
  });
});

test("cancelPendingAsks abandons a pending question instead of hanging the turn", async () => {
  await withTempConfig(async (config) => {
    const { promise: registered, resolve: signalRegistered } = Promise.withResolvers<void>();
    const fake = new FakeAdapter("claude");
    fake.script = [
      async function* (opts) {
        yield { type: "started", backendSessionId: "fake-session-1" };
        const askPromise = opts.ask!({ id: "call-1", question: "which stack?", options: [{ label: "a" }], allowMultiple: false });
        signalRegistered();
        const answer = await askPromise;
        yield { type: "tool_result", id: "call-1", output: answer.length === 0 ? "dismissed" : answer.join(", "), isError: false };
        yield { type: "turn_complete", ok: true };
      },
    ];
    const registry = new BackendRegistry(config, [fake]);
    const sessions = new SessionManager(config, registry);
    await sessions.init();
    const meta = await sessions.create({ backend: "claude", cwd: "/tmp" });
    sessions.subscribe(meta.id, () => {}); // simulates an attached interactive client

    const turn = sessions.sendMessage(meta.id, "pick a stack");
    await registered;
    sessions.cancelPendingAsks(meta.id);

    const result = await turn;
    assert.equal(result.ok, true);
    const toolResult = result.events.find((e) => e.type === "tool_result");
    assert.equal(toolResult?.output, "dismissed");
  });
});

test("ask rejects immediately when no interactive client is attached, instead of hanging", async () => {
  await withTempConfig(async (config) => {
    const fake = new FakeAdapter("claude");
    fake.script = [
      async function* (opts) {
        yield { type: "started", backendSessionId: "fake-session-1" };
        let message = "unexpectedly resolved";
        try {
          await opts.ask!({ id: "call-1", question: "which stack?", options: [{ label: "a" }], allowMultiple: false });
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        yield { type: "tool_result", id: "call-1", output: message, isError: true };
        yield { type: "turn_complete", ok: true };
      },
    ];
    const registry = new BackendRegistry(config, [fake]);
    const sessions = new SessionManager(config, registry);
    await sessions.init();
    const meta = await sessions.create({ backend: "claude", cwd: "/tmp" });
    // Deliberately no `sessions.subscribe(...)` here — nothing is attached.

    const result = await sessions.sendMessage(meta.id, "pick a stack");
    assert.equal(result.ok, true);
    const toolResult = result.events.find((e) => e.type === "tool_result");
    assert.equal(toolResult?.output, "no interactive client attached to this session");
  });
});
