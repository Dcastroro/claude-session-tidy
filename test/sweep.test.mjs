import test from "node:test";
import assert from "node:assert/strict";
import { daysUntil, isDesktopEntrypoint, needsTouch, sweepOf } from "../src/sweep.mjs";

const DAY = 86400000;
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const ret = (days = 30, extra = {}) => ({ days, paused: null, desktopDays: 0, ...extra });

// Every row repeats something the real Claude Code 2.1.295 did in test/e2e-retention.test.mjs.
test("an ordinary session goes a period after its file was last modified", () => {
  const s = sweepOf({ mtimeMs: NOW - 5 * DAY, desktop: false, marker: null }, ret(30), NOW);
  assert.deepEqual(s, { state: "scheduled", dueMs: NOW + 25 * DAY });
  assert.equal(daysUntil(s.dueMs, NOW), 25);
  assert.equal(sweepOf({ mtimeMs: NOW - 31 * DAY, desktop: false, marker: null }, ret(30), NOW).state, "due");
  assert.equal(sweepOf({ mtimeMs: NOW - 30 * DAY, desktop: false, marker: null }, ret(30), NOW).state, "due", "exactly one period old is due");
  assert.equal(sweepOf({ mtimeMs: NOW - 5 * DAY, desktop: false, marker: null }, ret(1), NOW).state, "due");
  assert.equal(daysUntil(NOW + 0.2 * DAY, NOW), 1, "days are rounded up: today is the last day");
  assert.equal(daysUntil(NOW - 2 * DAY, NOW), -2);
});

test("a session started by Claude Desktop is skipped by the cleanup", () => {
  const s = sweepOf({ mtimeMs: NOW - 90 * DAY, desktop: true, marker: null }, ret(30), NOW);
  assert.deepEqual(s, { state: "exempt", dueMs: null });
});

test("... until the Desktop app releases it: delete frees it at once, archive after a period", () => {
  const old = NOW - 90 * DAY;
  assert.equal(sweepOf({ mtimeMs: old, desktop: true, marker: { reason: "delete", mtimeMs: NOW } }, ret(30), NOW).state, "due");
  assert.equal(sweepOf({ mtimeMs: old, desktop: true, marker: { reason: "archive", mtimeMs: NOW - 31 * DAY } }, ret(30), NOW).state, "due");
  const grace = sweepOf({ mtimeMs: old, desktop: true, marker: { reason: "archive", mtimeMs: NOW - 5 * DAY } }, ret(30), NOW);
  assert.deepEqual(grace, { state: "scheduled", dueMs: NOW + 25 * DAY }, "a fresh archive marker keeps it a period longer");
  assert.equal(sweepOf({ mtimeMs: old, desktop: true, marker: { reason: "", mtimeMs: NOW - 99 * DAY } }, ret(30), NOW).state, "exempt", "a marker without a known reason releases nothing");
  assert.equal(sweepOf({ mtimeMs: NOW - 5 * DAY, desktop: true, marker: { reason: "delete", mtimeMs: NOW } }, ret(30), NOW).state, "scheduled", "released, but the file itself is not old enough yet");
});

test("desktopSessionCleanupPeriodDays is a ceiling: past it a desktop session goes like any other", () => {
  const r = ret(1, { desktopDays: 3 });
  assert.deepEqual(sweepOf({ mtimeMs: NOW - 2 * DAY, desktop: true, marker: null }, r, NOW), { state: "scheduled", dueMs: NOW + 1 * DAY });
  assert.equal(sweepOf({ mtimeMs: NOW - 5 * DAY, desktop: true, marker: null }, r, NOW).state, "due");
  assert.equal(sweepOf({ mtimeMs: NOW - 5 * DAY, desktop: true, marker: null }, ret(1, { desktopDays: 0 }), NOW).state, "exempt");
});

test("a paused cleanup has no day", () => {
  assert.deepEqual(sweepOf({ mtimeMs: NOW - 99 * DAY, desktop: false, marker: null }, ret(30, { paused: { file: "f", reason: "r" } }), NOW), { state: "paused", dueMs: null });
});

test("isDesktopEntrypoint knows the three desktop-host entrypoints", () => {
  for (const e of ["claude-desktop", "claude-desktop-3p", "local-agent", "local_agent"]) assert.ok(isDesktopEntrypoint(e), e);
  for (const e of ["cli", "sdk-cli", "claude-vscode", "", undefined, "claude-desktop-x"]) assert.ok(!isDesktopEntrypoint(e), String(e));
});

test("needsTouch is true once half of the period is used up", () => {
  assert.ok(!needsTouch(NOW - 14 * DAY, 30, NOW));
  assert.ok(needsTouch(NOW - 15 * DAY, 30, NOW));
  assert.ok(needsTouch(NOW - 40 * DAY, 30, NOW));
  assert.ok(!needsTouch(NOW + DAY, 30, NOW), "a file dated in the future needs nothing");
  assert.ok(needsTouch(NOW - 13 * 3600e3, 1, NOW));
  assert.ok(!needsTouch(NOW - 11 * 3600e3, 1, NOW));
});
