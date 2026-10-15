import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { deleteSessions, emptyTrash, findTrashEntry, listTrash, ops, restoreSession } from "../src/trash.mjs";
import { keepSessions } from "../src/keep.mjs";
import { resolveIds } from "../src/sessions.mjs";
import { trashRoot } from "../src/config.mjs";
import { DAY, NOW, addBystanders, mtimeOf, session, snapshot, world } from "./helpers.mjs";

const ID_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";

// A world with a rich session A, a second session B and the bystanders that must never be touched.
function setup({ ageDays = 3 } = {}) {
  const w = world("trash");
  const a = session(w, { id: ID_A, project: "shop", companions: true, ageDays, prompt: "Fix the login loop" });
  const b = session(w, { id: ID_B, project: "shop", companions: true, ageDays });
  const by = addBystanders(w.claude, a.slug, ID_B);
  return { w, a, b, by };
}
const del = (w, refs, opts = {}) => deleteSessions(w.env, resolveIds(w.env, refs), { now: NOW, ...opts });
const without = (snap, prefix) => Object.fromEntries(Object.entries(snap).filter(([k]) => !k.startsWith(prefix)));

test("delete moves the transcript and everything that belongs to it, and nothing else", () => {
  const { w, a, by } = setup();
  const before = snapshot(w.claude);
  const [plan] = del(w, [ID_A]);
  const after = snapshot(w.claude);
  const mine = [`projects/${a.slug}/${ID_A}.jsonl`, ...a.rel];
  assert.equal(plan.id, ID_A);
  assert.equal(plan.files, mine.length);
  for (const rel of mine) {
    assert.ok(!(rel in after), `${rel} is gone from its place`);
    assert.deepEqual(after[`session-tidy/trash/${ID_A}/files/${rel}`]?.text, before[rel].text, `${rel} is in the trash, unchanged`);
    assert.equal(after[`session-tidy/trash/${ID_A}/files/${rel}`].mtimeMs, before[rel].mtimeMs, `${rel} keeps its time`);
  }
  for (const rel of by) assert.deepEqual(after[rel], before[rel], `${rel} was left alone`);
  for (const rel of Object.keys(before).filter((k) => k.includes(ID_B))) assert.deepEqual(after[rel], before[rel], `${rel} of the other session was left alone`);
  assert.deepEqual(Object.keys(after).filter((k) => !k.startsWith("session-tidy/")).sort(), Object.keys(before).filter((k) => !mine.includes(k)).sort());
});

test("the manifest lists every original path", () => {
  const { w, a } = setup();
  del(w, [ID_A]);
  const [entry] = listTrash(w.env);
  const m = entry.manifest;
  assert.equal(m.version, 1);
  assert.equal(m.id, ID_A);
  assert.equal(m.complete, true);
  assert.equal(m.trashedAt, new Date(NOW).toISOString());
  assert.equal(m.configDir, w.claude);
  assert.equal(m.slug, a.slug);
  assert.ok(m.bytes > 0 && m.files === m.items.reduce((n, i) => n + i.files, 0));
  const item = m.items.find((i) => i.path === `projects/${a.slug}/${ID_A}.jsonl`);
  assert.equal(item.from, a.file, "the original path, as it was on this machine");
  assert.equal(item.kind, "file");
  assert.ok(m.items.some((i) => i.path === `file-history/${ID_A}` && i.kind === "dir"));
  assert.equal(entry.id, ID_A);
  assert.equal(entry.complete, true);
  assert.equal(entry.trashedAtMs, NOW);
});

test("restore puts every file back at its place with the same bytes and times", () => {
  const { w } = setup();
  const before = snapshot(w.claude);
  del(w, [ID_A]);
  const r = restoreSession(w.env, ID_A, { now: NOW });
  const after = snapshot(w.claude);
  assert.deepEqual(without(after, "session-tidy/"), before, "the whole config folder is as it was, down to the modification times");
  assert.equal(r.id, ID_A);
  assert.equal(r.restored.length, 10, "every item of the manifest: the transcript, the session folder, nine other places");
  assert.deepEqual(r.missing, []);
  assert.equal(r.touched, 0, "a session with plenty of time left keeps its times");
  assert.equal(listTrash(w.env).length, 0);
  assert.ok(!fs.existsSync(path.join(trashRoot(w.env), ID_A)));
});

test("delete --dry-run and restore --dry-run change nothing", () => {
  const { w } = setup();
  const before = snapshot(w.claude);
  const plans = del(w, [ID_A, ID_B], { dryRun: true });
  assert.equal(plans.length, 2);
  assert.ok(plans.every((p) => p.bytes > 0 && p.files > 0 && p.trash.endsWith(p.id)));
  assert.deepEqual(snapshot(w.claude), before);
  assert.ok(!fs.existsSync(trashRoot(w.env)));
  del(w, [ID_A]);
  const mid = snapshot(w.claude);
  const r = restoreSession(w.env, ID_A, { dryRun: true });
  assert.ok(r.restored.length > 5);
  assert.deepEqual(snapshot(w.claude), mid);
});

test("two sessions in one go; if one cannot be moved, none is", () => {
  const { w } = setup();
  const before = snapshot(w.claude);
  keepSessions(w.env, resolveIds(w.env, [ID_B]), { now: NOW });
  const kept = snapshot(w.claude);
  assert.throws(() => del(w, [ID_A, ID_B]), /bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb is on the keep list.*unkeep bbbbbbbb/);
  assert.deepEqual(snapshot(w.claude), kept, "nothing moved");
  assert.notDeepEqual(kept, before, "(keep touched B's files)");
  assert.equal(del(w, [ID_A]).length, 1);
});

test("a kept session is refused, an invalid keep list blocks every delete, a session already in the trash is refused", () => {
  const { w } = setup();
  fs.mkdirSync(path.join(w.claude, "session-tidy"), { recursive: true });
  fs.writeFileSync(path.join(w.claude, "session-tidy", "keep.json"), "{ not json");
  const before = snapshot(w.claude);
  assert.throws(() => del(w, [ID_A]), /keep\.json is not valid JSON, so I cannot tell which sessions are kept/);
  assert.deepEqual(snapshot(w.claude), before);
  fs.rmSync(path.join(w.claude, "session-tidy", "keep.json"));
  del(w, [ID_A]);
  // the same id turns up again (a recreated file) while the first is still in the trash
  session(w, { id: ID_A, project: "shop" });
  assert.throws(() => del(w, [ID_A]), /already in the trash.*restore aaaaaaaa/);
});

test("restore refuses when something is in the way, and moves nothing", () => {
  const { w, a } = setup();
  del(w, [ID_A]);
  const inTheWay = path.join(w.claude, "file-history", ID_A, "0fb339eae9426361@v1");
  fs.mkdirSync(path.dirname(inTheWay), { recursive: true });
  fs.writeFileSync(inTheWay, "new session's file");
  const before = snapshot(w.claude);
  assert.throws(() => restoreSession(w.env, ID_A, { now: NOW }), (e) => /Cannot restore aaaaaaaa.*already exists/.test(e.message) && e.message.includes("file-history/") && e.message.includes("Move those aside"));
  assert.deepEqual(snapshot(w.claude), before);
  fs.rmSync(path.join(w.claude, "file-history", ID_A), { recursive: true });
  restoreSession(w.env, ID_A, { now: NOW });
  assert.ok(fs.existsSync(a.file));
});

test("a move that fails halfway is undone: the session is where it was and no trash entry is left", () => {
  const { w } = setup();
  const before = snapshot(w.claude);
  const real = ops.rename;
  let calls = 0;
  ops.rename = (from, to) => { if (++calls === 4) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }); real(from, to); };
  try {
    assert.throws(() => del(w, [ID_A]), /Could not move a file of aaaaaaaa-1111.*EBUSY.*Nothing was changed.*close it/);
  } finally { ops.rename = real; }
  assert.ok(calls >= 4);
  assert.deepEqual(snapshot(w.claude), before);
  assert.ok(!fs.existsSync(path.join(trashRoot(w.env), ID_A)));
  assert.equal(del(w, [ID_A]).length, 1, "and a later try works");
});

test("when the second of two sessions fails, the first is put back too", () => {
  const { w } = setup();
  const before = snapshot(w.claude);
  const real = ops.rename;
  let calls = 0;
  // the first session needs 10 renames; the 12th call is the second rename of the second session
  ops.rename = (from, to) => { if (++calls === 12) throw Object.assign(new Error("EPERM"), { code: "EPERM" }); real(from, to); };
  try {
    assert.throws(() => del(w, [ID_A, ID_B]), /Could not move a file of/);
  } finally { ops.rename = real; }
  assert.deepEqual(snapshot(w.claude), before);
  assert.deepEqual(listTrash(w.env), []);
});

test("a restore that fails halfway puts back what it moved", () => {
  const { w } = setup();
  del(w, [ID_A]);
  const before = snapshot(w.claude);
  const real = ops.rename;
  let calls = 0;
  ops.rename = (from, to) => { if (++calls === 3) throw Object.assign(new Error("EACCES"), { code: "EACCES" }); real(from, to); };
  try {
    assert.throws(() => restoreSession(w.env, ID_A, { now: NOW }), /Could not move a file back.*Nothing was changed/);
  } finally { ops.rename = real; }
  assert.deepEqual(snapshot(w.claude), before);
  assert.equal(restoreSession(w.env, ID_A, { now: NOW }).id, ID_A);
});

test("a manifest that points outside the places sessions live in is not trusted", () => {
  const { w } = setup();
  del(w, [ID_A]);
  const file = path.join(trashRoot(w.env), ID_A, "manifest.json");
  const good = JSON.parse(fs.readFileSync(file, "utf8"));
  const evil = ["../../outside.txt", "projects/../../../outside.txt", "/etc/passwd", "C:\\Windows\\x", "projects\\x\\..\\y", "settings.json", "projects", "projects//x", "projects/./x", "projects/x:stream/y", ""];
  fs.writeFileSync(path.join(w.base, "outside.txt"), "precious");
  for (const p of evil) {
    const m = structuredClone(good);
    m.items.push({ path: p, from: "x", kind: "file", bytes: 1, files: 1 });
    fs.writeFileSync(file, JSON.stringify(m));
    const before = snapshot(w.claude);
    assert.throws(() => restoreSession(w.env, ID_A, { now: NOW }), /outside the places sessions live in/, JSON.stringify(p));
    assert.deepEqual(snapshot(w.claude), before, `nothing moved for ${JSON.stringify(p)}`);
  }
  assert.equal(fs.readFileSync(path.join(w.base, "outside.txt"), "utf8"), "precious");
});

test("a trash entry whose manifest is missing or broken cannot be restored, and says where its files are", () => {
  const { w } = setup();
  del(w, [ID_A]);
  const dir = path.join(trashRoot(w.env), ID_A);
  fs.writeFileSync(path.join(dir, "manifest.json"), "{ broken");
  const [entry] = listTrash(w.env);
  assert.equal(entry.manifest, null);
  assert.equal(entry.complete, false);
  assert.throws(() => restoreSession(w.env, ID_A, { now: NOW }), (e) => /no readable manifest\.json/.test(e.message) && e.message.includes(path.join(dir, "files")));
  fs.rmSync(path.join(dir, "manifest.json"));
  assert.equal(listTrash(w.env)[0].manifest, null);
  // a manifest for another id is not accepted either
  del(w, [ID_B]);
  const other = path.join(trashRoot(w.env), ID_B, "manifest.json");
  const m = JSON.parse(fs.readFileSync(other, "utf8"));
  m.id = ID_A;
  fs.writeFileSync(other, JSON.stringify(m));
  assert.equal(listTrash(w.env).find((e) => e.id === ID_B).manifest, null);
});

test("an incomplete delete (the program died halfway) can still be restored", () => {
  const { w, a } = setup();
  const before = snapshot(w.claude);
  del(w, [ID_A]);
  const file = path.join(trashRoot(w.env), ID_A, "manifest.json");
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  m.complete = false;
  fs.writeFileSync(file, JSON.stringify(m));
  assert.equal(listTrash(w.env)[0].complete, false);
  // one item had not been moved yet: it is still in place, and restore reports it as missing from the trash
  const lingering = path.join(w.claude, "debug", `${ID_A}.txt`);
  fs.renameSync(path.join(trashRoot(w.env), ID_A, "files", "debug", `${ID_A}.txt`), lingering);
  const r = restoreSession(w.env, ID_A, { now: NOW });
  assert.deepEqual(r.missing, [`debug/${ID_A}.txt`]);
  assert.deepEqual(without(snapshot(w.claude), "session-tidy/"), before);
  assert.ok(fs.existsSync(a.file));
});

test("restore finds a trashed session by a short id and refuses an ambiguous or unknown one", () => {
  const { w } = setup();
  const c = session(w, { id: "aaaaaaaa-2222-4222-8222-cccccccccccc", project: "shop" });
  del(w, [ID_A, ID_B, c.id]);
  assert.equal(findTrashEntry(w.env, "bbbbbb").id, ID_B);
  assert.throws(() => findTrashEntry(w.env, "aaaaaaaa"), /"aaaaaaaa" is ambiguous: 2 trashed sessions start with it/);
  assert.equal(findTrashEntry(w.env, ID_A).id, ID_A);
  assert.throws(() => findTrashEntry(w.env, "ffffffff"), /The trash has no session "ffffffff"\. In the trash: aaaaaaaa, aaaaaaaa, bbbbbbbb/);
  assert.throws(() => findTrashEntry(w.env, "aaaa"), /has no session "aaaa"/, "too short to be a prefix");
  fs.rmSync(trashRoot(w.env), { recursive: true });
  assert.throws(() => findTrashEntry(w.env, "ffffffff"), /The trash is empty/);
});

test("a session that sits in two project folders moves and comes back as one", () => {
  const w = world("two");
  const one = session(w, { id: ID_A, project: "one", companions: true });
  const two = session(w, { id: ID_A, project: "two" });
  const before = snapshot(w.claude);
  const [plan] = del(w, [ID_A]);
  assert.ok(plan.items.some((i) => i.rel === `projects/${one.slug}/${ID_A}.jsonl`) && plan.items.some((i) => i.rel === `projects/${two.slug}/${ID_A}.jsonl`));
  assert.ok(!fs.existsSync(one.file) && !fs.existsSync(two.file));
  restoreSession(w.env, ID_A, { now: NOW });
  assert.deepEqual(without(snapshot(w.claude), "session-tidy/"), before);
});

test("restore touches a session the next cleanup would remove, and only that one", () => {
  const old = setup({ ageDays: 20 });
  del(old.w, [ID_A]);
  const r = restoreSession(old.w.env, ID_A, { now: NOW, days: 30 });
  assert.ok(r.touched > 0);
  assert.equal(mtimeOf(old.a.file), NOW, "the transcript was touched");
  assert.equal(mtimeOf(path.join(old.w.claude, "projects", old.a.slug, ID_A, "tool-results", "toolu_01.txt")), NOW);
  assert.equal(mtimeOf(path.join(old.w.claude, "file-history", ID_A, "0fb339eae9426361@v1")), NOW - 20 * DAY, "file history is not judged by the cleanup, so it keeps its time");
  const fresh = setup({ ageDays: 3 });
  del(fresh.w, [ID_A]);
  const r2 = restoreSession(fresh.w.env, ID_A, { now: NOW, days: 30 });
  assert.equal(r2.touched, 0);
  assert.equal(mtimeOf(fresh.a.file), NOW - 3 * DAY);
  const short = setup({ ageDays: 3 });
  del(short.w, [ID_A]);
  assert.ok(restoreSession(short.w.env, ID_A, { now: NOW, days: 5 }).touched > 0, "with a 5-day period 3 days is more than half");
});

test("empty-trash lists first, deletes only with yes, and --older picks by the day it was trashed", () => {
  const { w } = setup();
  del(w, [ID_A], { now: NOW - 40 * DAY });
  del(w, [ID_B], { now: NOW - 2 * DAY });
  const all = emptyTrash(w.env, { now: NOW });
  assert.equal(all.deleted, false);
  assert.deepEqual(all.entries.map((e) => e.id).sort(), [ID_A, ID_B]);
  assert.equal(listTrash(w.env).length, 2, "without yes nothing is deleted");
  assert.equal(emptyTrash(w.env, { now: NOW, yes: true, dryRun: true }).deleted, false, "--dry-run beats --yes");
  assert.equal(listTrash(w.env).length, 2);
  const old = emptyTrash(w.env, { now: NOW, olderDays: 30 });
  assert.deepEqual(old.entries.map((e) => e.id), [ID_A]);
  const done = emptyTrash(w.env, { now: NOW, olderDays: 30, yes: true });
  assert.equal(done.deleted, true);
  assert.deepEqual(listTrash(w.env).map((e) => e.id), [ID_B]);
  assert.ok(done.bytes > 0);
  const rest = emptyTrash(w.env, { now: NOW, yes: true });
  assert.equal(rest.deleted, true);
  assert.deepEqual(listTrash(w.env), []);
  assert.ok(!fs.existsSync(trashRoot(w.env)), "the empty trash folder goes too");
  assert.equal(emptyTrash(w.env, { now: NOW, yes: true }).deleted, false, "nothing to delete");
});

test("empty-trash never reaches outside the trash", () => {
  const { w, by } = setup();
  del(w, [ID_A]);
  emptyTrash(w.env, { now: NOW, yes: true });
  for (const rel of by) assert.ok(fs.existsSync(path.join(w.claude, ...rel.split("/"))), rel);
  assert.ok(fs.existsSync(path.join(w.claude, "projects")));
});

test("a session in a Windows-style folder with spaces round-trips", () => {
  const w = world("win");
  const s = session(w, { id: ID_A, cwd: "C:\\Users\\Test User\\My Project", companions: true });
  const before = snapshot(w.claude);
  assert.equal(s.slug, "C--Users-Test-User-My-Project");
  del(w, [ID_A]);
  assert.ok(!fs.existsSync(s.file));
  restoreSession(w.env, ID_A, { now: NOW });
  assert.deepEqual(without(snapshot(w.claude), "session-tidy/"), before);
});

test("a symbolic link inside a session folder is moved as a link, not followed", (t) => {
  const w = world("link");
  const s = session(w, { id: ID_A, project: "shop", companions: true });
  const outside = path.join(w.base, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.txt"), "precious");
  const link = path.join(s.dir, ID_A, "linked");
  try { fs.symlinkSync(outside, link, "dir"); } catch { t.skip("this system does not allow creating symbolic links here"); return; }
  del(w, [ID_A]);
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "precious", "what the link points at is untouched");
  restoreSession(w.env, ID_A, { now: NOW });
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "precious");
});

test("a file name that restore could not put back safely is refused up front", (t) => {
  if (process.platform === "win32") { t.skip("a colon in a Windows file name makes a data stream, not a name"); return; }
  const w = world("odd");
  const s = session(w, { id: ID_A, project: "shop" });
  const odd = path.join(s.dir, `${ID_A}.weird:name`);
  try { fs.writeFileSync(odd, "x"); } catch { t.skip("this file system does not allow a colon in a name"); return; }
  const before = snapshot(w.claude);
  assert.throws(() => del(w, [ID_A]), /a file with a name I will not move/);
  assert.deepEqual(snapshot(w.claude), before);
});

test("restore works after the whole config folder was moved: the manifest holds paths inside it, not where it was", () => {
  const { w } = setup();
  const before = snapshot(w.claude);
  del(w, [ID_A]);
  const moved = path.join(w.base, "moved-config");
  fs.renameSync(w.claude, moved);
  restoreSession({ ...w.env, CLAUDE_CONFIG_DIR: moved }, ID_A, { now: NOW });
  const after = snapshot(moved);
  for (const [rel, f] of Object.entries(before)) assert.equal(after[rel]?.text, f.text, rel);
});

test("a project folder and a title with unicode and emoji round-trip", () => {
  const w = world("unicode");
  const s = session(w, { id: ID_A, project: "projekt-ü-日本語", prompt: "Fix the 🔥 bug in naïve résumé parser", companions: true });
  const before = snapshot(w.claude);
  const [plan] = del(w, [ID_A]);
  assert.ok(plan.files > 5);
  restoreSession(w.env, ID_A, { now: NOW });
  assert.deepEqual(without(snapshot(w.claude), "session-tidy/"), before);
  assert.ok(fs.existsSync(s.file));
});
