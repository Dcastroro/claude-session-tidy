import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { COMPANION_ROOTS, allCompanions, companionsOf, findSessions, makeStore, projectFolderExists, readReleaseMarker, resolveIds, safeId, shortIds, sized } from "../src/sessions.mjs";
import { NOW, Transcript, addBystanders, addCompanions, session, world } from "./helpers.mjs";

const ID_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const ID_C = "aaaabbbb-2222-4222-8222-cccccccccccc";

test("findSessions lists the sessions of one project, including its sub-folders, and none of a sibling", () => {
  const w = world("find");
  const shop = session(w, { id: ID_A, project: "shop" });
  const nested = session(w, { id: ID_B, cwd: path.join(shop.root, "packages", "api") });
  session(w, { id: ID_C, project: "shop-2" }); // its folder name starts with "shop-", but it is another project
  const found = findSessions(w.env, { root: shop.root });
  assert.deepEqual(found.map((s) => s.id).sort(), [ID_A, ID_B]);
  assert.equal(findSessions(w.env, { all: true }).length, 3);
  const s = found.find((x) => x.id === ID_A);
  assert.equal(s.file, shop.file);
  assert.equal(s.cwd, shop.root);
  assert.equal(s.entrypoint, "cli");
  assert.equal(s.slug, shop.slug);
  assert.ok(s.bytes > 0 && s.mtimeMs > 0);
  assert.equal(nested.root, path.join(shop.root, "packages", "api"));
});

test("findSessions: Windows paths with spaces work the same on every system", () => {
  const w = world("find");
  const cwd = "C:\\Users\\Test User\\My Project";
  const t = new Transcript({ id: ID_A, cwd });
  t.prompt("hello"); t.say("hi");
  t.write(w.claude);
  const sub = new Transcript({ id: ID_B, cwd: `${cwd}\\sub folder` });
  sub.prompt("hello"); sub.say("hi");
  sub.write(w.claude);
  assert.deepEqual(findSessions(w.env, { root: cwd }).map((s) => s.id).sort(), [ID_A, ID_B]);
  assert.deepEqual(findSessions(w.env, { root: "c:/users/test user/my project/" }).map((s) => s.id).sort(), [ID_A, ID_B], "another spelling of the same folder");
  assert.deepEqual(findSessions(w.env, { root: "C:\\Users\\Test User\\My Project\\sub folder" }).map((s) => s.id), [ID_B]);
  assert.deepEqual(findSessions(w.env, { root: "C:\\Users\\Test User" }).map((s) => s.id).sort(), [ID_A, ID_B], "the sessions of every folder inside it");
  assert.deepEqual(findSessions(w.env, { root: "C:\\Users\\Test User\\My" }).map((s) => s.id), [], "a folder whose name is only the start of the project's is another folder");
});

test("findSessions skips subagent transcripts, other files, folders and a missing projects folder", () => {
  const w = world("find");
  assert.deepEqual(findSessions(w.env, { all: true }), [], "no projects folder yet");
  const s = session(w, { id: ID_A, project: "shop" });
  fs.writeFileSync(path.join(s.dir, "agent-a1b2c3d4.jsonl"), '{"cwd":"x"}\n');
  fs.writeFileSync(path.join(s.dir, "notes.txt"), "x");
  fs.writeFileSync(path.join(s.dir, "has.dots.jsonl"), "x");
  fs.mkdirSync(path.join(s.dir, "folder.jsonl"));
  fs.writeFileSync(path.join(w.claude, "projects", "stray.jsonl"), "x");
  assert.deepEqual(findSessions(w.env, { all: true }).map((x) => x.id), [ID_A]);
});

test("a session file with nothing in it is still found, and belongs to the folder it sits in", () => {
  const w = world("find");
  const root = w.project("shop");
  const dir = path.join(w.claude, "projects", path.basename(root) === "shop" ? `${root.replace(/[^a-zA-Z0-9]/g, "-")}` : "x");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${ID_A}.jsonl`), "");
  assert.deepEqual(findSessions(w.env, { root }).map((s) => s.id), [ID_A]);
});

test("companionsOf finds everything named by the session's id, and nothing else", () => {
  const w = world("comp");
  const s = session(w, { id: ID_A, project: "shop", companions: true });
  const other = session(w, { id: ID_B, project: "shop", companions: true });
  const marker = path.join(s.dir, `${ID_A}.desktop-released.json`);
  fs.writeFileSync(marker, '{"reason":"archive"}');
  const by = addBystanders(w.claude, s.slug, ID_B);
  const store = makeStore(w.env);
  const list = companionsOf(store, { id: ID_A, slug: s.slug });
  const rels = list.map((c) => c.rel).sort();
  assert.deepEqual(rels, [
    `debug/${ID_A}.txt`,
    `file-history/${ID_A}`,
    `projects/${s.slug}/${ID_A}`,
    `projects/${s.slug}/${ID_A}.desktop-released.json`,
    `projects/${s.slug}/${ID_A}.jsonl`,
    `session-env/${ID_A}`,
    `tasks/${ID_A}`,
    `todos/${ID_A}-agent-${ID_A}.json`,
    `uploads/${ID_A}`,
    `usage-data/facets/${ID_A}.json`,
    `usage-data/session-meta/${ID_A}.json`,
  ].sort());
  assert.equal(list[0].rel, `projects/${s.slug}/${ID_A}.jsonl`, "the transcript comes first");
  assert.equal(list.find((c) => c.rel.endsWith(`${ID_A}`) && c.rel.startsWith("projects")).kind, "dir");
  for (const c of list) assert.ok(COMPANION_ROOTS.includes(c.rel.split("/")[0]));
  for (const b of by) assert.ok(!rels.includes(b), `${b} is not a companion`);
  assert.ok(!rels.some((r) => r.includes(ID_B)), "another session's files are never taken");
  assert.equal(other.rel.length > 0, true);
});

test("companionsOf: an id that is the start of another id does not take its files", () => {
  const w = world("comp");
  const short = "abc";
  const long = "abc-def";
  const a = session(w, { id: short, project: "shop", companions: true });
  session(w, { id: long, project: "shop", companions: true });
  const rels = companionsOf(makeStore(w.env), { id: short, slug: a.slug }).map((c) => c.rel);
  assert.ok(rels.every((r) => !r.includes("abc-def")), rels.join("\n"));
  assert.ok(rels.includes("todos/abc-agent-abc.json"));
});

test("sized adds up bytes and files below every item", () => {
  const w = world("size");
  const s = session(w, { id: ID_A, project: "shop", companions: true });
  const list = companionsOf(makeStore(w.env), { id: ID_A, slug: s.slug });
  const total = sized(list);
  assert.equal(total.items.length, list.length);
  assert.equal(total.files, 1 + s.rel.length, "the transcript and every companion file");
  const expected = [`projects/${s.slug}/${ID_A}.jsonl`, ...s.rel].reduce((n, r) => n + fs.statSync(path.join(w.claude, ...r.split("/"))).size, 0);
  assert.equal(total.bytes, expected);
});

test("allCompanions merges the copies of one session without repeats", () => {
  const w = world("copies");
  const one = session(w, { id: ID_A, project: "shop", companions: true });
  const two = session(w, { id: ID_A, project: "shop2" });
  const store = makeStore(w.env);
  const list = allCompanions(store, [{ id: ID_A, slug: one.slug }, { id: ID_A, slug: two.slug }]);
  const rels = list.map((c) => c.rel);
  assert.equal(new Set(rels).size, rels.length);
  assert.ok(rels.includes(`projects/${one.slug}/${ID_A}.jsonl`) && rels.includes(`projects/${two.slug}/${ID_A}.jsonl`));
  assert.equal(rels.filter((r) => r.startsWith("file-history/")).length, 1);
});

test("resolveIds takes a full id or 6 or more characters of it", () => {
  const w = world("ids");
  session(w, { id: ID_A, project: "shop" });
  session(w, { id: ID_B, project: "shop" });
  assert.deepEqual(resolveIds(w.env, [ID_A]).map((r) => r.id), [ID_A]);
  assert.deepEqual(resolveIds(w.env, ["aaaaaa"]).map((r) => r.id), [ID_A]);
  assert.deepEqual(resolveIds(w.env, ["AAAAAAAA-1111"]).map((r) => r.id), [ID_A], "ids are matched without regard to case");
  assert.deepEqual(resolveIds(w.env, ["aaaaaaaa", ID_A, "bbbbbb"]).map((r) => r.id), [ID_A, ID_B], "the same session twice is one");
});

test("resolveIds refuses ambiguous, too short and unknown ids, and says why", () => {
  const w = world("ids");
  session(w, { id: ID_A, project: "shop" });
  session(w, { id: ID_C, project: "shop" });
  assert.throws(() => resolveIds(w.env, ["aaaa"]), /Short ids need at least 6 characters/);
  assert.deepEqual(resolveIds(w.env, ["aaaabb"]).map((r) => r.id), [ID_C], "6 characters are enough when only one id starts with them");
  session(w, { id: "aaaabbbb-3333-4333-8333-dddddddddddd", project: "shop" });
  assert.throws(() => resolveIds(w.env, ["aaaabbbb"]), (e) => /"aaaabbbb" is ambiguous: 2 sessions start with it/.test(e.message) && e.message.includes(ID_C) && e.message.includes("aaaabbbb-3333"));
  assert.throws(() => resolveIds(w.env, ["ffffffff"]), /No session has the id "ffffffff"/);
  assert.throws(() => resolveIds(w.env, []), /Which session\?/);
  assert.deepEqual(resolveIds(w.env, [ID_C]).map((r) => r.id), [ID_C], "a full id is never ambiguous");
});

test("resolveIds: the same id in two project folders is one session with two copies", () => {
  const w = world("ids");
  session(w, { id: ID_A, project: "one" });
  session(w, { id: ID_A, project: "two" });
  const [r] = resolveIds(w.env, ["aaaaaaaa"]);
  assert.equal(r.id, ID_A);
  assert.equal(r.copies.length, 2);
  assert.notEqual(r.copies[0].slug, r.copies[1].slug);
});

test("shortIds is 8 characters, and longer only where two ids share their start", () => {
  const m = shortIds([ID_A, ID_B, "aaaaaaaa-9999-4999-8999-999999999999"]);
  assert.equal(m.get(ID_B), "bbbbbbbb");
  assert.equal(m.get(ID_A), "aaaaaaaa-1");
  assert.equal(m.get("aaaaaaaa-9999-4999-8999-999999999999"), "aaaaaaaa-9");
  assert.equal(shortIds(["abc"]).get("abc"), "abc");
});

test("safeId accepts ids that cannot break out of a path", () => {
  for (const ok of [ID_A, "abc", "A_b-1"]) assert.ok(safeId(ok), ok);
  for (const bad of ["", "..", "a/b", "a\\b", "a.b", "-x", ".hidden", "a b", "x".repeat(200), "a:b"]) assert.ok(!safeId(bad), JSON.stringify(bad));
});

test("projectFolderExists: true, false, or unknown when this machine cannot tell", () => {
  const w = world("orphan");
  const here = w.project("here");
  assert.equal(projectFolderExists(here), true);
  const gone = path.join(w.base, "work", "gone");
  assert.equal(projectFolderExists(gone), false);
  assert.equal(projectFolderExists(""), null);
  if (process.platform === "win32") {
    assert.equal(projectFolderExists("/home/me/project"), null, "a POSIX path on Windows is another system's");
    assert.equal(projectFolderExists("\\\\server\\share\\project"), null, "a network share may just be offline");
    const missingDrive = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((l) => `${l}:\\`).find((d) => !fs.existsSync(d));
    if (missingDrive) assert.equal(projectFolderExists(`${missingDrive}work\\app`), null, "an unplugged drive is not a deleted project");
  } else {
    assert.equal(projectFolderExists("C:\\Users\\me\\project"), null, "a Windows path on Linux or macOS is another system's");
  }
  // the platform can be named, so the same rules are checked on every system
  assert.equal(projectFolderExists("/home/me/project", "win32"), null, "a POSIX path, judged as Windows");
  assert.equal(projectFolderExists("C:\\Users\\me\\project", "linux"), null, "a Windows path, judged as Linux");
  assert.equal(projectFolderExists("relative/path", "linux"), null, "a relative path says nothing");
});

test("readReleaseMarker reads the Desktop app's archive marker", () => {
  const w = world("marker");
  const s = session(w, { id: ID_A, project: "shop" });
  assert.equal(readReleaseMarker(s), null);
  const file = path.join(s.dir, `${ID_A}.desktop-released.json`);
  fs.writeFileSync(file, '{"reason":"archive"}');
  fs.utimesSync(file, new Date(NOW), new Date(NOW));
  assert.deepEqual(readReleaseMarker(s), { reason: "archive", mtimeMs: NOW });
  fs.writeFileSync(file, '{"reason":"delete"}');
  assert.equal(readReleaseMarker(s).reason, "delete");
  fs.writeFileSync(file, "not json");
  assert.equal(readReleaseMarker(s).reason, "");
  fs.writeFileSync(file, '{"reason":5}');
  assert.equal(readReleaseMarker(s).reason, "");
});

test("addCompanions creates what the layout says", () => {
  const w = world("layout");
  const rel = addCompanions(w.claude, "slug", ID_A);
  assert.ok(rel.length >= 12);
  for (const r of rel) assert.ok(fs.existsSync(path.join(w.claude, ...r.split("/"))), r);
});
