// Generic subprocess driver: spawns a CLI, yields stdout line-by-line, caps
// captured stderr, enforces a timeout, and kills the whole process group
// (not just the immediate child) on abort/timeout so a coding agent's own
// spawned sub-shells never survive their session.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const STDERR_CAP = 64 * 1024;

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  stderr: string;
}

export interface RunningProcess {
  lines: AsyncIterable<string>;
  /** Resolves once the process has fully exited. */
  done: Promise<ProcessResult>;
  kill(signal?: NodeJS.Signals): void;
}

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Spawn `cmd args` in its own process group and stream stdout lines. */
export function runProcess(
  cmd: string,
  args: string[],
  opts: RunOptions,
): RunningProcess {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group, so we can kill the whole tree
  });

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < STDERR_CAP) {
      stderr += chunk.toString("utf8");
      if (stderr.length > STDERR_CAP) stderr = stderr.slice(0, STDERR_CAP);
    }
  });

  let timedOut = false;
  let aborted = false;
  let killedAlready = false;

  const killTree = (signal: NodeJS.Signals) => {
    if (killedAlready) return;
    killedAlready = true;
    try {
      if (child.pid) process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* already dead */
      }
    }
  };

  let escalateTimer: NodeJS.Timeout | undefined;
  const requestStop = (reason: "timeout" | "abort") => {
    if (reason === "timeout") timedOut = true;
    else aborted = true;
    killTree("SIGTERM");
    escalateTimer = setTimeout(() => killTree("SIGKILL"), 5_000);
  };

  const timeoutTimer = opts.timeoutMs
    ? setTimeout(() => requestStop("timeout"), opts.timeoutMs)
    : undefined;

  const onAbort = () => requestStop("abort");
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const rl = createInterface({ input: child.stdout });
  const lineQueue: string[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;

  rl.on("line", (line) => {
    lineQueue.push(line);
    waiters.shift()?.();
  });
  rl.on("close", () => {
    closed = true;
    waiters.shift()?.();
  });

  async function* lineGenerator(): AsyncGenerator<string, void, void> {
    while (true) {
      if (lineQueue.length > 0) {
        yield lineQueue.shift()!;
        continue;
      }
      if (closed) return;
      const gate = Promise.withResolvers<void>();
      waiters.push(gate.resolve);
      await gate.promise;
    }
  }

  const doneGate = Promise.withResolvers<ProcessResult>();
  child.on("close", (code, signal) => {
    clearTimeout(timeoutTimer);
    clearTimeout(escalateTimer);
    opts.signal?.removeEventListener("abort", onAbort);
    doneGate.resolve({ code, signal, timedOut, aborted, stderr });
  });
  // Spawn failures (binary not on PATH, permission denied, ...) surface as
  // an 'error' event, sometimes with no 'close' event at all — without this
  // handler that 'error' event is unhandled and crashes the whole daemon.
  child.on("error", (err) => {
    closed = true;
    waiters.shift()?.();
    clearTimeout(timeoutTimer);
    clearTimeout(escalateTimer);
    opts.signal?.removeEventListener("abort", onAbort);
    doneGate.resolve({ code: null, signal: null, timedOut, aborted, stderr: stderr || err.message });
  });
  const done = doneGate.promise;

  return {
    lines: { [Symbol.asyncIterator]: lineGenerator },
    done,
    kill: (signal = "SIGTERM") => killTree(signal),
  };
}
