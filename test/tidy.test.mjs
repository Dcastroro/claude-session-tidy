import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ACTIVE_MS, findCandidates } from "../src/tidy.mjs";
import { keepSessions } from "../src/keep.mjs";
import { listTrash } from "../src/trash.mjs";
import { resolveIds } from "../src/sessions.mjs";
import { DAY, NOW, Transcript, run, session, snapshot, world } from "./helpers.mjs";

const id = (c) => `${c.repeat(8)}-1111-4111-8111-${c.repeat(12)}`;
const find = (w, opts) => findCandidates(w.env, { now: NOW, all: true, ...opts });
const ids = (r) => r.candidates.map((c) => c.id).sort();

// A world with one session of each kind.
function setup() {
  const w = world("tidy");
  const gone = path.join(w.base, "work", "vanished");
  fs.mkdirSync(gone, { recursive: true });
  const s = {
    normal: session(w, { id: id("a"), project: "shop", ageDays: 3 }),
    empty: session(w, { id: id("b"), project: "shop", prompts: 0, ageDays: 3 }),
    orphan: session(w, { id: id("c"), cwd: gone, ageDays: 3 }),
    old: session(w, { id: id("d"), project: "shop", ageDays: 100 }),
    emptyOrphan: null,
  };
  // nothing typed, but Claude Code recorded the folder it ran in
  const t = new Transcript({ id: id("e"), cwd: gone, start: new Date(NOW - 3 * DAY - 600000).toISOString() });
  t.say("(a reply with no prompt before it)");
  s.emptyOrphan = t.write(w.claude, { mtime: NOW - 3 * DAY });
  fs.rmSync(gone, { recursive: true });
  return { w, s };
}

test("--empty finds sessions with nothing typed in them", () => {
  const { w } = setup();
  const r = find(w, { empty: true });
  assert.deepEqual(ids(r), [id("b"), id("e")]);
  assert.deepEqual(r.candidates.find((c) => c.id === id("b")).reasons, [{ kind: "empty", detail: "nothing was typed in it" }]);
  assert.equal(r.considered, 5);
});

test("--orphans finds sessions of projects whose folder no longer exists", () => {
  const { w, s } = setup();
  const r = find(w, { orphans: true });
  assert.deepEqual(ids(r), [id("c"), id("e")]);
  assert.match(r.candidates[0].reasons[0].detail, /the folder .*vanished no longer exists/);
  assert.deepEqual(ids(find(w, { orphans: true, empty: false })).includes(id("b")), false, "an empty session records no folder, so it cannot be told to be an orphan");
  assert.equal(s.orphan.root.includes("vanished"), true);
});

test("--older judges by the last use inside the session, not by the file's time", () => {
  const { w } = setup();
  const r = find(w, { olderDays: 90 });
  assert.deepEqual(ids(r), [id("d")]);
  assert.match(r.candidates[0].reasons[0].detail, /last used 100 days ago/);
  assert.deepEqual(ids(find(w, { olderDays: 200 })), [], "nothing is that old");
  // a copied config folder: every file looks new, the records say 200 days
  const copied = session(w, { id: id("f"), project: "shop", ageDays: 1, stampDays: 200 });
  assert.equal(copied.mtime, NOW - DAY);
  assert.ok(ids(find(w, { olderDays: 90 })).includes(id("f")));
  // a session used again lately has a new last use, whatever its file says
  const fresh = session(w, { id: id("g"), project: "shop", ageDays: 100, stampDays: 1 });
  assert.equal(fresh.mtime, NOW - 100 * DAY);
  assert.ok(!ids(find(w, { olderDays: 90 })).includes(id("g")));
});

test("the categories add up, and one session can have several reasons", () => {
  const { w } = setup();
  const r = find(w, { empty: true, orphans: true, olderDays: 90 });
  assert.deepEqual(ids(r), [id("b"), id("c"), id("d"), id("e")]);
  assert.deepEqual(r.candidates.find((c) => c.id === id("e")).reasons.map((x) => x.kind).sort(), ["empty", "orphan"]);
  assert.deepEqual(find(w, {}).candidates, [], "no category, nothing");
});

test("a kept session is never a candidate, and is reported as left alone", () => {
  const { w } = setup();
  const r = find(w, { empty: true, orphans: true, olderDays: 90, keepIds: new Set([id("b"), id("d")]) });
  assert.deepEqual(ids(r), [id("c"), id("e")]);
  assert.deepEqual(r.skipped.map((s) => [s.id, s.reason, s.why]).sort(), [[id("b"), "kept", ["empty"]], [id("d"), "kept", ["older"]]]);
});

test("a session changed in the last 10 minutes is left alone: it may be open right now", () => {
  const { w } = setup();
  const live = session(w, { id: id("h"), project: "shop", prompts: 0, mtime: NOW - 5 * 60000 });
  const justOver = session(w, { id: id("i"), project: "shop", prompts: 0, mtime: NOW - ACTIVE_MS - 1000 });
  const r = find(w, { empty: true });
  assert.ok(!ids(r).includes(id("h")));
  assert.ok(ids(r).includes(id("i")));
  assert.deepEqual(r.skipped, [{ id: id("h"), reason: "active", why: ["empty"] }]);
  assert.ok(live.mtime > justOver.mtime);
});

test("the scope: this project by default, every project with all, another folder with root", () => {
  const w = world("scope");
  session(w, { id: id("a"), project: "one", prompts: 0, ageDays: 3 });
  const two = session(w, { id: id("b"), project: "two", prompts: 0, ageDays: 3 });
  assert.deepEqual(ids(findCandidates(w.env, { now: NOW, root: two.root, empty: true })), [id("b")]);
  assert.deepEqual(ids(findCandidates(w.env, { now: NOW, all: true, empty: true })), [id("a"), id("b")]);
  assert.deepEqual(ids(findCandidates(w.env, { now: NOW, root: path.join(w.base, "work", "nothing"), empty: true })), []);
});

test("a folder that cannot be judged is not an orphan: another system's path, or one on a drive that is not there", () => {
  const w = world("foreign");
  const foreign = process.platform === "win32" ? "/home/me/project" : "C:\\Users\\me\\project";
  session(w, { id: id("a"), cwd: foreign, ageDays: 3 });
  assert.deepEqual(ids(find(w, { orphans: true })), []);
});

test("the same id in two project folders is one candidate with two copies", () => {
  const w = world("copies");
  session(w, { id: id("a"), project: "one", prompts: 0, ageDays: 3 });
  session(w, { id: id("a"), project: "two", prompts: 0, ageDays: 3 });
  const r = find(w, { empty: true });
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].copies.length, 2);
});

// --- the command ---------------------------------------------------------------------------------

test("tidy with no flags looks for empty and orphaned sessions, and moves them to the trash", async () => {
  const { w, s } = setup();
  const r = await run(["tidy", "--all"], w);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /^Tidy: looked at 5 sessions in all projects\n/);
  assert.match(r.out, /Moved 3 sessions to the trash/);
  assert.ok(r.out.includes("bbbbbbbb  empty") && r.out.includes("cccccccc  orphan") && r.out.includes("eeeeeeee  empty+orphan"), r.out);
  assert.deepEqual(listTrash(w.env).map((e) => e.id).sort(), [id("b"), id("c"), id("e")]);
  assert.ok(fs.existsSync(s.normal.file) && fs.existsSync(s.old.file), "the old session is not touched without --older");
  assert.ok(!fs.existsSync(s.empty.file) && !fs.existsSync(s.orphan.file));
});

test("tidy --dry-run shows the same and moves nothing", async () => {
  const { w } = setup();
  const before = snapshot(w.claude);
  const r = await run(["tidy", "--all", "--dry-run"], w);
  assert.equal(r.code, 0);
  assert.match(r.out, /Would move 3 sessions to the trash/);
  assert.match(r.out, /Nothing was moved \(--dry-run\)\./);
  assert.deepEqual(snapshot(w.claude), before);
});

test("tidy --older N alone looks only at age", async () => {
  const { w, s } = setup();
  const r = await run(["tidy", "--all", "--older", "90"], w);
  assert.match(r.out, /Moved 1 session to the trash/);
  assert.deepEqual(listTrash(w.env).map((e) => e.id), [id("d")]);
  assert.ok(fs.existsSync(s.empty.file));
});

test("tidy never moves a kept session and says it left it alone", async () => {
  const { w, s } = setup();
  keepSessions(w.env, resolveIds(w.env, [id("b")]), { now: NOW });
  const r = await run(["tidy", "--all"], w);
  assert.match(r.out, /Moved 2 sessions/);
  assert.match(r.out, /Left alone: 1 kept session\./);
  assert.ok(fs.existsSync(s.empty.file));
});

test("tidy in a project looks at that project only; --project picks another", async () => {
  const { w, s } = setup();
  const here = await run(["tidy", "--dry-run"], w, { cwd: s.normal.root });
  assert.match(here.out, /in .*shop\n/);
  assert.match(here.out, /Would move 1 session/);
  assert.ok(here.out.includes("bbbbbbbb  empty"));
  assert.ok(!here.out.includes("cccccccc"));
  const there = await run(["tidy", "--dry-run", "--project", s.orphan.root], w, { cwd: s.normal.root });
  assert.ok(there.out.includes("cccccccc  orphan") && there.out.includes("eeeeeeee"), there.out);
});

test("tidy --json says what it did", async () => {
  const { w } = setup();
  const r = await run(["tidy", "--all", "--json", "--empty"], w);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, true);
  assert.equal(j.dryRun, false);
  assert.deepEqual(j.categories, { empty: true, orphans: false, olderDays: 0 });
  assert.equal(j.considered, 5);
  assert.deepEqual(j.sessions.map((x) => x.id).sort(), [id("b"), id("e")]);
  assert.ok(j.bytes > 0);
  assert.ok(j.sessions.every((x) => x.reasons[0].kind === "empty" && x.trash.endsWith(x.id)));
  assert.equal(j.trash, path.join(w.claude, "session-tidy", "trash"));
});

test("tidy with nothing to do says so and exits 0", async () => {
  const w = world("clean");
  session(w, { id: id("a"), project: "shop", ageDays: 3 });
  const r = await run(["tidy", "--all"], w);
  assert.equal(r.code, 0);
  assert.match(r.out, /Nothing to tidy\./);
  assert.ok(!fs.existsSync(path.join(w.claude, "session-tidy")), "nothing is written when nothing is moved");
});

test("tidy refuses to run while keep.json is unreadable, and takes only whole numbers for --older", async () => {
  const { w } = setup();
  fs.mkdirSync(path.join(w.claude, "session-tidy"), { recursive: true });
  fs.writeFileSync(path.join(w.claude, "session-tidy", "keep.json"), "{ broken");
  const r = await run(["tidy", "--all"], w);
  assert.equal(r.code, 1);
  assert.match(r.err, /keep\.json is not valid JSON, so I cannot tell which sessions are kept/);
  fs.rmSync(path.join(w.claude, "session-tidy", "keep.json"));
  for (const bad of ["0", "-3", "1.5", "abc", ""]) {
    const x = await run(["tidy", "--older", bad], w);
    assert.equal(x.code, 1, bad);
    assert.match(x.err, /--older needs a whole number, 1 or more/);
  }
});
