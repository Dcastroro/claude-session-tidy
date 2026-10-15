import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { hookEntryFor, hookStatus, init, isOurHook, planInstall, planRemoval, readForEdit, uninstall } from "../src/install.mjs";
import { appDir, keepFile, settingsFile } from "../src/config.mjs";
import { VERSION } from "../src/version.mjs";
import { NOW, run, runCli, session, world } from "./helpers.mjs";

const settingsOf = (w) => settingsFile(w.env);
const backups = (w) => fs.readdirSync(w.claude).filter((f) => f.startsWith("settings.json.bak-session-tidy-")).sort();
const read = (w) => fs.readFileSync(settingsOf(w), "utf8");
const ours = (w) => readForEdit(settingsOf(w)).ours;

// Settings files in the shapes real ones come in. Each must come back byte for byte after init and uninstall.
const OTHER_HOOKS = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node", args: ["/opt/guard.mjs"], timeout: 5 }] }], Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] };
const RICH = { model: "opus", permissions: { allow: ["Bash(npm test:*)"], deny: ["Read(./.env)"] }, env: { FOO: "bar" }, statusLine: { type: "command", command: "node status.mjs" }, hooks: OTHER_HOOKS };
const CORPUS = {
  "empty object": "{}\n",
  "empty object, no final newline": "{}",
  "two-space indent": `${JSON.stringify(RICH, null, 2)}\n`,
  "four-space indent": `${JSON.stringify(RICH, null, 4)}\n`,
  "tab indent": `${JSON.stringify(RICH, null, "\t")}\n`,
  "no final newline": JSON.stringify(RICH, null, 2),
  "Windows line endings": `${JSON.stringify(RICH, null, 2).replace(/\n/g, "\r\n")}\r\n`,
  "one line": JSON.stringify(RICH),
  "hand-written with short arrays": '{\n  "model": "opus",\n  "permissions": {\n    "allow": ["Bash(npm test:*)", "Read"],\n    "deny": []\n  }\n}\n',
  "no hooks at all": `${JSON.stringify({ model: "opus", env: { A: "1" } }, null, 2)}\n`,
  "hooks without SessionStart": `${JSON.stringify({ hooks: { Stop: [] } }, null, 2)}\n`,
  "the person's own SessionStart hook": `${JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }], Stop: [] } }, null, 2)}\n`,
  "an inline SessionStart array": '{\n  "hooks": {\n    "SessionStart": [{ "hooks": [{ "type": "command", "command": "echo hi" }] }]\n  }\n}\n',
  "byte-order mark": `\ufeff${JSON.stringify(RICH, null, 2)}\n`,
  "unicode and escapes": '{\n  "note": "caf\\u00e9 \\"quoted\\" \\\\ back",\n  "emoji": "\\ud83d\\ude00"\n}\n',
  "numbers as written": '{\n  "a": 1.0,\n  "b": 1e3,\n  "c": -0.50\n}\n',
};

test("init, then uninstall, gives back the very same settings.json: 16 different files", () => {
  assert.equal(Object.keys(CORPUS).length, 16, "the title says how many");
  for (const [name, original] of Object.entries(CORPUS)) {
    const w = world("rt");
    fs.writeFileSync(settingsOf(w), original);
    const i = init(w.env, { now: NOW });
    assert.ok(i.ok, `${name}: ${i.settings.problem}`);
    assert.equal(i.settings.state, "added", name);
    assert.notEqual(read(w), original, `${name}: init changed the file`);
    assert.equal(ours(w).length, 1, name);
    const u = uninstall(w.env, { now: NOW + 1000 });
    assert.ok(u.ok, name);
    assert.equal(u.settings.state, "removed", name);
    assert.equal(read(w), original, `${name}: uninstall restored the file byte for byte`);
    assert.equal(backups(w).length, 2, name);
    assert.equal(fs.readFileSync(path.join(w.claude, backups(w)[0]), "utf8"), original, `${name}: the backup is the original`);
  }
});

test("init changes only the hooks: everything else in the file is exactly as it was", () => {
  const w = world("init");
  fs.writeFileSync(settingsOf(w), `${JSON.stringify(RICH, null, 4)}\n`);
  init(w.env, { now: NOW });
  const after = JSON.parse(read(w));
  const { SessionStart, ...otherHooks } = after.hooks;
  assert.deepEqual({ ...after, hooks: otherHooks }, RICH, "every other setting and every other hook");
  assert.deepEqual(SessionStart, [{ hooks: [hookEntryFor(w.env)] }]);
  assert.match(read(w), /^ {4}"model": "opus",/m, "the file's own 4-space indentation is kept");
  assert.ok(read(w).startsWith(`${JSON.stringify(RICH, null, 4).slice(0, 200)}`), "the start of the file is untouched");
});

test("the hook entry runs the installed copy quietly, in exec form so a path with spaces is safe", () => {
  const w = world("entry");
  const e = hookEntryFor(w.env);
  assert.equal(e.type, "command");
  assert.equal(e.command, "node");
  assert.deepEqual(e.args.slice(1), ["refresh", "--quiet"]);
  assert.ok(e.args[0].endsWith("/session-tidy/app/bin/claude-session-tidy.mjs"));
  assert.ok(!e.args[0].includes("\\"), "forward slashes, so the entry reads the same everywhere");
  assert.equal(e.timeout, 10);
  const spaced = world("with spaces");
  const withSpace = { ...spaced.env, CLAUDE_CONFIG_DIR: path.join(spaced.base, "my config", ".claude") };
  assert.ok(hookEntryFor(withSpace).args[0].includes("my config"));
});

test("init in an empty config folder: creates settings.json and copies the program", () => {
  const w = world("fresh");
  const r = init(w.env, { now: NOW });
  assert.ok(r.ok);
  assert.equal(r.settings.state, "created");
  assert.equal(r.settings.backup, "", "there was nothing to back up");
  assert.deepEqual(JSON.parse(read(w)), { hooks: { SessionStart: [{ hooks: [hookEntryFor(w.env)] }] } });
  assert.equal(backups(w).length, 0);
  for (const f of ["package.json", "bin/claude-session-tidy.mjs", "src/cli.mjs", "src/install.mjs", "src/jsonedit.mjs", "src/version.mjs"]) assert.ok(fs.existsSync(path.join(appDir(w.env), ...f.split("/"))), f);
  assert.deepEqual(r.check, { ok: true, version: VERSION });
  assert.deepEqual(fs.readdirSync(w.claude).sort(), ["session-tidy", "settings.json"]);
  assert.deepEqual(fs.readdirSync(path.join(w.claude, "session-tidy")), ["app"], "nothing else is written");
  assert.ok(!fs.existsSync(path.join(appDir(w.env), "test")), "the tests are not copied");
});

test("the installed copy is a working program: --version, and refresh --quiet as the hook runs it", () => {
  const w = world("copy");
  init(w.env, { now: NOW });
  const entry = JSON.parse(read(w)).hooks.SessionStart[0].hooks[0];
  const v = spawnSync(process.execPath, [entry.args[0], "--version"], { encoding: "utf8", env: w.env });
  assert.equal(v.stdout.trim(), VERSION);
  const hook = spawnSync(process.execPath, entry.args, { encoding: "utf8", env: w.env, cwd: w.base });
  assert.deepEqual([hook.status, hook.stdout, hook.stderr], [0, "", ""]);
});

test("a second init changes nothing and makes no second backup", () => {
  const w = world("twice");
  fs.writeFileSync(settingsOf(w), `${JSON.stringify(RICH, null, 2)}\n`);
  init(w.env, { now: NOW });
  const once = read(w);
  const n = backups(w).length;
  const again = init(w.env, { now: NOW + 5000 });
  assert.equal(again.settings.state, "unchanged");
  assert.equal(read(w), once);
  assert.equal(backups(w).length, n);
  assert.equal(ours(w).length, 1);
});

test("init replaces an entry of ours that points somewhere else, and drops repeats, keeping the other hooks", () => {
  const w = world("stale");
  const stale = { type: "command", command: "node", args: ["C:/old/.claude/session-tidy/app/bin/claude-session-tidy.mjs", "refresh", "--quiet"], timeout: 3 };
  const user = { type: "command", command: "echo keep" };
  fs.writeFileSync(settingsOf(w), JSON.stringify({ hooks: { SessionStart: [{ hooks: [stale, user] }, { hooks: [stale] }] } }, null, 2));
  const r = init(w.env, { now: NOW });
  assert.equal(r.settings.state, "replaced");
  assert.deepEqual(JSON.parse(read(w)).hooks.SessionStart, [{ hooks: [user] }, { hooks: [hookEntryFor(w.env)] }]);
  assert.equal(backups(w).length, 1);
});

test("a settings.json that is not valid is left alone: exit 1, the snippet to add by hand, nothing copied", async () => {
  for (const [name, bad, why] of [
    ["trailing comma", '{ "model": "opus", }', /is not valid JSON/],
    ["not JSON", "model: opus", /is not valid JSON/],
    ["comments", '{ // note\n "a": 1 }', /is not valid JSON/],
    ["an array", "[1, 2]", /not an object/],
    ["hooks is a list", '{ "hooks": [] }', /"hooks" value that is not an object/],
    ["SessionStart is an object", '{ "hooks": { "SessionStart": {} } }', /"hooks\.SessionStart" value that is not an array/],
    ["a folder", null, /cannot be read/],
  ]) {
    const w = world("bad");
    if (bad === null) fs.mkdirSync(settingsOf(w)); else fs.writeFileSync(settingsOf(w), bad);
    const r = init(w.env, { now: NOW });
    assert.equal(r.ok, false, name);
    assert.equal(r.settings.state, "invalid", name);
    assert.match(r.settings.problem, why, name);
    assert.ok(r.settings.problem.includes("left it alone and copied nothing"), name);
    assert.deepEqual(r.snippet, { hooks: { SessionStart: [{ hooks: [hookEntryFor(w.env)] }] } }, name);
    if (bad !== null) assert.equal(read(w), bad, `${name}: the file is untouched`);
    assert.equal(backups(w).length, 0);
    assert.ok(!fs.existsSync(appDir(w.env)), `${name}: nothing was copied`);
    const cli = await run(["init"], w);
    assert.equal(cli.code, 1, name);
    assert.match(cli.err, /Add this by hand under the top-level "hooks" key/);
    assert.match(cli.err, /"SessionStart"/);
    const un = uninstall(w.env, { now: NOW });
    assert.equal(un.ok, false, `${name}: uninstall also leaves it alone`);
  }
});

test("an empty settings.json counts as {}", () => {
  const w = world("blank");
  fs.writeFileSync(settingsOf(w), "  \n");
  const r = init(w.env, { now: NOW });
  assert.ok(r.ok);
  assert.equal(r.settings.state, "added");
  assert.deepEqual(JSON.parse(read(w)), { hooks: { SessionStart: [{ hooks: [hookEntryFor(w.env)] }] } });
  assert.equal(fs.readFileSync(path.join(w.claude, backups(w)[0]), "utf8"), "  \n");
  uninstall(w.env, { now: NOW });
  assert.deepEqual(JSON.parse(read(w)), {});
});

test("an empty \"hooks\": {} is the one thing uninstall does not give back: it goes with our entry", () => {
  const w = world("emptyhooks");
  fs.writeFileSync(settingsOf(w), '{\n  "model": "opus",\n  "hooks": {}\n}\n');
  init(w.env, { now: NOW });
  uninstall(w.env, { now: NOW + 1000 });
  assert.equal(read(w), '{\n  "model": "opus"\n}\n');
});

test("--dry-run writes nothing: no copy, no backup, no change", () => {
  const w = world("dry");
  fs.writeFileSync(settingsOf(w), `${JSON.stringify(RICH, null, 2)}\n`);
  const before = read(w);
  const r = init(w.env, { dryRun: true, now: NOW });
  assert.ok(r.ok && r.dryRun);
  assert.equal(r.settings.state, "added");
  assert.equal(read(w), before);
  assert.deepEqual(fs.readdirSync(w.claude), ["settings.json"]);
  init(w.env, { now: NOW });
  const installed = read(w);
  const files = fs.readdirSync(w.claude).sort();
  const u = uninstall(w.env, { dryRun: true, now: NOW });
  assert.equal(u.settings.state, "removed");
  assert.equal(u.app.removed, true);
  assert.equal(read(w), installed);
  assert.deepEqual(fs.readdirSync(w.claude).sort(), files);
  assert.ok(fs.existsSync(appDir(w.env)));
});

test("uninstall takes out our hook and our copy, and keeps the person's data", () => {
  const w = world("un");
  fs.writeFileSync(settingsOf(w), `${JSON.stringify(RICH, null, 2)}\n`);
  init(w.env, { now: NOW });
  fs.writeFileSync(keepFile(w.env), '{"version":1,"kept":{}}\n');
  fs.mkdirSync(path.join(w.claude, "session-tidy", "trash", "x"), { recursive: true });
  fs.writeFileSync(path.join(w.claude, "session-tidy", "errors.log"), "x\n");
  const u = uninstall(w.env, { now: NOW + 60000 });
  assert.equal(u.ok, true);
  assert.equal(u.settings.removed, 1);
  assert.deepEqual(JSON.parse(read(w)), RICH);
  assert.ok(!fs.existsSync(appDir(w.env)));
  assert.deepEqual(u.kept.map((p) => path.basename(p)).sort(), ["errors.log", "keep.json", "trash"]);
  for (const p of u.kept) assert.ok(fs.existsSync(p));
  assert.match(path.basename(u.settings.backup), /^settings\.json\.bak-session-tidy-\d{8}-\d{6}$/);
  // and a second uninstall has nothing to do
  const n = backups(w).length;
  const again = uninstall(w.env, { now: NOW + 120000 });
  assert.equal(again.settings.state, "unchanged");
  assert.equal(again.app.removed, false);
  assert.equal(backups(w).length, n, "no backup when nothing changes");
});

test("uninstall leaves the person's own SessionStart hooks alone, even beside ours in one group", () => {
  const w = world("un");
  const mine = { type: "command", command: "echo mine" };
  fs.writeFileSync(settingsOf(w), JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [mine, hookEntryFor(w.env)] }, { hooks: [hookEntryFor(w.env)] }] } }, null, 2));
  assert.equal(ours(w).length, 2);
  const u = uninstall(w.env, { now: NOW });
  assert.equal(u.settings.removed, 2);
  assert.deepEqual(JSON.parse(read(w)), { hooks: { SessionStart: [{ matcher: "startup", hooks: [mine] }] } });
});

test("two changes in the same second get two backups, neither overwritten", () => {
  const w = world("stamp");
  fs.writeFileSync(settingsOf(w), "{}\n");
  init(w.env, { now: NOW });
  uninstall(w.env, { now: NOW });
  init(w.env, { now: NOW });
  const names = backups(w);
  assert.equal(names.length, 3, "an init, an uninstall, an init: every one backed the file up");
  assert.match(names[1], /-2$/);
  assert.match(names[2], /-3$/);
});

test("isOurHook recognises our copy in either slash style and nothing else", () => {
  assert.ok(isOurHook({ type: "command", command: "node", args: ["C:\\Users\\me\\.claude\\session-tidy\\app\\bin\\claude-session-tidy.mjs", "refresh", "--quiet"] }));
  assert.ok(isOurHook({ type: "command", command: 'node "/home/me/.claude/session-tidy/app/bin/claude-session-tidy.mjs" refresh' }));
  for (const other of [
    { type: "command", command: "node", args: ["/home/me/tools/claude-session-tidy.mjs", "refresh"] },
    { type: "command", command: "echo session-tidy" },
    { type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/bin/claude-session-tidy.mjs", "refresh", "--quiet"] },
    null, "text", {}, { command: 5 },
  ]) assert.ok(!isOurHook(other), JSON.stringify(other));
});

test("hookStatus: installed, the plugin enabled, or neither", () => {
  const w = world("status");
  assert.deepEqual(hookStatus(w.env), { installed: false, plugin: "", invalid: false });
  w.settings({ enabledPlugins: { "session-tidy@claude-code-toolkit": true, "other@x": true } });
  assert.deepEqual(hookStatus(w.env), { installed: false, plugin: "session-tidy@claude-code-toolkit", invalid: false });
  w.settings({ enabledPlugins: { "session-tidy@claude-code-toolkit": false } });
  assert.equal(hookStatus(w.env).plugin, "");
  fs.writeFileSync(settingsOf(w), "{ bad");
  assert.deepEqual(hookStatus(w.env), { installed: false, plugin: "", invalid: true });
  fs.writeFileSync(settingsOf(w), "{}\n");
  init(w.env, { now: NOW });
  assert.equal(hookStatus(w.env).installed, true);
});

test("init says when the plugin runs the same hook", () => {
  const w = world("plugin");
  w.settings({ enabledPlugins: { "session-tidy@claude-code-toolkit": true } });
  const r = init(w.env, { now: NOW });
  assert.equal(r.plugin, "session-tidy@claude-code-toolkit");
});

test("a BOM and CRLF in settings.json survive init", () => {
  const w = world("bom");
  const original = `\ufeff${JSON.stringify({ model: "opus" }, null, 2).replace(/\n/g, "\r\n")}\r\n`;
  fs.writeFileSync(settingsOf(w), original);
  init(w.env, { now: NOW });
  const text = read(w);
  assert.ok(text.startsWith("\ufeff{"), "the byte-order mark is still first");
  assert.ok(!/[^\r]\n/.test(text.slice(1)), "every line break is still CRLF");
});

test("settings.json that is a symbolic link is written through, so the link stays", (t) => {
  const w = world("link");
  const real = path.join(w.base, "dotfiles-settings.json");
  fs.writeFileSync(real, "{}\n");
  try { fs.symlinkSync(real, settingsOf(w)); } catch { t.skip("this system does not allow creating symbolic links here"); return; }
  init(w.env, { now: NOW });
  assert.ok(fs.lstatSync(settingsOf(w)).isSymbolicLink());
  assert.equal(ours(w).length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(real, "utf8")).hooks.SessionStart.length, 1);
});

test("random settings files all come back unchanged (300 files)", () => {
  const dir = world("rand").claude;
  const env = world("rand-env").env;
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const KEYS = ["model", "env", "permissions", "statusLine", "theme", "cleanupPeriodDays", "extra"];
  const val = (d = 0) => {
    const k = Math.floor(rnd() * (d > 2 ? 4 : 6));
    if (k === 0) return Math.floor(rnd() * 100);
    if (k === 1) return ["opus", "a b", "caf\u00e9", "x\"y"][Math.floor(rnd() * 4)];
    if (k === 2) return rnd() < 0.5;
    if (k === 3) return null;
    if (k === 4) return Array.from({ length: Math.floor(rnd() * 4) }, () => val(d + 1));
    return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 4) }, (_, i) => [KEYS[Math.floor(rnd() * KEYS.length)] + i, val(d + 1)]));
  };
  for (let n = 0; n < 300; n++) {
    const doc = Object.fromEntries(Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, i) => [KEYS[Math.floor(rnd() * KEYS.length)] + i, val()]));
    if (rnd() < 0.3) doc.hooks = { Stop: [{ hooks: [{ type: "command", command: "echo" }] }] };
    const unit = [2, 4, "\t"][Math.floor(rnd() * 3)];
    let text = JSON.stringify(doc, null, unit);
    if (rnd() < 0.3) text = text.replace(/\[\n\s*([^\[\]{}]*?)\n\s*\]/g, (m, inner) => `[${inner.split(/,\n\s*/).join(", ")}]`); // some arrays on one line
    if (rnd() < 0.3) text = text.replace(/\n/g, "\r\n");
    if (rnd() < 0.7) text += text.includes("\r\n") ? "\r\n" : "\n";
    const file = path.join(dir, `s${n}.json`);
    fs.writeFileSync(file, text);
    JSON.parse(text);
    const cur = readForEdit(file);
    const planned = planInstall(cur, env);
    assert.ok(planned.text && !planned.problem, `file ${n}: ${planned.problem}\n${text}`);
    assert.equal(planned.state, "added");
    fs.writeFileSync(file, (cur.bom || "") + planned.text);
    const back = planRemoval(readForEdit(file));
    assert.equal(back.removed, 1, `file ${n}`);
    assert.equal(back.text, text, `file ${n}`);
  }
});

test("init and uninstall through the command line, with --json", () => {
  const w = world("cli");
  const r = runCli(["init", "--json"], { cwd: w.base, env: w.env });
  assert.equal(r.code, 0, r.all);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, true);
  assert.equal(j.settings.state, "created");
  assert.equal(j.check.ok, true);
  assert.equal(j.configDir, w.claude);
  const u = runCli(["uninstall", "--json"], { cwd: w.base, env: w.env });
  assert.equal(u.code, 0, u.all);
  const uj = JSON.parse(u.out);
  assert.equal(uj.settings.state, "removed");
  assert.equal(uj.app.removed, true);
  assert.deepEqual(JSON.parse(read(w)), {});
});

test("a config folder whose path has spaces: init, the hook started the way Claude Code starts it, uninstall", () => {
  const w = world("with space");
  assert.ok(w.claude.includes(" "), w.claude);
  const old = Date.now() - 20 * 86400000;
  const s = session(w, { id: "11111111-1111-4111-8111-111111111111", project: "my project", mtime: old, companions: true });
  assert.equal(runCli(["keep", s.id], { cwd: w.base, env: w.env }).code, 0);
  for (const f of [s.file, path.join(w.claude, ...s.rel[2].split("/"))]) fs.utimesSync(f, new Date(old), new Date(old));
  const i = init(w.env, { now: NOW });
  assert.ok(i.ok, i.settings.problem);
  const entry = JSON.parse(read(w)).hooks.SessionStart[0].hooks[0];
  assert.equal(entry.command, "node");
  assert.ok(entry.args[0].includes("with space"), entry.args[0]);
  const hook = spawnSync(process.execPath, entry.args, { env: w.env, cwd: w.base, encoding: "utf8" });
  assert.deepEqual([hook.status, hook.stdout, hook.stderr], [0, "", ""]);
  assert.ok(Date.now() - fs.statSync(s.file).mtimeMs < 120000, "refresh ran from the folder with spaces and touched the kept session");
  assert.ok(uninstall(w.env, { now: NOW }).ok);
  assert.ok(!fs.existsSync(appDir(w.env)));
});

test("uninstall leaves no empty session-tidy folder behind, and keeps one that holds the person's data", () => {
  const a = world("tidyfolder");
  init(a.env, { now: NOW });
  assert.ok(fs.existsSync(path.join(a.claude, "session-tidy")));
  uninstall(a.env, { now: NOW });
  assert.ok(!fs.existsSync(path.join(a.claude, "session-tidy")), "nothing of ours is left");
  const b = world("tidyfolder2");
  init(b.env, { now: NOW });
  fs.writeFileSync(path.join(b.claude, "session-tidy", "keep.json"), '{"version":1,"kept":{}}\n');
  uninstall(b.env, { now: NOW });
  assert.deepEqual(fs.readdirSync(path.join(b.claude, "session-tidy")), ["keep.json"]);
});
