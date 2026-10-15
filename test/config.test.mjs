import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appDir, claudeDir, describeRetention, homeDir, isInside, keepFile, projectSlug, projectsDir, readRetention, readSettingsFile, trashRoot } from "../src/config.mjs";
import { tmpDir, world } from "./helpers.mjs";

test("the config folder is CLAUDE_CONFIG_DIR, else .claude in the home folder", () => {
  const base = tmpDir();
  assert.equal(claudeDir({ CLAUDE_CONFIG_DIR: path.join(base, "x y") }), path.join(base, "x y"));
  assert.equal(claudeDir({ HOME: base, USERPROFILE: base }), path.join(base, ".claude"));
  assert.equal(homeDir({ HOME: base, USERPROFILE: base }), base);
  const env = { CLAUDE_CONFIG_DIR: base };
  assert.equal(projectsDir(env), path.join(base, "projects"));
  assert.equal(keepFile(env), path.join(base, "session-tidy", "keep.json"));
  assert.equal(trashRoot(env), path.join(base, "session-tidy", "trash"));
  assert.equal(appDir(env), path.join(base, "session-tidy", "app"));
});

test("a relative CLAUDE_CONFIG_DIR is made absolute", () => {
  assert.ok(path.isAbsolute(claudeDir({ CLAUDE_CONFIG_DIR: "relative/dir" })));
});

test("projectSlug follows Claude Code: every character that is not a letter or digit becomes a dash", () => {
  assert.equal(projectSlug("C:\\Users\\Test User\\My Project"), "C--Users-Test-User-My-Project");
  assert.equal(projectSlug("/home/me/work/shop.v2"), "-home-me-work-shop-v2");
  assert.equal(projectSlug("D:\\Projects\\claude-session-tidy"), "D--Projects-claude-session-tidy");
  const long = projectSlug(`/${"a".repeat(300)}`);
  assert.ok(long.length < 220 && long.startsWith("-aaaa"), "long names are cut and get a hash suffix");
  assert.notEqual(projectSlug(`/${"a".repeat(300)}b`), long, "two long paths with the same start get different names");
});

test("isInside works for either spelling of a path, whatever OS runs the test", () => {
  assert.ok(isInside("C:\\work\\shop", "C:\\work\\shop"));
  assert.ok(isInside("C:\\work\\shop", "c:/WORK/shop/packages/api"));
  assert.ok(!isInside("C:\\work\\shop", "C:\\work\\shop-2"));
  assert.ok(!isInside("C:\\work\\shop", "C:\\work"));
  assert.ok(isInside("/home/me/shop", "/home/me/shop/src"));
  assert.ok(!isInside("/home/me/shop", "/home/me/shop2"));
  assert.ok(!isInside("/home/me/shop", "/home/me/Shop/src"), "POSIX paths are case sensitive");
  assert.ok(!isInside("", "/x") && !isInside("/x", ""));
  assert.ok(isInside("C:\\Users\\Test User\\My Project", "C:\\Users\\Test User\\My Project\\a b\\c"));
});

test("readSettingsFile tells missing, valid and invalid apart, and does not mind a byte-order mark", () => {
  const dir = tmpDir();
  const f = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
  assert.equal(readSettingsFile(path.join(dir, "none.json")).status, "missing");
  assert.deepEqual(readSettingsFile(f("a.json", '{"a":1}')).data, { a: 1 });
  assert.deepEqual(readSettingsFile(f("bom.json", '\ufeff{"a":1}')).data, { a: 1 });
  assert.deepEqual(readSettingsFile(f("empty.json", "  \n")).data, {});
  assert.equal(readSettingsFile(f("bad.json", '{"a":1,}')).reason, "is not valid JSON");
  assert.equal(readSettingsFile(f("arr.json", "[1]")).reason, "is valid JSON but not an object");
  assert.equal(readSettingsFile(f("null.json", "null")).reason, "is valid JSON but not an object");
  assert.equal(readSettingsFile(dir).status, "invalid", "a folder where the file should be is not a settings file");
});

// What the real Claude Code 2.1.295 did with each of these, measured in test/e2e-retention.test.mjs.
test("retention: 30 days when nothing sets it", () => {
  const w = world("ret");
  const r = readRetention(w.env, { projectDir: w.project("p") });
  assert.equal(r.days, 30);
  assert.equal(r.source, "default");
  assert.equal(r.paused, null);
  assert.match(describeRetention(r), /30 days without a change \(cleanupPeriodDays is not set/);
});

test("retention: the user's setting, then the project's, then the project's local file, the last one wins", () => {
  const w = world("ret");
  const proj = w.project("p");
  const put = (file, days) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ cleanupPeriodDays: days })); };
  put(path.join(w.claude, "settings.json"), 10);
  let r = readRetention(w.env, { projectDir: proj });
  assert.deepEqual([r.days, r.source, r.file], [10, "user", path.join(w.claude, "settings.json")]);
  assert.match(describeRetention(r), /cleanupPeriodDays 10 in .*settings\.json/);
  put(path.join(proj, ".claude", "settings.json"), 3);
  r = readRetention(w.env, { projectDir: proj });
  assert.deepEqual([r.days, r.source], [3, "project"]);
  put(path.join(proj, ".claude", "settings.local.json"), 90);
  r = readRetention(w.env, { projectDir: proj });
  assert.deepEqual([r.days, r.source], [90, "local"]);
  r = readRetention(w.env, {});
  assert.deepEqual([r.days, r.source], [10, "user"], "without a project folder only the user's file counts");
  put(path.join(proj, ".claude", "settings.json"), 30);
  put(path.join(proj, ".claude", "settings.local.json"), 30);
  put(path.join(w.claude, "settings.json"), 1);
  assert.equal(readRetention(w.env, { projectDir: proj }).days, 30, "a project's 30 beats the user's 1");
});

test("retention: Claude Code pauses the whole cleanup for a settings file it cannot parse or a value it rejects", () => {
  const w = world("ret");
  const proj = w.project("p");
  for (const [text, why] of [
    ['{"cleanupPeriodDays":1,}', /is not valid JSON/],
    ["not json", /is not valid JSON/],
    ["[1]", /not an object/],
    ['{"cleanupPeriodDays":0}', /sets cleanupPeriodDays to 0/],
    ['{"cleanupPeriodDays":"1"}', /sets cleanupPeriodDays to "1"/],
    ['{"cleanupPeriodDays":1.5}', /sets cleanupPeriodDays to 1\.5/],
    ['{"cleanupPeriodDays":-3}', /sets cleanupPeriodDays to -3/],
    ['{"cleanupPeriodDays":null}', /sets cleanupPeriodDays to null/],
    ['{"cleanupPeriodDays":true}', /sets cleanupPeriodDays to true/],
  ]) {
    w.settings(text);
    const r = readRetention(w.env, { projectDir: proj });
    assert.ok(r.paused, text);
    assert.match(r.paused.reason, why, text);
    assert.equal(r.paused.file, path.join(w.claude, "settings.json"));
    assert.match(describeRetention(r), /cleanup is paused: .*settings\.json .*Nothing is swept until that is fixed/);
  }
  // the same in the project's own file
  w.settings({ cleanupPeriodDays: 5 });
  fs.mkdirSync(path.join(proj, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".claude", "settings.json"), "{bad");
  const r = readRetention(w.env, { projectDir: proj });
  assert.ok(r.paused && r.paused.file.endsWith(path.join(".claude", "settings.json")));
  assert.equal(r.days, 5, "the period that would apply is still shown");
});

test("retention: other invalid settings do not pause it when cleanupPeriodDays is not set", () => {
  const w = world("ret");
  w.settings({ model: 123 });
  const r = readRetention(w.env, {});
  assert.equal(r.paused, null);
  assert.equal(r.days, 30);
});

test("retention: desktopSessionCleanupPeriodDays is read from the user's file", () => {
  const w = world("ret");
  w.settings({ cleanupPeriodDays: 1, desktopSessionCleanupPeriodDays: 3 });
  assert.equal(readRetention(w.env, {}).desktopDays, 3);
  w.settings({ desktopSessionCleanupPeriodDays: -1 });
  assert.equal(readRetention(w.env, {}).desktopDays, 0);
  w.settings({});
  assert.equal(readRetention(w.env, {}).desktopDays, 0);
});
