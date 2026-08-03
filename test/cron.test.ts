import { test } from "node:test";
import assert from "node:assert/strict";
import { nextCronFire, parseCron } from "../src/cron.js";

test("parseCron rejects an expression without exactly 5 fields", () => {
  assert.throws(() => parseCron("* * * *"), /exactly 5 fields/);
  assert.throws(() => parseCron("* * * * * *"), /exactly 5 fields/);
});

test("parseCron rejects an out-of-range value", () => {
  assert.throws(() => parseCron("60 * * * *"), /out of range/);
  assert.throws(() => parseCron("* 24 * * *"), /out of range/);
  assert.throws(() => parseCron("* * 32 * *"), /out of range/);
  assert.throws(() => parseCron("* * * 13 *"), /out of range/);
});

test("parseCron rejects a malformed segment", () => {
  assert.throws(() => parseCron("abc * * * *"), /invalid cron field segment/);
  assert.throws(() => parseCron("*/0 * * * *"), /step must be positive/);
});

test("parseCron normalizes day-of-week 7 to 0 (Sunday alias)", () => {
  const cron = parseCron("* * * * 7");
  assert.ok(cron.dayOfWeek.has(0));
  assert.ok(!cron.dayOfWeek.has(7));
});

test("parseCron expands lists, ranges, and steps", () => {
  assert.deepEqual([...parseCron("1,2,3 * * * *").minute].sort((a, b) => a - b), [1, 2, 3]);
  assert.deepEqual([...parseCron("10-12 * * * *").minute].sort((a, b) => a - b), [10, 11, 12]);
  assert.deepEqual([...parseCron("*/15 * * * *").minute].sort((a, b) => a - b), [0, 15, 30, 45]);
});

test("nextCronFire('* * * * *') fires on the very next minute", () => {
  const next = nextCronFire("* * * * *", new Date("2026-08-03T10:15:30Z"));
  assert.equal(next.toISOString(), "2026-08-03T10:16:00.000Z");
});

test("nextCronFire rolls to the next day when today's time has passed", () => {
  const next = nextCronFire("0 8 * * *", new Date("2026-08-03T10:15:30Z"));
  assert.equal(next.toISOString(), "2026-08-04T08:00:00.000Z");
});

test("nextCronFire fires later the same day when the time hasn't passed yet", () => {
  const next = nextCronFire("0 8 * * *", new Date("2026-08-03T05:00:00Z"));
  assert.equal(next.toISOString(), "2026-08-03T08:00:00.000Z");
});

test("nextCronFire respects day-of-week (2026-08-03 is a Monday)", () => {
  const next = nextCronFire("0 9 * * 1", new Date("2026-08-03T10:15:30Z"));
  assert.equal(next.toISOString(), "2026-08-10T09:00:00.000Z", "this Monday's 9am already passed, so next Monday");
});

test("nextCronFire rolls over month and year boundaries", () => {
  const next = nextCronFire("0 0 1 * *", new Date("2026-12-15T00:00:00Z"));
  assert.equal(next.toISOString(), "2027-01-01T00:00:00.000Z");
});

test("nextCronFire handles a leap-day-only expression across non-leap years", () => {
  const next = nextCronFire("0 0 29 2 *", new Date("2026-08-03T00:00:00Z"));
  assert.equal(next.toISOString(), "2028-02-29T00:00:00.000Z", "2027 has no Feb 29; the next one is 2028");
});

test("nextCronFire combines day-of-month and day-of-week with OR semantics when both are restricted", () => {
  // 2026-08-15 is a Saturday; 2026-08-07 is the nearest Friday before it.
  const next = nextCronFire("0 12 15 * 5", new Date("2026-08-01T00:00:00Z"));
  assert.equal(next.toISOString(), "2026-08-07T12:00:00.000Z");
});

test("nextCronFire throws for an impossible calendar date instead of hanging", () => {
  assert.throws(() => nextCronFire("0 0 31 2 *", new Date()), /no matching fire time/);
});

test("nextCronFire is strictly after 'after', even exactly on a boundary", () => {
  const next = nextCronFire("0 8 * * *", new Date("2026-08-03T08:00:00Z"));
  assert.equal(next.toISOString(), "2026-08-04T08:00:00.000Z", "already-fired-this-minute must roll to the next occurrence, not repeat");
});
