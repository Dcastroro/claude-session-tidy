// Checks of the plugin against the real Claude Code, run only when E2E_CLAUDE points at a binary
// (see claude-sandbox.mjs): the manifest is valid, the user-only skill stays out of what the model is
// given, /session-tidy:list hands the model exactly the list command, and the plugin's own SessionStart
// hook keeps a kept session.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DAY, ROOT, Transcript, addCompanions } from "./helpers.mjs";
import { CLAUDE, fakeApi, runClaude, sandbox, skip } from "./claude-sandbox.mjs";

const fwd = (p) => p.replace(/\\/g, "/");

// Every text block of a request's messages.
const textBlocks = (request) => (request.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [m.content])).map((b) => (typeof b === "string" ? b : (b && b.text) || ""));

test("claude plugin validate accepts the plugin, also with --strict", { skip: skip(), timeout: 120000 }, () => {
  const sb = sandbox("validate");
  for (const args of [["plugin", "validate", ROOT], ["plugin", "validate", ROOT, "--strict"]]) {
    const r = spawnSync(CLAUDE, args, { encoding: "utf8", timeout: 100000, env: { ...process.env, CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, USERPROFILE: sb.home }, windowsHide: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Validation passed/);
  }
});

test("the user-only skill is not in what the model is given; /session-tidy:list hands it the list command, filled in", { skip: skip(), timeout: 120000 }, async () => {
  const sb = sandbox("skill");
  const api = await fakeApi();
  try {
    const plain = await runClaude(sb, api, ["-p", "hello", "--plugin-dir", ROOT, "--output-format", "json"]);
    assert.equal(plain.code, 0, plain.err);
    const asked = JSON.stringify(api.requests[0]);
    assert.ok(!asked.includes("session-tidy"), "nothing of the plugin is in the first request");
    assert.ok(!asked.includes("sessions with size and cleanup date"), "not even the skill's description");

    const slash = await runClaude(sb, api, ["-p", "/session-tidy:list", "--plugin-dir", ROOT, "--output-format", "json"]);
    assert.equal(slash.code, 0, slash.err);
    assert.equal(api.requests.length, 2);
    const skill = textBlocks(api.requests[1]).find((t) => t.startsWith("Base directory for this skill"));
    assert.ok(skill, "the skill text is in the request");
    // Claude Code hands the model the `!` line in one of two forms: as an instruction to run it first (the
    // Windows desktop build 2.1.295, whose shell is PowerShell), or already run, its output pasted in its
    // place (2.1.300 on Linux and macOS). Either way the command was built from the right folders.
    if (/run this first/.test(skill)) {
      assert.ok(skill.includes(`"${fwd(ROOT)}/bin/claude-session-tidy.mjs" list --project "${fwd(sb.work)}" --markdown --limit 15`), `the command, with the plugin folder and the project folder filled in:\n${skill}`);
    } else {
      assert.ok(skill.includes(`**Sessions in ${sb.work}`) || skill.includes(`**Sessions in ${fwd(sb.work)}`), `the output of the command, for the project folder:\n${skill}`);
      assert.match(skill, /\| id \| last activity \| prompts \| size \| kept \| sweep \| title \|/);
    }
    assert.match(skill, /Do nothing until the user agrees/);
    assert.ok(!skill.includes("${CLAUDE_"), "no variable is left unexpanded");
    assert.ok(skill.length < 1200, `${skill.length} characters`);
  } finally { await api.close(); }
});

test("the plugin's own hook runs refresh when a session starts, and prints nothing", { skip: skip(), timeout: 240000 }, async () => {
  const sb = sandbox("pluginhook");
  const old = Date.now() - 25 * DAY;
  const id = "77777777-7777-4777-8777-777777777777";
  const t = new Transcript({ id, cwd: sb.work, start: new Date(old - 600000).toISOString() });
  t.prompt("kept session");
  t.say("ok");
  const w = t.write(sb.cfg, { mtime: old });
  const rel = addCompanions(sb.cfg, w.slug, id, { mtime: old });
  assert.equal(sb.tidy(["keep", id]).code, 0);
  for (const f of [w.file, ...rel.map((r) => sb.file(...r.split("/")))]) fs.utimesSync(f, new Date(old), new Date(old));
  const api = await fakeApi();
  try {
    const r = await runClaude(sb, api, ["-p", "say nothing", "--plugin-dir", ROOT, "--output-format", "json"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(Date.now() - fs.statSync(w.file).mtimeMs < 120000, "the hook touched the kept session (25 of its 30 days were used up)");
    assert.ok(Date.now() - fs.statSync(sb.file("projects", w.slug, id, "tool-results", "toolu_01.txt")).mtimeMs < 120000);
    assert.ok(!JSON.stringify(api.requests[0]).includes("refresh"), "nothing of the hook reached the model");
    assert.ok(!fs.existsSync(sb.file("session-tidy", "errors.log")));
  } finally { await api.close(); }
});

test("installed from a marketplace, the plugin's own cost projection is small and its hook costs the model nothing", { skip: skip(), timeout: 240000 }, () => {
  const sb = sandbox("details");
  const mkt = path.join(sb.root, "mkt");
  const dest = path.join(mkt, "plugins", "session-tidy");
  fs.mkdirSync(path.join(mkt, ".claude-plugin"), { recursive: true });
  for (const item of ["bin", "src", "skills", "hooks", ".claude-plugin", "package.json"]) fs.cpSync(path.join(ROOT, item), path.join(dest, item), { recursive: true });
  fs.writeFileSync(path.join(mkt, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "local-test", owner: { name: "test" }, plugins: [{ name: "session-tidy", description: "x", source: "./plugins/session-tidy" }] }));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, USERPROFILE: sb.home, DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1" };
  for (const k of Object.keys(env)) if (/^(CLAUDE_CODE_|ANTHROPIC_)/.test(k)) delete env[k];
  const claude = (...args) => spawnSync(CLAUDE, args, { encoding: "utf8", timeout: 100000, env, windowsHide: true });
  const added = claude("plugin", "marketplace", "add", mkt);
  assert.equal(added.status, 0, added.stdout + added.stderr);
  const installed = claude("plugin", "install", "session-tidy@local-test");
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const details = claude("plugin", "details", "session-tidy");
  assert.equal(details.status, 0, details.stdout + details.stderr);
  assert.match(details.stdout, /Skills \(1\)\s+list/);
  assert.match(details.stdout, /Hooks \(1\)\s+SessionStart\s+\(harness-only/, "the hook has no model context cost");
  const always = /Always-on:\s+~(\d+) tok/.exec(details.stdout);
  assert.ok(always && Number(always[1]) < 30, `always-on is ${always && always[1]} tokens`);
});
