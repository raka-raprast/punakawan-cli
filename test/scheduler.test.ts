import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PkwnConfig } from "../src/config.js";
import { BackendRegistry } from "../src/backends/registry.js";
import { SessionManager } from "../src/session-manager.js";
import { Scheduler } from "../src/scheduler.js";
import { FakeAdapter, successTurn } from "./helpers/fake-adapter.js";

async function withScheduler(
  fn: (scheduler: Scheduler, sessions: SessionManager, fake: FakeAdapter, config: PkwnConfig) => Promise<void>,
): Promise<void> {
  const pkwnHome = await mkdtemp(join(tmpdir(), "pkwn-scheduler-test-"));
  try {
    const config: PkwnConfig = { pkwnHome, port: 0, bindHost: "127.0.0.1", defaultTurnTimeoutMs: 5_000, maxTurnRetries: 1, backends: {} };
    const fake = new FakeAdapter("claude");
    const registry = new BackendRegistry(config, [fake]);
    const sessions = new SessionManager(config, registry);
    await sessions.init();
    const scheduler = new Scheduler(config, sessions);
    await scheduler.init();
    await fn(scheduler, sessions, fake, config);
  } finally {
    await rm(pkwnHome, { recursive: true, force: true });
  }
}

test("create validates the cron expression up front and computes an initial nextFireAt", async () => {
  await withScheduler(async (scheduler) => {
    const meta = await scheduler.create({ cron: "0 8 * * *", prompt: "daily report", backend: "claude", cwd: "/repo" });
    assert.ok(meta.nextFireAt);
    assert.equal(meta.enabled, true);
    assert.equal(meta.permission, "edit", "defaults to edit like session creation");
    await assert.rejects(scheduler.create({ cron: "nonsense", prompt: "x", backend: "claude", cwd: "/repo" }), /cron expression must have exactly 5 fields/);
  });
});

test("a due schedule fires exactly once per tick, creates a session, and reschedules for the next occurrence", async () => {
  await withScheduler(async (scheduler, sessions, fake) => {
    fake.script = [(opts) => successTurn(`ran: ${opts.prompt}`)];
    const meta = await scheduler.create({ cron: "* * * * *", prompt: "check the build", backend: "claude", cwd: "/repo" });

    const due = new Date(new Date(meta.nextFireAt).getTime());
    await scheduler.tick(due);

    assert.equal(fake.callCount, 1);
    const after = scheduler.get(meta.id)!;
    assert.equal(after.lastResult, "ok");
    assert.equal(after.lastFireAt !== undefined, true);
    assert.ok(after.sessionId, "should have created and bound a session");
    assert.ok(new Date(after.nextFireAt).getTime() > due.getTime(), "should be rescheduled strictly after the fire time");

    // The same session is reused on the next fire instead of creating another.
    const secondFire = new Date(after.nextFireAt);
    await scheduler.tick(secondFire);
    assert.equal(fake.callCount, 2);
    assert.equal(scheduler.get(meta.id)!.sessionId, after.sessionId);
    assert.equal(sessions.list().length, 1, "still just one session across two fires");
  });
});

test("a disabled schedule never fires", async () => {
  await withScheduler(async (scheduler, _sessions, fake) => {
    fake.script = [(opts) => successTurn(opts.prompt)];
    const meta = await scheduler.create({ cron: "* * * * *", prompt: "x", backend: "claude", cwd: "/repo", enabled: false });
    await scheduler.tick(new Date(new Date(meta.nextFireAt).getTime() + 60_000));
    assert.equal(fake.callCount, 0);
  });
});

test("a schedule not yet due is left alone", async () => {
  await withScheduler(async (scheduler, _sessions, fake) => {
    fake.script = [(opts) => successTurn(opts.prompt)];
    const meta = await scheduler.create({ cron: "0 0 1 1 *", prompt: "yearly", backend: "claude", cwd: "/repo" }); // next Jan 1st
    await scheduler.tick(new Date(new Date(meta.nextFireAt).getTime() - 60_000));
    assert.equal(fake.callCount, 0);
  });
});

test("a failed turn records lastResult 'error' and still reschedules", async () => {
  await withScheduler(async (scheduler, _sessions, fake) => {
    fake.script = [
      async function* () {
        yield { type: "error" as const, kind: "unknown" as const, message: "boom", retryable: false };
        yield { type: "turn_complete" as const, ok: false };
      },
    ];
    const meta = await scheduler.create({ cron: "* * * * *", prompt: "x", backend: "claude", cwd: "/repo" });
    const before = meta.nextFireAt;
    await scheduler.tick(new Date(new Date(meta.nextFireAt).getTime()));
    const after = scheduler.get(meta.id)!;
    assert.equal(after.lastResult, "error");
    assert.notEqual(after.nextFireAt, before, "must still reschedule even though the turn failed");
  });
});

test("runNow fires immediately without disturbing nextFireAt", async () => {
  await withScheduler(async (scheduler, _sessions, fake) => {
    fake.script = [(opts) => successTurn(`manual: ${opts.prompt}`)];
    const meta = await scheduler.create({ cron: "0 0 1 1 *", prompt: "yearly report", backend: "claude", cwd: "/repo" });
    const result = await scheduler.runNow(meta.id);
    assert.equal(result.ok, true);
    assert.equal(result.finalText, "manual: yearly report");
    assert.equal(scheduler.get(meta.id)!.nextFireAt, meta.nextFireAt, "a manual run is out of band from the cron cadence");
    assert.equal(fake.callCount, 1);
  });
});

test("update re-validates and recomputes nextFireAt when the cron expression changes", async () => {
  await withScheduler(async (scheduler) => {
    const meta = await scheduler.create({ cron: "0 0 1 1 *", prompt: "x", backend: "claude", cwd: "/repo" });
    const originalNextFireAt = meta.nextFireAt; // `update` mutates this same in-memory object, same convention as SessionManager.update
    await assert.rejects(scheduler.update(meta.id, { cron: "garbage" }), /cron expression must have exactly 5 fields/);
    const updated = await scheduler.update(meta.id, { cron: "0 9 * * *" });
    assert.notEqual(updated.nextFireAt, originalNextFireAt);
    assert.equal(updated.cron, "0 9 * * *");
  });
});

test("update can disable a schedule and remove can delete it", async () => {
  await withScheduler(async (scheduler) => {
    const meta = await scheduler.create({ cron: "* * * * *", prompt: "x", backend: "claude", cwd: "/repo" });
    const disabled = await scheduler.update(meta.id, { enabled: false });
    assert.equal(disabled.enabled, false);
    await scheduler.remove(meta.id);
    assert.equal(scheduler.get(meta.id), undefined);
    await assert.rejects(scheduler.remove(meta.id), /no such schedule/);
  });
});

test("schedules persist across a fresh Scheduler instance pointed at the same pkwnHome", async () => {
  await withScheduler(async (scheduler, _sessions, _fake, config) => {
    const meta = await scheduler.create({ cron: "0 8 * * *", prompt: "daily report", backend: "claude", cwd: "/repo" });
    const registry2 = new BackendRegistry(config, [new FakeAdapter("claude")]);
    const sessions2 = new SessionManager(config, registry2);
    await sessions2.init();
    const reloaded = new Scheduler(config, sessions2);
    await reloaded.init();
    assert.equal(reloaded.get(meta.id)?.prompt, "daily report");
  });
});

test("a stale sessionId binding (session deleted elsewhere) is replaced rather than erroring", async () => {
  await withScheduler(async (scheduler, sessions, fake) => {
    fake.script = [(opts) => successTurn(opts.prompt)];
    const orphanSession = await sessions.create({ backend: "claude", cwd: "/repo" });
    const meta = await scheduler.create({ cron: "* * * * *", prompt: "x", backend: "claude", cwd: "/repo", sessionId: orphanSession.id });
    await sessions.remove(orphanSession.id);
    await scheduler.tick(new Date(new Date(meta.nextFireAt).getTime()));
    const after = scheduler.get(meta.id)!;
    assert.equal(after.lastResult, "ok");
    assert.notEqual(after.sessionId, orphanSession.id, "should have created a fresh session in place of the deleted one");
  });
});

test("tick guards against overlapping runs — a slow fire in flight is not double-fired", async () => {
  await withScheduler(async (scheduler, _sessions, fake) => {
    const gate = Promise.withResolvers<void>();
    fake.script = [
      async function* (opts) {
        yield { type: "started" as const, backendSessionId: "s1" };
        await gate.promise;
        yield* successTurn(opts.prompt);
      },
    ];
    const meta = await scheduler.create({ cron: "* * * * *", prompt: "slow", backend: "claude", cwd: "/repo" });
    const due = new Date(new Date(meta.nextFireAt).getTime());

    const firstTick = scheduler.tick(due);
    const secondTick = scheduler.tick(due); // lands while the first is still awaiting the gate
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(fake.callCount, 1, "the overlapping tick must not have started a second fire");
    gate.resolve();
    await Promise.all([firstTick, secondTick]);
    assert.equal(fake.callCount, 1);
  });
});
