import { test } from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "../src/process/cli-runner.js";

test("streams stdout lines and reports a clean exit", async () => {
  const proc = runProcess("node", ["-e", "console.log('a'); console.log('b');"], {
    cwd: process.cwd(),
    env: process.env,
  });
  const lines: string[] = [];
  for await (const line of proc.lines) lines.push(line);
  const result = await proc.done;
  assert.deepEqual(lines, ["a", "b"]);
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
});

test("captures stderr and a non-zero exit code", async () => {
  const proc = runProcess("node", ["-e", "console.error('boom'); process.exit(3);"], {
    cwd: process.cwd(),
    env: process.env,
  });
  for await (const _line of proc.lines) {
    /* no stdout expected */
  }
  const result = await proc.done;
  assert.equal(result.code, 3);
  assert.match(result.stderr, /boom/);
});

test("abort signal kills the process before it finishes", async () => {
  const controller = new AbortController();
  const proc = runProcess("node", ["-e", "setTimeout(() => {}, 60000);"], {
    cwd: process.cwd(),
    env: process.env,
    signal: controller.signal,
  });
  controller.abort();
  const result = await proc.done;
  assert.equal(result.aborted, true);
  assert.notEqual(result.code, 0);
});

test("timeout kills a long-running process and flags timedOut", async () => {
  const proc = runProcess("node", ["-e", "setTimeout(() => {}, 60000);"], {
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 100,
  });
  const result = await proc.done;
  assert.equal(result.timedOut, true);
});

test("kills the whole process group, including children spawned by the CLI", async () => {
  // Simulate what claude/codex/gemini do: spawn a detached grandchild that
  // would otherwise outlive its parent's death, and have it report its PID
  // so we can verify it was actually reaped — not just that the immediate
  // child exited.
  const proc = runProcess(
    "node",
    [
      "-e",
      "const c = require('child_process').spawn('sleep', ['30']); console.log(c.pid); setTimeout(() => {}, 60000);",
    ],
    { cwd: process.cwd(), env: process.env },
  );
  const iterator = proc.lines[Symbol.asyncIterator]();
  const { value: pidLine } = await iterator.next();
  const grandchildPid = Number(pidLine);
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);

  proc.kill("SIGTERM");
  await proc.done;

  // Verifying a real OS process actually died is inherently a wall-clock
  // operation (the kernel delivers/reaps signals asynchronously) — fake
  // timers can't stand in for the platform scheduler here, so we poll with
  // short real delays bounded to ~2s total instead of a single fixed sleep.
  let alive = true;
  for (let i = 0; i < 20 && alive; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      process.kill(grandchildPid, 0);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, "grandchild process should have been killed along with the process group");
});
