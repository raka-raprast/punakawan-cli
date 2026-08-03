import { test } from "node:test";
import assert from "node:assert/strict";
import { allCommandNames, COMMANDS, matchCommands, suggestCommand } from "../src/tui/commands.js";

test("COMMANDS includes /init", () => {
  assert.ok(COMMANDS.some((c) => c.name === "init"), "/init must be a registered command");
});

test("matchCommands with an empty prefix returns every command (bare '/')", () => {
  assert.equal(matchCommands("").length, COMMANDS.length);
});

test("matchCommands filters by prefix, case-insensitively", () => {
  const matches = matchCommands("MOD").map((c) => c.name);
  assert.deepEqual(matches, ["model"]);
});

test("matchCommands matches on aliases too", () => {
  const matches = matchCommands("qui").map((c) => c.name);
  assert.deepEqual(matches, ["exit"]); // /quit is an alias of the "exit" command
});

test("matchCommands returns nothing for a prefix no command starts with", () => {
  assert.deepEqual(matchCommands("zzz"), []);
});

test("suggestCommand corrects a near-miss typo", () => {
  assert.equal(suggestCommand("modle"), "model");
  assert.equal(suggestCommand("iniit"), "init");
  assert.equal(suggestCommand("hlp"), "help");
});

test("suggestCommand declines to guess for something unrelated to any command", () => {
  assert.equal(suggestCommand("bananas"), undefined);
});

test("suggestCommand returns undefined for an empty string", () => {
  assert.equal(suggestCommand(""), undefined);
});

test("allCommandNames includes every alias", () => {
  const names = allCommandNames();
  assert.ok(names.includes("exit"));
  assert.ok(names.includes("quit"));
});
