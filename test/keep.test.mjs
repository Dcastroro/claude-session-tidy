import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { keepSessions, readKeep, refreshKept, touchTargets, unkeepSessions } from "../src/keep.mjs";
import { logError, errorLogFile } from "../src/errorlog.mjs";
import { makeStore, resolveIds } from "../src/sessions.mjs";
import { keepFile } from "../src/config.mjs";
import { DAY, NOW, addBystanders, mtimeOf, run, runCli, session, snapshot, world } from "./helpers.mjs";

const ID_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const keep = (w, refs, opts = {}) => keepSessions(w.env, resolveIds(w.env, refs), { now: NOW, ...opts });
const mt = (w, rel) => mtimeOf(path.join(w.claude, ...rel.split("/")));

test("keep records the session and touches the files the cleanup judges by their time", () => {
  const w = world("keep");
  const a = session(w, { id: ID_A, project: "shop", companions: true, ageDays: 25 });
  const by = addBystanders(w.claude, a.slug, ID_B);
  fs.writeFileSync(path.join(a.dir, `${ID_A}.desktop-released.json`), '{"reason":"archive"}');
  fs.utimesSync(path.join(a.dir, `${ID_A}.desktop-released.json`), new Date(NOW - 25 * DAY), new Date(NOW - 25 * DAY));
  const bystanderTimes = Object.fromEntries(by.map((r) => [r, mt(w, r)]));
  const [r] = keep(w, ["aaaaaaaa"]);
  assert.deepEqual([r.id, r.already], [ID_A, false]);
  assert.equal(readKeep(w.env).status, "ok");
  assert.deepEqual(Object.keys(readKeep(w.env).kept), [ID_A]);
  assert.equal(readKeep(w.env).kept[ID_A].since, new Date(NOW).toISOString());
  assert.equal(readKeep(w.env).kept[ID_A].slug, a.slug);
  const shape = JSON.parse(fs.readFileSync(keepFile(w.env), "utf8"));
  assert.equal(shape.version, 1);
  // touched: the transcript, every file of the session's folder, the todo file
  for (const rel of [`projects/${a.slug}/${ID_A}.jsonl`, `projects/${a.slug}/${ID_A}/tool-results/toolu_01.txt`, `projects/${a.slug}/${ID_A}/subagents/agent-a1b2c3.jsonl`, `projects/${a.slug}/${ID_A}/custom-title.json`, `todos/${ID_A}-agent-${ID_A}.json`]) {
    assert.equal(mt(w, rel), NOW, `${rel} was touched`);
  }
  assert.equal(r.files, 7, "the transcript, five files in the session's folder, one todo file");
  // not touched: what the cleanup does not judge by time, the Desktop app's marker, and everything of others
  for (const rel of [`file-history/${ID_A}/0fb339eae9426361@v1`, `session-env/${ID_A}/env.sh`, `uploads/${ID_A}/shot.png`, `debug/${ID_A}.txt`, `projects/${a.slug}/${ID_A}.desktop-released.json`]) {
    assert.equal(mt(w, rel), NOW - 25 * DAY, `${rel} was not touched`);
  }
  for (const rel of by) assert.equal(mt(w, rel), bystanderTimes[rel], `${rel} was not touched`);
});

test("keeping a session again touches it again and remembers when it was first kept", () => {
  const w = world("keep");
  const a = session(w, { id: ID_A, project: "shop", ageDays: 25 });
  keep(w, [ID_A], { now: NOW - 10 * DAY });
  const [r] = keep(w, [ID_A]);
  assert.equal(r.already, true);
  assert.equal(readKeep(w.env).kept[ID_A].since, new Date(NOW - 10 * DAY).toISOString());
  assert.equal(mt(w, `projects/${a.slug}/${ID_A}.jsonl`), NOW);
});

test("keep several at once; an unknown or ambiguous id stops everything before anything is touched", () => {
  const w = world("keep");
  const a = session(w, { id: ID_A, project: "shop", ageDays: 25 });
  session(w, { id: ID_B, project: "shop", ageDays: 25 });
  assert.throws(() => keep(w, ["aaaaaaaa", "ffffffff"]), /No session has the id "ffffffff"/);
  assert.equal(mt(w, `projects/${a.slug}/${ID_A}.jsonl`), NOW - 25 * DAY);
  assert.ok(!fs.existsSync(keepFile(w.env)));
  assert.equal(keep(w, ["aaaaaaaa", "bbbbbb"]).length, 2);
  assert.deepEqual(Object.keys(readKeep(w.env).kept).sort(), [ID_A, ID_B]);
});

test("keep --dry-run touches nothing and writes nothing", () => {
  const w = world("keep");
  session(w, { id: ID_A, project: "shop", companions: true, ageDays: 25 });
  const before = snapshot(w.claude);
  const [r] = keep(w, [ID_A], { dryRun: true });
  assert.ok(r.files > 0);
  assert.deepEqual(snapshot(w.claude), before);
});

test("a keep.json that is not valid is never overwritten", () => {
  const w = world("keep");
  session(w, { id: ID_A, project: "shop", ageDays: 25 });
  fs.mkdirSync(path.dirname(keepFile(w.env)), { recursive: true });
  for (const bad of ["{ nope", "[]", '{"kept":[]}', '{"version":1}', "null", ""]) {
    fs.writeFileSync(keepFile(w.env), bad);
    assert.equal(readKeep(w.env).status, "invalid", JSON.stringify(bad));
    assert.throws(() => keep(w, [ID_A]), /keep\.json .*so I left it alone/);
    assert.throws(() => unkeepSessions(w.env, [ID_A]), /so I left it alone/);
    assert.equal(fs.readFileSync(keepFile(w.env), "utf8"), bad);
  }
  assert.equal(mtimeOf(path.join(w.claude, "projects")) > 0, true);
});

test("readKeep ignores entries it cannot use and keeps the rest", () => {
  const w = world("keep");
  fs.mkdirSync(path.dirname(keepFile(w.env)), { recursive: true });
  fs.writeFileSync(keepFile(w.env), JSON.stringify({ version: 1, kept: { [ID_A]: { since: "2026-10-01T00:00:00.000Z", slug: "s" }, "../evil": {}, "a/b": {}, [ID_B]: "text" } }));
  const k = readKeep(w.env);
  assert.deepEqual(Object.keys(k.kept).sort(), [ID_A, ID_B]);
  assert.deepEqual(k.kept[ID_B], { since: "", slug: "" });
  assert.equal(readKeep(world("none").env).status, "missing");
});

test("unkeep takes sessions off the list, also those whose files are gone", () => {
  const w = world("keep");
  const a = session(w, { id: ID_A, project: "shop", ageDays: 25 });
  session(w, { id: ID_B, project: "shop", ageDays: 25 });
  keep(w, [ID_A, ID_B]);
  fs.rmSync(a.file);
  const r = unkeepSessions(w.env, ["aaaaaaaa"], {});
  assert.deepEqual(r, { released: [ID_A], notKept: [] });
  assert.deepEqual(Object.keys(readKeep(w.env).kept), [ID_B]);
  assert.throws(() => unkeepSessions(w.env, ["ffffffff"], {}), /No kept session has the id "ffffffff"\. Kept: bbbbbbbb/);
  assert.throws(() => unkeepSessions(w.env, [], {}), /Which session\?/);
  const again = unkeepSessions(w.env, [ID_B], { dryRun: true });
  assert.deepEqual(again.released, [ID_B]);
  assert.deepEqual(Object.keys(readKeep(w.env).kept), [ID_B], "dry run");
  const unknown = unkeepSessions(w.env, ["bbbbbbbb", "cccccccc"], { exists: (ref) => ref === "cccccccc" });
  assert.deepEqual(unknown, { released: [ID_B], notKept: ["cccccccc"] });
});

test("touchTargets lists exactly the files the cleanup judges one by one", () => {
  const w = world("keep");
  const a = session(w, { id: ID_A, project: "shop", companions: true });
  fs.writeFileSync(path.join(a.dir, `${ID_A}.ccr-tip.json`), "{}");
  fs.writeFileSync(path.join(a.dir, `${ID_A}.desktop-released.json`), "{}");
  const rels = touchTargets(makeStore(w.env), { id: ID_A, slug: a.slug, dir: a.dir, file: a.file }).map((f) => path.relative(w.claude, f).split(path.sep).join("/")).sort();
  assert.deepEqual(rels, [
    `projects/${a.slug}/${ID_A}.ccr-tip.json`,
    `projects/${a.slug}/${ID_A}.jsonl`,
    `projects/${a.slug}/${ID_A}/custom-title.json`,
    `projects/${a.slug}/${ID_A}/subagents/agent-a1b2c3.jsonl`,
    `projects/${a.slug}/${ID_A}/subagents/agent-a1b2c3.meta.json`,
    `projects/${a.slug}/${ID_A}/tool-results/toolu_01.txt`,
    `projects/${a.slug}/${ID_A}/tool-results/toolu_02.txt`,
    `todos/${ID_A}-agent-${ID_A}.json`,
  ].sort());
});

test("refresh touches kept sessions that have used up half their time, and only those", () => {
  const w = world("refresh");
  const old = session(w, { id: ID_A, project: "shop", companions: true, ageDays: 20 });
  const recent = session(w, { id: ID_B, project: "shop", ageDays: 5 });
  keep(w, [ID_A, ID_B], { now: NOW - 30 * DAY });
  // keep touched them back then; put the times where the test wants them
  for (const [s, days] of [[old, 20], [recent, 5]]) {
    const t = new Date(NOW - days * DAY);
    fs.utimesSync(s.file, t, t);
    if (s === old) fs.utimesSync(path.join(old.dir, ID_A, "tool-results", "toolu_01.txt"), t, t);
  }
  const r = refreshKept(w.env, { now: NOW });
  assert.equal(r.kept, 2);
  assert.deepEqual(r.touched.map((t) => t.id), [ID_A]);
  assert.deepEqual(r.skipped, [{ id: ID_B, reason: "recent" }]);
  assert.deepEqual(r.missing, []);
  assert.equal(mtimeOf(old.file), NOW);
  assert.equal(mtimeOf(path.join(old.dir, ID_A, "tool-results", "toolu_01.txt")), NOW);
  assert.equal(mtimeOf(recent.file), NOW - 5 * DAY, "a session with plenty of time left is not moved to the front of claude --continue");
});

test("refresh uses the project's own cleanupPeriodDays when run in that project", () => {
  const w = world("refresh");
  const s = session(w, { id: ID_A, project: "shop", ageDays: 5 });
  keep(w, [ID_A], { now: NOW - 30 * DAY });
  fs.utimesSync(s.file, new Date(NOW - 5 * DAY), new Date(NOW - 5 * DAY));
  assert.equal(refreshKept(w.env, { now: NOW }).touched.length, 0, "5 days of 30 is nothing");
  fs.mkdirSync(path.join(s.root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(s.root, ".claude", "settings.json"), '{"cleanupPeriodDays":7}');
  assert.equal(refreshKept(w.env, { now: NOW, projectDir: s.root, dryRun: true }).touched.length, 1, "5 days of 7 is more than half");
  assert.equal(mtimeOf(s.file), NOW - 5 * DAY, "dry run");
  assert.equal(refreshKept(w.env, { now: NOW, projectDir: s.root }).touched.length, 1);
  assert.equal(mtimeOf(s.file), NOW);
});

test("refresh reports kept sessions that no longer exist, and leaves Claude Desktop sessions to the app", () => {
  const w = world("refresh");
  const gone = session(w, { id: ID_A, project: "shop", ageDays: 20 });
  const desk = session(w, { id: ID_B, project: "shop", ageDays: 90, entrypoint: "claude-desktop" });
  keep(w, [ID_A, ID_B], { now: NOW - 90 * DAY });
  fs.utimesSync(desk.file, new Date(NOW - 90 * DAY), new Date(NOW - 90 * DAY));
  fs.rmSync(gone.file);
  const r = refreshKept(w.env, { now: NOW });
  assert.deepEqual(r.missing, [ID_A]);
  assert.deepEqual(r.skipped, [{ id: ID_B, reason: "exempt" }]);
  assert.equal(mtimeOf(desk.file), NOW - 90 * DAY);
  // once the Desktop app releases it, it is an ordinary session
  fs.writeFileSync(path.join(desk.dir, `${ID_B}.desktop-released.json`), '{"reason":"delete"}');
  assert.equal(refreshKept(w.env, { now: NOW }).touched.length, 1);
  assert.equal(mtimeOf(desk.file), NOW);
});

test("refresh with no keep list is a quiet no-op, and with an invalid one it says so", () => {
  const w = world("refresh");
  session(w, { id: ID_A, project: "shop" });
  assert.deepEqual(refreshKept(w.env, { now: NOW }), { kept: 0, touched: [], skipped: [], missing: [] });
  fs.mkdirSync(path.dirname(keepFile(w.env)), { recursive: true });
  fs.writeFileSync(keepFile(w.env), "{ no");
  assert.throws(() => refreshKept(w.env, { now: NOW }), /keep\.json is not valid JSON/);
});

test("refresh finds a kept session even when its project folder was renamed", () => {
  const w = world("refresh");
  const s = session(w, { id: ID_A, project: "shop", ageDays: 20 });
  keep(w, [ID_A], { now: NOW - 30 * DAY });
  const moved = path.join(w.claude, "projects", "renamed-project");
  fs.renameSync(s.dir, moved);
  fs.utimesSync(path.join(moved, `${ID_A}.jsonl`), new Date(NOW - 20 * DAY), new Date(NOW - 20 * DAY));
  const r = refreshKept(w.env, { now: NOW });
  assert.deepEqual(r.touched.map((t) => t.id), [ID_A]);
});

test("refresh --quiet prints nothing at all, exits 0, and leaves a line in errors.log when it fails", async () => {
  const w = world("quiet");
  const s = session(w, { id: ID_A, project: "shop", ageDays: 20 });
  keep(w, [ID_A], { now: NOW - 30 * DAY });
  fs.utimesSync(s.file, new Date(Date.now() - 20 * DAY), new Date(Date.now() - 20 * DAY));
  const ok = runCli(["refresh", "--quiet"], { cwd: w.base, env: w.env });
  assert.deepEqual([ok.code, ok.out, ok.err], [0, "", ""]);
  assert.ok(Date.now() - mtimeOf(s.file) < 60000, "it did its work");
  assert.ok(!fs.existsSync(errorLogFile(w.env)));
  fs.writeFileSync(keepFile(w.env), "{ broken");
  const bad = runCli(["refresh", "--quiet"], { cwd: w.base, env: w.env });
  assert.deepEqual([bad.code, bad.out, bad.err], [0, "", ""], "a failing hook must not print anything either");
  assert.match(fs.readFileSync(errorLogFile(w.env), "utf8"), /^\d{4}-\d\d-\d\dT[\d:.]+Z .*keep\.json is not valid JSON\n$/);
  const viaMain = await run(["refresh", "--quiet"], w, { cwd: w.base });
  assert.deepEqual([viaMain.code, viaMain.all], [0, ""]);
});

test("refresh prints a summary without --quiet, and JSON with --json", async () => {
  const w = world("refresh");
  const s = session(w, { id: ID_A, project: "shop", ageDays: 20 });
  keep(w, [ID_A, ID_B].slice(0, 1), { now: NOW - 30 * DAY });
  fs.utimesSync(s.file, new Date(NOW - 20 * DAY), new Date(NOW - 20 * DAY));
  const text = await run(["refresh"], w);
  assert.equal(text.code, 0);
  assert.match(text.out, /^Refreshed 1 of 1 kept session\n  aaaaaaaa  \d+ files?\n$/);
  const none = await run(["refresh"], world("empty"));
  assert.equal(none.out, "No sessions are kept. keep <id> adds one.\n");
  const json = await run(["refresh", "--json"], w);
  assert.deepEqual(JSON.parse(json.out), { ok: true, dryRun: false, kept: 1, touched: [], skipped: [{ id: ID_A, reason: "recent" }], missing: [] });
});

test("the error log is capped", () => {
  const w = world("log");
  for (let i = 0; i < 2000; i++) logError(w.env, `problem number ${i} ${"x".repeat(40)}`, NOW + i);
  const text = fs.readFileSync(errorLogFile(w.env), "utf8");
  assert.ok(text.length <= 33 * 1024, `${text.length} bytes`);
  assert.match(text, /problem number 1999/);
  assert.ok(!/problem number 0 /.test(text));
  assert.ok(text.split("\n").filter(Boolean).every((l) => /^\d{4}-/.test(l)), "no half lines");
});
