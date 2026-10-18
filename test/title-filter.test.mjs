import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { run, runCli, session, snapshot, world } from "./helpers.mjs";

const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const B = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const C = "cccccccc-1111-4111-8111-cccccccccccc";
const D = "dddddddd-1111-4111-8111-dddddddddddd";

test("list --title matches the selected title literally and case-insensitively", async () => {
  const w = world("title-precedence");
  const a = session(w, { id: A, customTitle: "Rename [Stripe]", aiTitle: "hidden AI title", prompt: "hidden prompt", companions: true });
  fs.rmSync(path.join(a.dir, A, "custom-title.json"));
  session(w, { id: B, aiTitle: "AI STRIPE title", prompt: "another hidden prompt" });
  session(w, { id: C, prompt: "first stripe prompt" });
  session(w, { id: D, prompts: 0 });
  const before = snapshot(w.claude);
  for (const [query, expected] of [["sTrIpE", [A, B, C]], ["[stripe]", [A]], ["hidden", []], ["untitled", [D]]]) {
    const r = await run(["list", "--all", "--title", query, "--json"], w);
    assert.equal(r.code, 0, r.all);
    assert.deepEqual(JSON.parse(r.out).sessions.map((s) => s.id).sort(), expected);
  }
  fs.writeFileSync(path.join(a.dir, A, "custom-title.json"), JSON.stringify({ customTitle: "File title override" }));
  const renamed = JSON.parse((await run(["list", "--all", "--title", "file title", "--json"], w)).out);
  assert.deepEqual(renamed.sessions.map((s) => s.id), [A], "the title file takes precedence over transcript titles");
  fs.rmSync(path.join(a.dir, A, "custom-title.json"));
  assert.deepEqual(snapshot(w.claude), before, "listing never changes files or modification times");
});

test("list --title filters before limits for every sort and combines with project and due", async () => {
  const w = world("title-limit");
  const a = session(w, { id: A, project: "shop", prompt: "unrelated", prompts: 10, ageDays: 1, companions: true });
  session(w, { id: B, project: "shop", prompt: "Stripe migration", prompts: 2, ageDays: 25 });
  session(w, { id: C, project: "shop", prompt: "Stripe draft", prompts: 1, ageDays: 2 });
  session(w, { id: D, project: "other", prompt: "Stripe elsewhere", ageDays: 29 });
  const before = snapshot(w.claude);
  for (const sort of ["age", "size", "prompts"]) {
    const all = JSON.parse((await run(["list", "--sort", sort, "--json"], w, { cwd: a.root })).out);
    const r = await run(["list", "--sort", sort, "--title=STRIPE", "--limit", "1", "--json"], w, { cwd: a.root });
    assert.equal(r.code, 0, r.all);
    const j = JSON.parse(r.out);
    assert.equal(j.total, 3);
    assert.equal(j.matched, 2);
    assert.equal(j.shown, 1);
    assert.equal(j.title, "STRIPE");
    assert.deepEqual(j.sessions, all.sessions.filter((s) => [B, C].includes(s.id)).slice(0, 1));
    const due = JSON.parse((await run(["list", "--project", a.root, "--sort", sort, "--title", "stripe", "--due", "7", "--limit", "1", "--json"], w)).out);
    assert.deepEqual(due.sessions.map((s) => s.id), [B]);
    assert.equal(due.matched, 1);
  }
  const all = JSON.parse((await run(["list", "--all", "--title", "stripe", "--due", "7", "--json"], w)).out);
  assert.deepEqual(all.sessions.map((s) => s.id).sort(), [B, D]);
  assert.deepEqual(snapshot(w.claude), before);
});

test("list --title explains matching and shown counts in text, markdown and JSON", async () => {
  const w = world("title-header");
  const a = session(w, { id: A, prompt: "Stripe setup", ageDays: 25 });
  session(w, { id: B, prompt: "Stripe migration", ageDays: 29 });
  session(w, { id: C, prompt: "unrelated", ageDays: 1 });
  for (const format of [[], ["--markdown"]]) {
    const r = await run(["list", "--title", "stripe", ...format], w, { cwd: a.root });
    assert.equal(r.code, 0, r.all);
    assert.ok(r.out.includes('(2 matching "stripe", of 3, newest first)'));
    const limited = await run(["list", "--title", "stripe", "--limit", "1", ...format], w, { cwd: a.root });
    assert.ok(limited.out.includes('(1 of 2 matching "stripe", of 3, newest first)'));
    const due = await run(["list", "--title", "stripe", "--due", "7", ...format], w, { cwd: a.root });
    assert.ok(due.out.includes('(2 matching "stripe", due within 7 days, of 3, newest first)'));
    const empty = await run(["list", "--title", "missing", ...format], w, { cwd: a.root });
    assert.equal(empty.code, 0);
    assert.ok(empty.out.includes('(0 matching "missing", of 3, newest first)'));
    assert.match(empty.out, /No sessions\./);
    assert.ok(!empty.out.includes("No Claude Code sessions found"));
  }
  const empty = JSON.parse((await run(["list", "--all", "--title", "missing", "--json"], w)).out);
  assert.equal(empty.matched, 0);
  assert.equal(empty.total, 3);
  assert.deepEqual(empty.sessions, []);
});

test("list --title rejects empty text as a usage error without unexpected-error output", async () => {
  const w = world("title-invalid");
  const before = snapshot(w.claude);
  for (const title of ["", " ", "\t\n"]) {
    for (const json of [[], ["--json"]]) {
      const r = await run(["list", `--title=${title}`, ...json], w);
      assert.equal(r.code, 1, r.all);
      assert.match(json.length ? JSON.parse(r.out).error : r.err, /--title needs non-empty text/);
      assert.ok(!r.all.includes("unexpected error"));
    }
  }
  const missing = await run(["list", "--title"], w);
  assert.equal(missing.code, 1, "a missing argument follows the existing parser contract");
  assert.match(missing.err, /--title needs a value/);
  assert.deepEqual(snapshot(w.claude), before);
});

test("list --title keeps its header safe for terminals and markdown", async () => {
  const w = world("title-safe");
  const query = '\u001b[31m**stripe**|<tag>\u0007\nnext';
  for (const format of [[], ["--markdown"]]) {
    const r = await run(["list", "--all", "--title", query, ...format], w);
    assert.equal(r.code, 0, r.all);
    const first = r.out.split("\n")[0];
    assert.ok(!/[\x00-\x1f\x7f]/.test(first));
    assert.ok(first.includes("next"));
    if (format.length) {
      assert.ok(first.includes('\\*\\*stripe\\*\\*\\|\\<tag\\>'));
    }
  }
});

test("list --title works in the real CLI with an isolated config and preserves the markdown cap", async () => {
  const w = world("title-process");
  for (let i = 0; i < 42; i++) session(w, { prompt: `matching session ${i}` });
  const before = snapshot(w.claude);
  const r = runCli(["list", "--all", "--title", "MATCHING", "--markdown"], { cwd: w.base, env: w.env });
  assert.equal(r.code, 0, r.all);
  assert.equal(r.out.split("\n").filter((line) => /^\| [0-9a-f]{8}/.test(line)).length, 40);
  assert.match(r.out, /40 rows shown; the report is capped at 40/);
  const invalid = runCli(["list", "--title=", "--json"], { cwd: w.base, env: w.env });
  assert.equal(invalid.code, 1);
  assert.match(JSON.parse(invalid.out).error, /non-empty text/);
  assert.deepEqual(snapshot(w.claude), before);
});
