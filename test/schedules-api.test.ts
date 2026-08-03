import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { PkwnConfig } from "../src/config.js";
import { BackendRegistry } from "../src/backends/registry.js";
import { SessionManager } from "../src/session-manager.js";
import { Scheduler } from "../src/scheduler.js";
import { createApiServer } from "../src/api/server.js";
import { FakeAdapter, successTurn } from "./helpers/fake-adapter.js";

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface ScheduleResponse {
  id: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  nextFireAt: string;
  lastResult?: string;
}
interface ScheduleListResponse {
  schedules: ScheduleResponse[];
}
interface ErrorResponse {
  error: string;
}

async function withScheduledServer(fn: (base: string, scheduler: Scheduler, fake: FakeAdapter) => Promise<void>): Promise<void> {
  const pkwnHome = await mkdtemp(join(tmpdir(), "pkwn-schedules-api-test-"));
  const config: PkwnConfig = { pkwnHome, port: 0, bindHost: "127.0.0.1", defaultTurnTimeoutMs: 5_000, maxTurnRetries: 1, backends: {} };
  const fake = new FakeAdapter("claude");
  fake.script = [(opts) => successTurn(`ran:${opts.prompt}`)];
  const registry = new BackendRegistry(config, [fake]);
  const sessions = new SessionManager(config, registry);
  await sessions.init();
  const scheduler = new Scheduler(config, sessions);
  await scheduler.init();
  const server = createApiServer(config, registry, sessions, scheduler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base, scheduler, fake);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(pkwnHome, { recursive: true, force: true });
  }
}

test("without a scheduler wired, schedule routes simply don't exist (404, not a crash)", async () => {
  const pkwnHome = await mkdtemp(join(tmpdir(), "pkwn-no-scheduler-test-"));
  const config: PkwnConfig = { pkwnHome, port: 0, bindHost: "127.0.0.1", defaultTurnTimeoutMs: 5_000, maxTurnRetries: 1, backends: {} };
  const registry = new BackendRegistry(config, [new FakeAdapter("claude")]);
  const sessions = new SessionManager(config, registry);
  await sessions.init();
  const server = createApiServer(config, registry, sessions); // no scheduler passed
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/schedules`);
    assert.equal(res.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(pkwnHome, { recursive: true, force: true });
  }
});

test("POST /v1/schedules creates a schedule, GET /v1/schedules lists it", async () => {
  await withScheduledServer(async (base) => {
    const create = await fetch(`${base}/v1/schedules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cron: "0 8 * * *", prompt: "daily report", backend: "claude", cwd: "/repo" }),
    });
    assert.equal(create.status, 201);
    const created = await readJson<ScheduleResponse>(create);
    assert.equal(created.prompt, "daily report");
    assert.ok(created.nextFireAt);

    const list = await readJson<ScheduleListResponse>(await fetch(`${base}/v1/schedules`));
    assert.equal(list.schedules.length, 1);
    assert.equal(list.schedules[0]!.id, created.id);
  });
});

test("POST /v1/schedules rejects a malformed cron expression with 400, not 500", async () => {
  await withScheduledServer(async (base) => {
    const res = await fetch(`${base}/v1/schedules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cron: "not a cron", prompt: "x", backend: "claude", cwd: "/repo" }),
    });
    assert.equal(res.status, 400);
    const body = await readJson<ErrorResponse>(res);
    assert.match(body.error, /cron/);
  });
});

test("POST /v1/schedules rejects a missing required field with 400", async () => {
  await withScheduledServer(async (base) => {
    const res = await fetch(`${base}/v1/schedules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cron: "0 8 * * *", backend: "claude", cwd: "/repo" }), // missing prompt
    });
    assert.equal(res.status, 400);
  });
});

test("GET /v1/schedules/:id 404s for an unknown id", async () => {
  await withScheduledServer(async (base) => {
    const res = await fetch(`${base}/v1/schedules/no-such-id`);
    assert.equal(res.status, 404);
  });
});

test("PATCH /v1/schedules/:id updates the cron and can disable a schedule", async () => {
  await withScheduledServer(async (base) => {
    const created = await readJson<ScheduleResponse>(
      await fetch(`${base}/v1/schedules`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cron: "0 8 * * *", prompt: "x", backend: "claude", cwd: "/repo" }),
      }),
    );
    const patched = await readJson<ScheduleResponse>(
      await fetch(`${base}/v1/schedules/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false, cron: "0 9 * * *" }),
      }),
    );
    assert.equal(patched.enabled, false);
    assert.equal(patched.cron, "0 9 * * *");
    assert.notEqual(patched.nextFireAt, created.nextFireAt);
  });
});

test("POST /v1/schedules/:id/run fires immediately through the real session pipeline", async () => {
  await withScheduledServer(async (base, _scheduler, fake) => {
    const created = await readJson<ScheduleResponse>(
      await fetch(`${base}/v1/schedules`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cron: "0 0 1 1 *", prompt: "manual check", backend: "claude", cwd: "/repo" }),
      }),
    );
    const run = await fetch(`${base}/v1/schedules/${created.id}/run`, { method: "POST" });
    assert.equal(run.status, 200);
    const result = await readJson<{ ok: boolean; finalText: string }>(run);
    assert.equal(result.ok, true);
    assert.equal(result.finalText, "ran:manual check");
    assert.equal(fake.callCount, 1);
  });
});

test("DELETE /v1/schedules/:id removes it", async () => {
  await withScheduledServer(async (base) => {
    const created = await readJson<ScheduleResponse>(
      await fetch(`${base}/v1/schedules`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cron: "0 8 * * *", prompt: "x", backend: "claude", cwd: "/repo" }),
      }),
    );
    const del = await fetch(`${base}/v1/schedules/${created.id}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const getAfter = await fetch(`${base}/v1/schedules/${created.id}`);
    assert.equal(getAfter.status, 404);
  });
});
