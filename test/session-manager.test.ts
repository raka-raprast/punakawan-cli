import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    // Simulate a daemon crash mid-turn: hand-write status "running" to disk.
    const metaPath = join(config.pkwnHome, "sessions", meta.id, "meta.json");
    const onDisk = JSON.parse(await readFile(metaPath, "utf8"));
    onDisk.status = "running";
    await writeFile(metaPath, JSON.stringify(onDisk));

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

    const transcriptPath = join(config.pkwnHome, "sessions", meta.id, "transcript.jsonl");
    const line = JSON.stringify({ ts: new Date().toISOString(), direction: "out", payload: { type: "warning", message: "x".repeat(500) } });
    const targetBytes = 21 * 1024 * 1024;
    const lineCount = Math.ceil(targetBytes / (line.length + 1));
    await writeFile(transcriptPath, (line + "\n").repeat(lineCount), "utf8");
    const before = (await stat(transcriptPath)).size;
    assert.ok(before > 20 * 1024 * 1024, "test setup should exceed the rotation threshold");

    await sessions.sendMessage(meta.id, "trigger rotation");

    const after = (await stat(transcriptPath)).size;
    // Rotation keeps ~half the prior lines (plus the newly appended turn),
    // so allow slack above exactly 50% instead of asserting a hairline cut.
    assert.ok(after < before * 0.6, "transcript should have been rotated down to roughly half its prior size");
    const lines = (await readFile(transcriptPath, "utf8")).split("\n").filter(Boolean);
    for (const l of lines) assert.doesNotThrow(() => JSON.parse(l), "every retained line must still be valid JSON");
  });
});
