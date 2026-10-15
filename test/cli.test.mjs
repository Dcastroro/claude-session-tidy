import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { main } from "../src/cli.mjs";
import { keepFile, readRetention } from "../src/config.mjs";
import { DAY, NOW, ROOT, mtimeOf, run, runCli, session, snapshot, world } from "./helpers.mjs";

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const B = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const C = "cccccccc-1111-4111-8111-cccccccccccc";
const D = "dddddddd-1111-4111-8111-dddddddddddd";

// One world for the read-only tests: three sessions in one project, one in another, one from Claude Desktop.
const w = world("cli");
const a = session(w, { id: A, project: "shop", prompt: "Fix the login redirect loop", prompts: 5, ageDays: 2, companions: true, aiTitle: "Fix login redirect loop" });
const b = session(w, { id: B, project: "shop", prompt: "Spike: caching with | pipes and `ticks`", ageDays: 29 });
const c = session(w, { id: C, project: "shop", prompts: 0, ageDays: 5 });
const d = session(w, { id: D, project: "other", prompt: "an unrelated chat", ageDays: 60, entrypoint: "claude-desktop", customTitle: "Desktop work" });
fs.rmSync(path.join(w.claude, "projects", a.slug, A, "custom-title.json")); // so the title below comes from the transcript

// --- help, version, errors ---------------------------------------------------------------------

test("help is printed for no arguments, help, --help and -h, and names every command", async () => {
  for (const argv of [[], ["help"], ["--help"], ["-h"], ["list", "--help"], ["delete", "-h"], ["tidy", "--help"]]) {
    const r = await run(argv, w);
    assert.equal(r.code, 0, argv.join(" "));
    for (const part of ["claude-session-tidy list", "claude-session-tidy delete", "claude-session-tidy restore", "claude-session-tidy keep", "claude-session-tidy unkeep", "claude-session-tidy refresh", "claude-session-tidy tidy", "claude-session-tidy empty-trash", "claude-session-tidy init", "claude-session-tidy uninstall", "--sort age|size|prompts", "--older <days>", "--markdown", "--dry-run", "--yes", "--quiet", "$CLAUDE_CONFIG_DIR", "github.com/nrzz/claude-session-tidy", "Nothing is sent anywhere"]) {
      assert.ok(r.out.includes(part), `${argv.join(" ")}: ${part}`);
    }
  }
});

test("--version prints the package version", async () => {
  for (const flag of ["--version", "-v", "version"]) assert.equal((await run([flag], w)).out.trim(), pkg.version);
});

test("an unknown command or option is an error with the usage, exit code 1", async () => {
  const bad = await run(["bogus"], w);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /Unknown command "bogus"/);
  assert.match(bad.err, /claude-session-tidy delete/);
  const opt = await run(["list", "--bogus"], w);
  assert.equal(opt.code, 1);
  assert.match(opt.err, /Unknown option --bogus\. Run claude-session-tidy --help/);
  assert.equal((await run(["delete", "x", "--all"], w)).code, 1, "an option of another command is unknown here");
  assert.equal((await run(["list", "--sort"], w)).code, 1);
  assert.match((await run(["list", "--sort"], w)).err, /--sort needs a value/);
  assert.match((await run(["list", "--all=1"], w)).err, /--all does not take a value/);
  assert.match((await run(["list", "--sort", "weight"], w)).err, /--sort must be age, size or prompts/);
  for (const bad of ["0", "-1", "x", "1.5"]) assert.match((await run(["list", "--limit", bad], w)).err, /--limit needs a whole number, 1 or more/);
  const both = await run(["list", "--json", "--markdown"], w);
  assert.equal(both.code, 1);
  assert.match(JSON.parse(both.out).error, /Choose --json or --markdown/, "with --json an error is a JSON document too");
});

test("--option=value works, and -- ends the options", async () => {
  const r = await run(["list", "--all", "--sort=size", "--limit=1"], w);
  assert.equal(r.code, 0);
  assert.match(r.out, /\(1 of 4, largest first\)/);
  const x = await run(["delete", "--", "--dry-run"], w);
  assert.equal(x.code, 1);
  assert.match(x.err, /No session has the id "--dry-run"/);
});

// --- list --------------------------------------------------------------------------------------

test("list shows this project's sessions, newest first, with id, last activity, prompts, size, sweep day and title", async () => {
  const r = await run(["list"], w, { cwd: a.root });
  assert.equal(r.code, 0, r.all);
  const lines = r.out.split("\n");
  assert.equal(lines[0], `Sessions in ${a.root} (3, newest first)`);
  assert.equal(lines[1], "Cleanup: 30 days without a change (cleanupPeriodDays is not set, so Claude Code's default applies).");
  assert.equal(lines[3], "  ID        LAST ACTIVITY     PROMPTS      SIZE  KEPT  SWEEP       TITLE");
  assert.match(lines[4], /^ {2}aaaaaaaa {2}2026-10-1\d \d\d:\d\d +5 +\d+ KB {8}2026-11-1\d {2}Fix login redirect loop$/);
  assert.match(lines[5], /^ {2}cccccccc {2}2026-10-\d\d \d\d:\d\d +0 +\d+ B {8}2026-11-\d\d {2}\(untitled session\)$/);
  assert.match(lines[6], /^ {2}bbbbbbbb {2}2026-09-1\d \d\d:\d\d +1 +\d+ KB {8}2026-10-1\d {2}Spike: caching with \| pipes and `ticks`$/);
  assert.ok(!r.out.includes("dddddddd"), "another project is left out");
  assert.match(r.out, /3 sessions, \d+ KB on disk, counting each session's own subagent/);
});

test("list --all covers every project and names each one; a Claude Desktop session says exempt", async () => {
  const r = await run(["list", "--all"], w, { cwd: w.base });
  assert.match(r.out.split("\n")[0], /^Sessions in all projects \(4, newest first\)$/);
  const rows = r.out.split("\n").filter((l) => /^ {2}[0-9a-f]{8} /.test(l));
  assert.deepEqual(rows.map((l) => l.trim().slice(0, 8)), ["aaaaaaaa", "cccccccc", "bbbbbbbb", "dddddddd"]);
  assert.match(r.out, /PROJECT +TITLE/);
  assert.match(rows[3], /exempt +other +Desktop work$/);
  assert.match(rows[0], / shop +Fix login/);
});

test("list --project picks another folder; --limit shortens the list and says how many there are", async () => {
  const r = await run(["list", "--project", d.root], w, { cwd: w.base });
  assert.match(r.out, /dddddddd/);
  assert.ok(!r.out.includes("aaaaaaaa"));
  const rel = await run(["list", "--project", path.join("work", "other")], w, { cwd: w.base });
  assert.match(rel.out, /dddddddd/, "a relative folder is resolved from where you are");
  const limited = await run(["list", "--limit", "2"], w, { cwd: a.root });
  assert.match(limited.out.split("\n")[0], /\(2 of 3, newest first\)/);
  assert.equal(limited.out.split("\n").filter((l) => /^ {2}[0-9a-f]{8} /.test(l)).length, 2);
  assert.ok(!limited.out.includes("on disk"), "no total when not every session was measured");
});

test("list --sort size and --sort prompts order by those columns", async () => {
  const bySize = await run(["list", "--sort", "size"], w, { cwd: a.root });
  assert.match(bySize.out, /largest first/);
  const sizeRows = bySize.out.split("\n").filter((l) => /^ {2}[0-9a-f]{8} /.test(l)).map((l) => l.trim().slice(0, 8));
  assert.equal(sizeRows[0], "aaaaaaaa", "the one with companion files is the largest");
  assert.match(bySize.out, /on disk/, "sorting by size measures everything, so the total is shown");
  const byPrompts = await run(["list", "--sort", "prompts"], w, { cwd: a.root });
  assert.deepEqual(byPrompts.out.split("\n").filter((l) => /^ {2}[0-9a-f]{8} /.test(l)).map((l) => l.trim().slice(0, 8)), ["aaaaaaaa", "bbbbbbbb", "cccccccc"]);
  assert.match(byPrompts.out, /most prompts first/);
});

test("list says so when there is nothing", async () => {
  const empty = world("none");
  const r = await run(["list"], empty);
  assert.equal(r.code, 0);
  assert.match(r.out, /^No Claude Code sessions found for .* \(looked in .*projects\)\.\nUse --all to list every project's sessions\.\n$/);
  const all = await run(["list", "--all"], empty);
  assert.ok(!all.out.includes("Use --all"));
  assert.deepEqual(JSON.parse((await run(["list", "--json"], empty)).out).sessions, []);
  assert.match((await run(["list", "--markdown"], empty)).out, /No sessions\./);
});

test("the sweep day follows cleanupPeriodDays, and a due session is called due", async () => {
  const x = world("sweep");
  const old = session(x, { id: A, project: "shop", ageDays: 40 });
  session(x, { id: B, project: "shop", ageDays: 10 });
  x.settings({ cleanupPeriodDays: 7 });
  const r = await run(["list"], x, { cwd: old.root });
  assert.match(r.out, /\(cleanupPeriodDays 7 in .*settings\.json\)/);
  const rows = r.out.split("\n").filter((l) => /^ {2}[0-9a-f]{8} /.test(l));
  assert.match(rows[0], / due /, "10 days is more than 7");
  assert.match(rows[1], / due /);
  assert.match(r.out, /2 sessions are past the cleanup date: Claude Code removes them the next time it starts\. "keep" saves a session\./);
  x.settings({ cleanupPeriodDays: 30 });
  const ok = await run(["list"], x, { cwd: old.root });
  assert.match(ok.out.split("\n").filter((l) => /^ {2}bbbbbbbb /.test(l))[0], /2026-11-04/);
  assert.match(ok.out, /1 session is past the cleanup date: Claude Code removes it the next time/);
});

test("a project's own cleanupPeriodDays is used for that project", async () => {
  const x = world("projset");
  const s = session(x, { id: A, project: "shop", ageDays: 5 });
  fs.mkdirSync(path.join(s.root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(s.root, ".claude", "settings.json"), '{"cleanupPeriodDays":3}');
  const r = await run(["list"], x, { cwd: s.root });
  assert.match(r.out, /cleanupPeriodDays 3 in .*\.claude.settings\.json/);
  assert.match(r.out, / due /);
  const elsewhere = await run(["list", "--all"], x, { cwd: x.base });
  assert.match(elsewhere.out, /is not set, so Claude Code's default applies/);
});

test("when Claude Code's cleanup is paused, list says why and shows no day", async () => {
  const x = world("paused");
  const s = session(x, { id: A, project: "shop", ageDays: 40 });
  x.settings('{ "cleanupPeriodDays": 1, }');
  const r = await run(["list"], x, { cwd: s.root });
  assert.match(r.out, /Cleanup: Claude Code's cleanup is paused: .*settings\.json is not valid JSON\. Nothing is swept until that is fixed\./);
  assert.match(r.out.split("\n").filter((l) => /^ {2}aaaaaaaa /.test(l))[0], / paused /);
  assert.ok(!r.out.includes("past the cleanup date"));
  const j = JSON.parse((await run(["list", "--json"], x, { cwd: s.root })).out);
  assert.equal(j.retention.paused.reason, "is not valid JSON");
  assert.equal(j.sessions[0].sweep.state, "paused");
  assert.equal(j.sessions[0].sweep.on, "");
});

test("kept sessions are marked, and the footer says whether anything refreshes them", async () => {
  const x = world("kept");
  const s = session(x, { id: A, project: "shop", ageDays: 25 });
  session(x, { id: B, project: "shop", ageDays: 25 });
  assert.equal((await run(["keep", "aaaaaaaa"], x, { cwd: s.root })).code, 0);
  let r = await run(["list"], x, { cwd: s.root });
  assert.match(r.out.split("\n").filter((l) => /^ {2}aaaaaaaa /.test(l))[0], / yes {3}2026-11-14 /, "kept, and the day it would go without the hook");
  assert.ok(!/ yes /.test(r.out.split("\n").filter((l) => /^ {2}bbbbbbbb /.test(l))[0]), "the other one is not");
  assert.match(r.out, /1 kept; no hook refreshes them yet: run claude-session-tidy init\./);
  x.settings({ enabledPlugins: { "session-tidy@claude-code-toolkit": true } });
  r = await run(["list"], x, { cwd: s.root });
  assert.match(r.out, /1 kept; the plugin session-tidy@claude-code-toolkit refreshes them\./);
  assert.equal((await run(["init"], world("other"), {})).code, 0);
  assert.equal((await run(["init"], x, { cwd: s.root })).code, 0);
  r = await run(["list"], x, { cwd: s.root });
  assert.match(r.out, /1 kept; the SessionStart hook refreshes them\./);
  // a kept session whose files are gone is reported
  fs.rmSync(s.file);
  r = await run(["list", "--all"], x, { cwd: s.root });
  assert.match(r.out, /1 kept session no longer exists: aaaaaaaa\. "unkeep" takes them off the list\./);
});

test("a kept session that nothing has refreshed is flagged: kept does not mean safe by itself", async () => {
  const x = world("keptdue");
  const s = session(x, { id: A, project: "shop", ageDays: 25 });
  await run(["keep", "aaaaaaaa"], x, { cwd: s.root });
  const t = new Date(NOW - 40 * DAY);
  fs.utimesSync(s.file, t, t); // forty days pass and no hook or cron job runs refresh
  const r = await run(["list"], x, { cwd: s.root });
  assert.match(r.out.split("\n").filter((l) => /^ {2}aaaaaaaa /.test(l))[0], / yes {3}due /);
  assert.match(r.out, /1 kept session is past the cleanup date too, because nothing has touched it lately: run claude-session-tidy refresh now\./);
  assert.ok(!r.out.includes("1 session is past the cleanup date"), "it is not also counted as an unkept one");
  assert.equal((await run(["refresh"], x, { cwd: s.root })).code, 0);
  const after = await run(["list"], x, { cwd: s.root });
  assert.match(after.out.split("\n").filter((l) => /^ {2}aaaaaaaa /.test(l))[0], / yes {3}2026-11-14 /);
});

test("the trash is mentioned when it is not empty", async () => {
  const x = world("trashline");
  const s = session(x, { id: A, project: "shop" });
  session(x, { id: B, project: "shop" });
  assert.ok(!(await run(["list"], x, { cwd: s.root })).out.includes("Trash:"));
  await run(["delete", "aaaaaaaa"], x, { cwd: s.root });
  assert.match((await run(["list"], x, { cwd: s.root })).out, /Trash: 1 session, [\d.]+ KB|Trash: 1 session, \d+ B\. claude-session-tidy restore <id> brings one back\./);
});

test("titles: /rename, then Claude's title, then the first prompt; control codes in a title cannot reach the terminal", async () => {
  const x = world("titles");
  session(x, { id: A, project: "shop", prompt: "first prompt text", aiTitle: "AI title", customTitle: "Renamed" });
  session(x, { id: B, project: "shop", prompt: "only a prompt" });
  const hostile = session(x, { id: C, project: "shop", prompt: "\u001b[31mred\u001b[0m \u202eevil\u0007 title\nsecond line", ageDays: 3 });
  const r = await run(["list"], x, { cwd: hostile.root });
  assert.match(r.out, /Renamed/);
  assert.match(r.out, /only a prompt/);
  assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e]/.test(r.out.replace(/\n/g, "")), "no control characters or direction overrides");
  assert.match(r.out, /red evil title second line/);
});

test("list --json is one document with every field", async () => {
  const r = await run(["list", "--json"], w, { cwd: a.root });
  const j = JSON.parse(r.out);
  assert.deepEqual(Object.keys(j), ["schema", "tool", "version", "configDir", "scope", "retention", "hook", "total", "shown", "bytes", "keptMissing", "sessions"]);
  assert.equal(j.schema, 1);
  assert.equal(j.tool, "claude-session-tidy");
  assert.equal(j.version, pkg.version);
  assert.equal(j.configDir, w.claude);
  assert.deepEqual(j.scope, { all: false, project: a.root });
  assert.deepEqual(j.retention, { days: 30, source: "default", file: "", paused: null, desktopDays: 0 });
  assert.deepEqual(j.hook, { installed: false, plugin: "" });
  assert.equal(j.total, 3);
  assert.ok(j.bytes > 0);
  const s = j.sessions[0];
  assert.deepEqual(Object.keys(s), ["id", "short", "project", "cwd", "slug", "title", "prompts", "lastActivity", "modified", "bytes", "files", "kept", "entrypoint", "sweep", "file"]);
  assert.equal(s.id, A);
  assert.equal(s.short, "aaaaaaaa");
  assert.equal(s.project, "shop");
  assert.equal(s.cwd, a.root);
  assert.equal(s.title, "Fix login redirect loop");
  assert.equal(s.prompts, 5);
  assert.equal(s.modified, new Date(NOW - 2 * DAY).toISOString());
  assert.equal(s.files, 14, "the transcript and 13 other files (the title file was removed at the top of this test file)");
  assert.equal(s.kept, false);
  assert.equal(s.entrypoint, "cli");
  assert.deepEqual(s.sweep, { state: "scheduled", on: new Date(NOW + 28 * DAY).toISOString(), daysLeft: 28 });
  assert.equal(s.file, a.file);
  const all = JSON.parse((await run(["list", "--all", "--json"], w, { cwd: a.root })).out);
  assert.equal(all.sessions.find((x) => x.id === D).sweep.state, "exempt");
  assert.equal(all.sessions.find((x) => x.id === D).entrypoint, "claude-desktop");
});

test("list --markdown is a compact table for the skill, capped at 40 rows", async () => {
  const r = await run(["list", "--markdown", "--limit", "15"], w, { cwd: a.root });
  const lines = r.out.trimEnd().split("\n");
  assert.equal(lines[0], `**Sessions in ${a.root} (3, newest first)**`);
  assert.equal(lines[3], "| id | last activity | prompts | size | kept | sweep | title |");
  assert.equal(lines[4], "| --- | --- | ---: | ---: | --- | --- | --- |");
  assert.match(lines[5], /^\| aaaaaaaa \| 2026-10-1\d \d\d:\d\d \| 5 \| \d+ KB \| {2}\| 2026-11-1\d \| Fix login redirect loop \|$/);
  assert.match(lines[7], /Spike: caching with \\\| pipes and 'ticks' \|$/, "pipes are escaped and backticks cannot start code in the table");
  assert.ok(lines.length < 20);
  assert.ok(!r.out.includes("\u001b"));
  const x = world("many");
  const first = session(x, { id: uuidOf(0), project: "shop" });
  for (let i = 1; i < 60; i++) session(x, { id: uuidOf(i), project: "shop", ageDays: 1 + i * 0.1 });
  const big = await run(["list", "--markdown"], x, { cwd: first.root });
  const rows = big.out.split("\n").filter((l) => /^\| [0-9a-f]{8}/.test(l));
  assert.equal(rows.length, 40);
  assert.match(big.out, /\(40 rows shown; the report is capped at 40\.\)/);
  assert.ok(big.out.split("\n").length < 60, "under 60 lines");
  const wide = await run(["list", "--all", "--markdown", "--limit", "1"], w, { cwd: a.root });
  assert.match(wide.out, /\| id \| last activity \| prompts \| size \| kept \| sweep \| project \| title \|/);
});
function uuidOf(i) { return `${String(i).padStart(8, "0")}-1111-4111-8111-aaaaaaaaaaaa`; }

test("ids longer than 8 characters appear where two sessions share their first 8", async () => {
  const x = world("longid");
  const s = session(x, { id: "abcdef12-1111-4111-8111-aaaaaaaaaaaa", project: "shop" });
  session(x, { id: "abcdef12-2222-4222-8222-bbbbbbbbbbbb", project: "shop", ageDays: 2 });
  const r = await run(["list"], x, { cwd: s.root });
  assert.match(r.out, /abcdef12-1 /);
  assert.match(r.out, /abcdef12-2 /);
  assert.match((await run(["delete", "abcdef12-1", "--dry-run"], x, { cwd: s.root })).out, /Would move 1 session/);
  assert.match((await run(["delete", "abcdef12", "--dry-run"], x, { cwd: s.root })).err, /is ambiguous: 2 sessions start with it/);
});

test("colours only on a terminal, never with NO_COLOR", async () => {
  const out = [];
  const code = await main(["list"], { cwd: a.root, env: { ...w.env, FORCE_COLOR: "1", NO_COLOR: "" }, tty: true, columns: 120, now: NOW, out: (s) => out.push(s), err: () => {} });
  assert.equal(code, 0);
  assert.ok(out.join("").includes("\u001b["));
  const plain = await run(["list"], w, { cwd: a.root });
  assert.ok(!plain.out.includes("\u001b["));
});

test("a narrow terminal shortens titles instead of wrapping rows", async () => {
  const x = world("narrow");
  const s = session(x, { id: A, project: "shop", prompt: "a very long first prompt that goes on and on and on and on and on and on" });
  const r = await run(["list"], x, { cwd: s.root, columns: 90 });
  const row = r.out.split("\n").find((l) => l.startsWith("  aaaaaaaa"));
  assert.ok(row.length <= 90, `${row.length}: ${row}`);
  assert.ok(row.endsWith("…"));
});

// --- the other commands, through the command line --------------------------------------------

test("delete and restore through the command line: output, JSON, exit codes", async () => {
  const x = world("dr");
  const s = session(x, { id: A, project: "shop", companions: true, prompt: "Fix the loop" });
  session(x, { id: B, project: "shop" });
  const dry = await run(["delete", "aaaaaaaa", "--dry-run"], x, { cwd: s.root });
  assert.equal(dry.code, 0);
  assert.match(dry.out, /^Would move 1 session to the trash \([\d.]+ KB\):\n {2}aaaaaaaa {2}From the title file +\d+ files, [\d.]+ KB\nNothing was moved \(--dry-run\)\.\n$/);
  const real = await run(["delete", "aaaaaaaa", "bbbbbb", "--json"], x, { cwd: s.root });
  assert.equal(real.code, 0, real.all);
  const j = JSON.parse(real.out);
  assert.equal(j.ok, true);
  assert.equal(j.dryRun, false);
  assert.deepEqual(j.moved.map((m) => m.id), [A, B]);
  assert.equal(j.moved[0].title, "From the title file", "custom-title.json, which Claude Code writes for /rename, beats the first prompt");
  assert.ok(j.moved[0].items.some((i) => i.rel.startsWith("file-history/")));
  assert.equal(j.trash, path.join(x.claude, "session-tidy", "trash"));
  const none = await run(["restore"], x, { cwd: s.root });
  assert.equal(none.code, 1);
  assert.match(none.err, /Which session\? Give the id of one in the trash\.\nIn the trash: 2 sessions/);
  const noneJson = JSON.parse((await run(["restore", "--json"], x)).out);
  assert.equal(noneJson.ok, false);
  assert.equal(noneJson.trash.length, 2);
  const back = await run(["restore", "aaaaaaaa"], x, { cwd: s.root });
  assert.equal(back.code, 0);
  assert.match(back.out, /^Restored aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa "From the title file" \(\d+ items?, [\d.]+ KB\)\nResume it with: claude --resume aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa\n$/);
  assert.ok(fs.existsSync(s.file));
  const twice = await run(["restore", "aaaaaaaa"], x, { cwd: s.root });
  assert.equal(twice.code, 1);
  assert.match(twice.err, /The trash has no session "aaaaaaaa"\. In the trash: bbbbbbbb\./);
  const errJson = JSON.parse((await run(["restore", "zzzzzz", "--json"], x)).out);
  assert.deepEqual(Object.keys(errJson), ["ok", "error"]);
  assert.equal(errJson.ok, false);
  assert.equal((await run(["restore", "bbbbbbbb", "cccccc"], x)).code, 1);
  assert.match((await run(["restore", "bbbbbbbb", "cccccc"], x)).err, /restore takes one session at a time/);
});

test("delete errors: no id, unknown id, ambiguous id, a kept session, all with exit code 1 and nothing moved", async () => {
  const x = world("derr");
  const s = session(x, { id: A, project: "shop" });
  session(x, { id: "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa", project: "shop" });
  const before = snapshot(x.claude);
  for (const [args, why] of [
    [["delete"], /Which session\?/],
    [["delete", "ffffffff"], /No session has the id "ffffffff"/],
    [["delete", "aaaaaaaa"], /is ambiguous: 2 sessions start with it/],
    [["delete", "aaa"], /Short ids need at least 6 characters/],
  ]) {
    const r = await run(args, x, { cwd: s.root });
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.err, why, args.join(" "));
  }
  await run(["keep", A], x, { cwd: s.root });
  const kept = await run(["delete", A], x, { cwd: s.root });
  assert.equal(kept.code, 1);
  assert.match(kept.err, /is on the keep list\. Run: claude-session-tidy unkeep aaaaaaaa/);
  assert.ok(fs.existsSync(s.file));
  assert.ok(Object.keys(before).every((k) => k in snapshot(x.claude) || k.includes("session-tidy")));
});

test("keep and unkeep through the command line", async () => {
  const x = world("ku");
  const s = session(x, { id: A, project: "shop", ageDays: 25, companions: true });
  const dry = await run(["keep", "aaaaaaaa", "--dry-run"], x, { cwd: s.root });
  assert.match(dry.out, /^Would keep 1 session:\n {2}aaaaaaaa\n/);
  assert.ok(!fs.existsSync(keepFile(x.env)));
  const r = await run(["keep", "aaaaaaaa"], x, { cwd: s.root });
  assert.equal(r.code, 0);
  assert.match(r.out, /^Kept 1 session \(\d+ files touched\):\n {2}aaaaaaaa\nThe keep list is .*keep\.json\.\nNothing refreshes them yet, so they are safe for one retention period only\. Run: claude-session-tidy init/);
  assert.equal(mtimeOf(s.file), NOW);
  const again = await run(["keep", "aaaaaaaa", "--json"], x, { cwd: s.root });
  const j = JSON.parse(again.out);
  assert.deepEqual(j.kept.map((k) => [k.id, k.already]), [[A, true]]);
  assert.equal(j.file, keepFile(x.env));
  const un = await run(["unkeep", "aaaaaaaa"], x, { cwd: s.root });
  assert.match(un.out, /^Took 1 session off the keep list: aaaaaaaa\n/);
  const nope = await run(["unkeep", "aaaaaaaa"], x, { cwd: s.root });
  assert.equal(nope.code, 0);
  assert.match(nope.out, /^Not on the keep list: aaaaaaaa\n/);
  const unknown = await run(["unkeep", "ffffffff"], x, { cwd: s.root });
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /No kept session has the id "ffffffff"/);
});

test("empty-trash through the command line asks for --yes", async () => {
  const x = world("et");
  const s = session(x, { id: A, project: "shop", prompt: "Old thing" });
  await run(["delete", "aaaaaaaa"], x, { cwd: s.root });
  const ask = await run(["empty-trash"], x);
  assert.equal(ask.code, 1);
  assert.match(ask.out, /^In the trash: 1 session, .*\n {2}aaaaaaaa {2}Old thing .*moved 2026-10-15\nNothing was deleted\. Run it again with --yes to delete these for good\.\n$/);
  const dry = await run(["empty-trash", "--yes", "--dry-run"], x);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /Nothing was deleted \(--dry-run\)\./);
  const young = await run(["empty-trash", "--older", "30", "--yes"], x);
  assert.equal(young.code, 0);
  assert.equal(young.out, "Nothing in the trash was moved there more than 30 days ago.\n");
  const done = await run(["empty-trash", "--yes", "--json"], x);
  assert.equal(done.code, 0);
  assert.equal(JSON.parse(done.out).deleted, true);
  assert.equal((await run(["empty-trash"], x)).out, "The trash is empty.\n");
});

test("an unexpected failure is reported with exit code 2, not as a user error", async () => {
  const err = [];
  const code = await main(["list"], { cwd: a.root, env: w.env, now: NOW, out: () => { throw new Error("boom"); }, err: (s) => err.push(s) });
  assert.equal(code, 2);
  assert.match(err.join(""), /claude-session-tidy hit an unexpected error: Error: boom/);
});

// --- the real program in a child process -------------------------------------------------------

test("the command runs as a program: CLAUDE_CONFIG_DIR is honoured, and it never looks anywhere else", () => {
  const x = world("proc");
  const s = session(x, { id: A, project: "shop", prompt: "from the throwaway config" });
  const r = runCli(["list", "--json"], { cwd: s.root, env: x.env });
  assert.equal(r.code, 0, r.all);
  assert.equal(r.err, "");
  const j = JSON.parse(r.out);
  assert.equal(j.configDir, x.claude);
  assert.equal(j.sessions[0].title, "from the throwaway config");
  // another config folder, empty: nothing is found
  const y = world("proc2");
  assert.equal(JSON.parse(runCli(["list", "--json", "--all"], { cwd: y.base, env: y.env }).out).total, 0);
  // HOME alone decides when CLAUDE_CONFIG_DIR is not set
  const noVar = { ...x.env, CLAUDE_CONFIG_DIR: "" };
  assert.equal(JSON.parse(runCli(["list", "--json", "--all"], { cwd: x.base, env: noVar }).out).configDir, x.claude);
});

test("the program prints help and the version without touching any file", () => {
  const x = world("proc3");
  const before = snapshot(x.claude);
  assert.match(runCli(["--help"], { cwd: x.base, env: x.env }).out, /claude-session-tidy 1\.0\.0/);
  assert.equal(runCli(["--version"], { cwd: x.base, env: x.env }).out.trim(), pkg.version);
  const bad = runCli(["nope"], { cwd: x.base, env: x.env });
  assert.equal(bad.code, 1);
  assert.deepEqual(snapshot(x.claude), before);
});

test("read-only commands leave the config folder exactly as it was", async () => {
  const before = snapshot(w.claude);
  const mtimes = Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.mtimeMs]));
  for (const args of [["list"], ["list", "--all", "--json"], ["list", "--markdown"], ["delete", A, "--dry-run"], ["tidy", "--all", "--dry-run"], ["refresh", "--dry-run"], ["keep", A, "--dry-run"], ["init", "--dry-run"], ["uninstall", "--dry-run"], ["empty-trash"]]) {
    await run(args, w, { cwd: a.root });
  }
  const after = snapshot(w.claude);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  for (const [k, v] of Object.entries(after)) assert.equal(v.mtimeMs, mtimes[k], k);
  assert.ok(readRetention(w.env).days === 30 && c.file);
});

test("a settings.json that cannot be read does not break list", async () => {
  const x = world("badsettings");
  const s = session(x, { id: A, project: "shop" });
  fs.writeFileSync(path.join(x.claude, "settings.json"), "\u0000\u0001garbage");
  const r = await run(["list"], x, { cwd: s.root });
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /cleanup is paused/);
});

test("150 sessions in 10 projects: --all lists them all, sorted, and --limit keeps the right ones", async () => {
  const x = world("many150");
  const made = [];
  for (let i = 0; i < 150; i++) made.push(session(x, { id: `${String(i).padStart(8, "0")}-2222-4222-8222-bbbbbbbbbbbb`, project: `proj-${i % 10}`, ageDays: 1 + i * 0.5, prompt: `session number ${i}` }));
  const all = JSON.parse((await run(["list", "--all", "--json"], x, { cwd: x.base })).out);
  assert.equal(all.total, 150);
  assert.equal(all.sessions.length, 150);
  const times = all.sessions.map((s) => Date.parse(s.lastActivity));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), "newest first");
  assert.equal(new Set(all.sessions.map((s) => s.short)).size, 150, "every short id is unique");
  const top = JSON.parse((await run(["list", "--all", "--json", "--limit", "5"], x, { cwd: x.base })).out);
  assert.deepEqual(top.sessions.map((s) => s.id), all.sessions.slice(0, 5).map((s) => s.id));
  assert.equal(top.shown, 5);
  assert.equal(top.bytes, null, "no total when not every session was measured");
  const one = JSON.parse((await run(["list", "--json"], x, { cwd: made[3].root })).out);
  assert.equal(one.total, 15, "one project of ten");
});

test("stray files and empty folders in projects/ are ignored", async () => {
  const x = world("stray");
  const s = session(x, { id: A, project: "shop" });
  fs.writeFileSync(path.join(x.claude, "projects", "a-file-not-a-folder"), "x");
  fs.mkdirSync(path.join(x.claude, "projects", "empty-project-folder"));
  fs.writeFileSync(path.join(s.dir, ".DS_Store"), "x");
  const r = await run(["list", "--all", "--json"], x, { cwd: s.root });
  assert.equal(r.code, 0, r.all);
  assert.equal(JSON.parse(r.out).total, 1);
});
