import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { PkwnConfig } from "../src/config.js";
import { BackendRegistry } from "../src/backends/registry.js";
import { SessionManager } from "../src/session-manager.js";
import { createApiServer } from "../src/api/server.js";
import { FakeAdapter, successTurn } from "./helpers/fake-adapter.js";

// `Response.json()` is untyped by the fetch spec (it can't know our route
// shapes) — each call site names the shape it expects instead of leaving
// `unknown` to propagate through every assertion below.
async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface SessionResponse {
  id: string;
  backend: string;
  status: string;
  transcriptTail?: unknown[];
}
interface SessionListResponse {
  sessions: SessionResponse[];
}
interface SendMessageResponse {
  ok: boolean;
  finalText: string;
}
interface ChatCompletionResponse {
  pkwn_session_id?: string;
  choices: Array<{ message: { content: string } }>;
}
interface HealthResponse {
  ok: boolean;
}

async function withServer(
  apiKey: string | undefined,
  fn: (base: string, headers: Record<string, string>) => Promise<void>,
): Promise<void> {
  const pkwnHome = await mkdtemp(join(tmpdir(), "pkwn-api-test-"));
  const config: PkwnConfig = {
    pkwnHome,
    port: 0,
    bindHost: "127.0.0.1",
    apiKey,
    defaultTurnTimeoutMs: 5_000,
    maxTurnRetries: 1,
    backends: {},
  };
  const fake = new FakeAdapter("claude");
  fake.script = [(opts) => successTurn(`echo:${opts.prompt}`)];
  const registry = new BackendRegistry(config, [fake]);
  const sessions = new SessionManager(config, registry);
  await sessions.init();
  const server = createApiServer(config, registry, sessions);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};

  try {
    await fn(base, headers);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(pkwnHome, { recursive: true, force: true });
  }
}

test("healthz is reachable without auth even when an API key is configured", async () => {
  await withServer("secret", async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    const body = await readJson<HealthResponse>(res);
    assert.equal(body.ok, true);
  });
});

test("protected routes reject missing or wrong bearer token", async () => {
  await withServer("secret", async (base) => {
    const noAuth = await fetch(`${base}/v1/sessions`);
    assert.equal(noAuth.status, 401);

    const wrongAuth = await fetch(`${base}/v1/sessions`, { headers: { authorization: "Bearer nope" } });
    assert.equal(wrongAuth.status, 401);

    const rightAuth = await fetch(`${base}/v1/sessions`, { headers: { authorization: "Bearer secret" } });
    assert.equal(rightAuth.status, 200);
  });
});

test("session CRUD + message round trip", async () => {
  await withServer(undefined, async (base, headers) => {
    const create = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ backend: "claude", cwd: "/tmp" }),
    });
    assert.equal(create.status, 201);
    const meta = await readJson<SessionResponse>(create);
    assert.equal(meta.backend, "claude");

    const list = await readJson<SessionListResponse>(await fetch(`${base}/v1/sessions`, { headers }));
    assert.equal(list.sessions.length, 1);

    const sendResult = await readJson<SendMessageResponse>(
      await fetch(`${base}/v1/sessions/${meta.id}/messages`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      }),
    );
    assert.equal(sendResult.ok, true);
    assert.equal(sendResult.finalText, "echo:hi");

    const getOne = await readJson<SessionResponse>(await fetch(`${base}/v1/sessions/${meta.id}`, { headers }));
    assert.equal(getOne.status, "idle");
    assert.ok((getOne.transcriptTail?.length ?? 0) > 0);

    const del = await fetch(`${base}/v1/sessions/${meta.id}`, { method: "DELETE", headers });
    assert.equal(del.status, 200);

    const missing = await fetch(`${base}/v1/sessions/${meta.id}`, { headers });
    assert.equal(missing.status, 404);
  });
});

test("DELETE on a nonexistent session returns 404, not 500", async () => {
  await withServer(undefined, async (base, headers) => {
    const res = await fetch(`${base}/v1/sessions/does-not-exist`, { method: "DELETE", headers });
    assert.equal(res.status, 404);
  });
});

test("PATCH updates a session's model and permission", async () => {
  await withServer(undefined, async (base, headers) => {
    const meta = await readJson<SessionResponse>(
      await fetch(`${base}/v1/sessions`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ backend: "claude", cwd: "/tmp" }),
      }),
    );

    const patched = await readJson<SessionResponse & { model?: string; permission?: string }>(
      await fetch(`${base}/v1/sessions/${meta.id}`, {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ model: "opus", permission: "full" }),
      }),
    );
    assert.equal(patched.model, "opus");
    assert.equal(patched.permission, "full");

    const rejected = await fetch(`${base}/v1/sessions/${meta.id}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ permission: "not-a-real-tier" }),
    });
    assert.equal(rejected.status, 400);

    const missing = await fetch(`${base}/v1/sessions/does-not-exist`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ model: "x" }),
    });
    assert.equal(missing.status, 404);
  });
});

test("OpenAI-compatible non-streaming chat completion creates and reuses a session", async () => {
  await withServer(undefined, async (base, headers) => {
    const first = await readJson<ChatCompletionResponse>(
      await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude:sonnet",
          cwd: "/tmp",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );
    assert.equal(first.choices[0]?.message.content, "echo:hello");
    assert.ok(first.pkwn_session_id);

    const second = await readJson<ChatCompletionResponse>(
      await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude:sonnet",
          session_id: first.pkwn_session_id,
          messages: [{ role: "user", content: "again" }],
        }),
      }),
    );
    assert.equal(second.choices[0]?.message.content, "echo:again");
    assert.equal(second.pkwn_session_id, first.pkwn_session_id);
  });
});

test("OpenAI-compatible streaming chat completion emits SSE chunks and a DONE sentinel", async () => {
  await withServer(undefined, async (base, headers) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude:sonnet",
        cwd: "/tmp",
        stream: true,
        messages: [{ role: "user", content: "stream-me" }],
      }),
    });
    assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const raw = await res.text();
    assert.match(raw, /data: \[DONE\]/);

    interface ChunkFrame {
      choices: Array<{ delta: { content?: string } }>;
    }
    const content = raw
      .split("\n\n")
      .map((frame) => frame.replace(/^data: /, ""))
      .filter((data) => data && data !== "[DONE]")
      .map((data) => (JSON.parse(data) as ChunkFrame).choices[0]?.delta.content ?? "")
      .join("");
    assert.equal(content, "echo:stream-me");
  });
});

test("ephemeral chat completion does not persist a session", async () => {
  await withServer(undefined, async (base, headers) => {
    await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude:sonnet",
        cwd: "/tmp",
        ephemeral: true,
        messages: [{ role: "user", content: "one-shot" }],
      }),
    });
    const list = await readJson<SessionListResponse>(await fetch(`${base}/v1/sessions`, { headers }));
    assert.equal(list.sessions.length, 0);
  });
});
