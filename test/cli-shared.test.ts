import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { PkwnConfig } from "../src/config.js";
import type { TranscriptEntry } from "../src/types.js";
import { BackendRegistry } from "../src/backends/registry.js";
import { SessionManager } from "../src/session-manager.js";
import { createApiServer } from "../src/api/server.js";
import { transcriptToTurns } from "../src/cli-shared.js";
import { FakeAdapter, successTurn } from "./helpers/fake-adapter.js";

test("transcriptToTurns groups events between 'in' entries into one turn", () => {
  const entries: TranscriptEntry[] = [
    { ts: "t1", direction: "in", payload: { text: "hello" } },
    { ts: "t2", direction: "out", payload: { type: "started", backendSessionId: "s1" } },
    { ts: "t3", direction: "out", payload: { type: "text", role: "assistant", text: "hi", partial: false } },
    { ts: "t4", direction: "out", payload: { type: "turn_complete", ok: true } },
  ];
  const turns = transcriptToTurns(entries);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.userText, "hello");
  assert.equal(turns[0]!.events.length, 3);
});

test("transcriptToTurns starts a fresh turn on every 'in' entry", () => {
  const entries: TranscriptEntry[] = [
    { ts: "t1", direction: "in", payload: { text: "first" } },
    { ts: "t2", direction: "out", payload: { type: "text", role: "assistant", text: "a", partial: false } },
    { ts: "t3", direction: "in", payload: { text: "second" } },
    { ts: "t4", direction: "out", payload: { type: "text", role: "assistant", text: "b", partial: false } },
  ];
  const turns = transcriptToTurns(entries);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.userText, "first");
  assert.equal(turns[1]!.userText, "second");
});

test("transcriptToTurns tolerates a tail that starts mid-turn (rotated transcript)", () => {
  const entries: TranscriptEntry[] = [{ ts: "t1", direction: "out", payload: { type: "text", role: "assistant", text: "orphaned", partial: false } }];
  const turns = transcriptToTurns(entries);
  assert.equal(turns.length, 1);
  assert.notEqual(turns[0]!.userText, "");
  assert.equal(turns[0]!.events.length, 1);
});

test("resuming a session round-trips its full turn (text, tool call, diff) through the real API", async () => {
  const pkwnHome = await mkdtemp(join(tmpdir(), "pkwn-cli-shared-test-"));
  const config: PkwnConfig = { pkwnHome, port: 0, bindHost: "127.0.0.1", defaultTurnTimeoutMs: 5_000, maxTurnRetries: 1, backends: {} };
  const fake = new FakeAdapter("claude");
  fake.script = [
    async function* () {
      yield { type: "started", backendSessionId: "fake-session-1" };
      yield { type: "tool_call", id: "call-1", name: "read_file", input: { path: "a.txt" } };
      yield { type: "tool_result", id: "call-1", output: "file contents", isError: false };
      yield { type: "text", role: "assistant", text: "done reading", partial: false };
      yield { type: "turn_complete", ok: true };
    },
  ];
  const registry = new BackendRegistry(config, [fake]);
  const sessions = new SessionManager(config, registry);
  await sessions.init();
  const server = createApiServer(config, registry, sessions);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const create = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backend: "claude", cwd: "/tmp" }),
    });
    const meta = (await create.json()) as { id: string };

    await fetch(`${base}/v1/sessions/${meta.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "please read a.txt" }),
    });

    // Simulates exactly what `/resume` does: fetch the session detail with
    // a generous tail and regroup it back into displayable turns.
    const detail = (await (await fetch(`${base}/v1/sessions/${meta.id}?tail=500`)).json()) as { transcriptTail: TranscriptEntry[] };
    const turns = transcriptToTurns(detail.transcriptTail);

    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.userText, "please read a.txt");
    const kinds = turns[0]!.events.map((e) => e.type);
    assert.deepEqual(kinds, ["started", "tool_call", "tool_result", "text", "turn_complete"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(pkwnHome, { recursive: true, force: true });
  }
});
