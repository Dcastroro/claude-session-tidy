// Checks against the real Claude Code, run only when E2E_CLAUDE points at a binary (see claude-sandbox.mjs):
// a session that was deleted and restored can be resumed, and carries its whole history.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fakeApi, messagesOf, runClaude, sandbox, skip, textReply } from "./claude-sandbox.mjs";
import { Transcript, snapshot } from "./helpers.mjs";

const ID = "5e5510a7-0000-4000-8000-000000000001";

test("delete takes a session out of --resume, restore brings it back with its history", { skip: skip(), timeout: 240000 }, async () => {
  const sb = sandbox("resume");
  const api = await fakeApi({ reply: (j, n) => textReply(j, n, n === 1 ? "ANSWER-ONE" : "ANSWER-TWO") });

  // 1. a real session, written by the real binary
  const first = await runClaude(sb, api, ["-p", "PROMPT-ONE remember the word kumquat", "--session-id", ID, "--output-format", "json"]);
  assert.equal(first.code, 0, first.err);
  assert.equal(JSON.parse(first.out).session_id, ID);
  const transcript = path.join(sb.proj, `${ID}.jsonl`);
  assert.ok(fs.existsSync(transcript));
  const requestsBefore = api.requests.length;

  // list sees it, with the title and prompt count read from the real file
  const listed = JSON.parse(sb.tidy(["list", "--json"]).out);
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].id, ID);
  assert.equal(listed.sessions[0].prompts, 1);
  assert.match(listed.sessions[0].title, /^PROMPT-ONE remember the word kumquat/);
  assert.equal(listed.sessions[0].sweep.state, "scheduled");

  // 2. delete: the files move to the trash, and --resume no longer finds the session
  const before = snapshot(sb.cfg);
  const del = sb.tidy(["delete", ID.slice(0, 8)]);
  assert.equal(del.code, 0, del.all);
  assert.ok(!fs.existsSync(transcript));
  const gone = await runClaude(sb, api, ["-p", "PROMPT-TWO what was the word?", "--resume", ID, "--output-format", "json"]);
  assert.notEqual(gone.code, 0, "resuming a deleted session fails");
  assert.match(gone.out + gone.err, /No conversation found|not found/i);
  assert.equal(api.requests.length, requestsBefore, "and asked the model nothing");

  // 3. restore: every file is back byte for byte ...
  const restored = sb.tidy(["restore", ID.slice(0, 8)]);
  assert.equal(restored.code, 0, restored.all);
  const after = snapshot(sb.cfg);
  for (const [rel, f] of Object.entries(before)) {
    if (rel.startsWith("session-tidy/") || rel === ".claude.json" || rel.startsWith("backups/")) continue;
    assert.equal(after[rel]?.text, f.text, `${rel} is back`);
  }

  // 4. ... and --resume carries the whole history to the model
  const again = await runClaude(sb, api, ["-p", "PROMPT-TWO what was the word?", "--resume", ID, "--output-format", "json"]);
  assert.equal(again.code, 0, again.err);
  assert.equal(JSON.parse(again.out).session_id, ID, "the same session continues");
  assert.equal(api.requests.length, requestsBefore + 1);
  const sent = messagesOf(api.requests[requestsBefore]);
  assert.ok(sent.includes("PROMPT-ONE remember the word kumquat"), "the first prompt was sent");
  assert.ok(sent.includes("ANSWER-ONE"), "and the first answer");
  assert.ok(sent.includes("PROMPT-TWO what was the word?"), "before the new prompt");
  await api.close();
});

test("a restored session that was old enough to be swept is touched, so resuming it and the next cleanup are safe", { skip: skip(), timeout: 240000 }, async () => {
  const sb = sandbox("resume-old");
  const api = await fakeApi();
  const first = await runClaude(sb, api, ["-p", "PROMPT-ONE hello", "--session-id", ID, "--output-format", "json"]);
  assert.equal(first.code, 0, first.err);
  const transcript = path.join(sb.proj, `${ID}.jsonl`);
  assert.equal(sb.tidy(["delete", ID]).code, 0);
  // twenty days in the trash would not matter: the file's own time is what the cleanup reads
  const trashed = path.join(sb.cfg, "session-tidy", "trash", ID, "files", "projects", sb.slug, `${ID}.jsonl`);
  const old = new Date(Date.now() - 20 * 86400000);
  fs.utimesSync(trashed, old, old);
  const restored = sb.tidy(["restore", ID, "--json"]);
  assert.equal(restored.code, 0, restored.all);
  assert.ok(JSON.parse(restored.out).touched >= 1);
  assert.ok(Date.now() - fs.statSync(transcript).mtimeMs < 120000, "touched to now");
  const again = await runClaude(sb, api, ["-p", "PROMPT-TWO", "--resume", ID, "--output-format", "json"]);
  assert.equal(again.code, 0, again.err);
  await api.close();
});

test("claude --continue picks the session with the newest file time, not the newest records: why refresh touches a session only when it must", { skip: skip(), timeout: 240000 }, async () => {
  const sb = sandbox("continue");
  const now = Date.now();
  const DAYS = 86400000;
  const make = (id, marker, stampMs, mtimeMs) => {
    const t = new Transcript({ id, cwd: sb.work, start: new Date(stampMs).toISOString(), stepMs: 1000 });
    t.prompt(marker);
    t.say(`ANSWER-FOR-${marker}`);
    return t.write(sb.cfg, { mtime: mtimeMs });
  };
  make("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", "MARKER-A-newest-records-oldest-file", now - 3600000, now - 3 * DAYS);
  make("bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb", "MARKER-B-oldest-records-newest-file", now - 2 * DAYS, now - 60000);
  const api = await fakeApi();
  try {
    const r = await runClaude(sb, api, ["-p", "next question", "--continue", "--output-format", "json"]);
    assert.equal(r.code, 0, r.err);
    const sent = messagesOf(api.requests[0]);
    assert.ok(sent.includes("MARKER-B"), "the session whose file was touched last was continued");
    assert.ok(!sent.includes("MARKER-A"));
  } finally { await api.close(); }
});
