import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBindingsStore } from "../src/gateway/bindings.js";

async function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "pkwn-bindings-test-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("get returns undefined for a chat that was never bound", async () => {
  await withTempHome(async (home) => {
    const store = createFileBindingsStore(home);
    assert.equal(await store.get("42"), undefined);
  });
});

test("set then get round-trips, and persists across a fresh store instance", async () => {
  await withTempHome(async (home) => {
    await createFileBindingsStore(home).set("42", "session-1");
    // A brand-new store instance reads the same file — proves it's
    // durable across a gateway restart, not just in-memory.
    const reloaded = createFileBindingsStore(home);
    assert.equal(await reloaded.get("42"), "session-1");
  });
});

test("bindings for different chats don't clobber each other", async () => {
  await withTempHome(async (home) => {
    const store = createFileBindingsStore(home);
    await store.set("42", "session-a");
    await store.set("99", "session-b");
    assert.equal(await store.get("42"), "session-a");
    assert.equal(await store.get("99"), "session-b");
  });
});

test("clear removes only the targeted chat's binding", async () => {
  await withTempHome(async (home) => {
    const store = createFileBindingsStore(home);
    await store.set("42", "session-a");
    await store.set("99", "session-b");
    await store.clear("42");
    assert.equal(await store.get("42"), undefined);
    assert.equal(await store.get("99"), "session-b");
  });
});

test("clearing a chat that was never bound is a harmless no-op", async () => {
  await withTempHome(async (home) => {
    const store = createFileBindingsStore(home);
    await store.clear("no-such-chat");
    assert.equal(await store.get("no-such-chat"), undefined);
  });
});

test("set overwrites a chat's prior binding", async () => {
  await withTempHome(async (home) => {
    const store = createFileBindingsStore(home);
    await store.set("42", "session-old");
    await store.set("42", "session-new");
    assert.equal(await store.get("42"), "session-new");
  });
});
