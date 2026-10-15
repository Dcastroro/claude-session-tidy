// Checks against the real Claude Code, run only when E2E_CLAUDE points at a binary (see claude-sandbox.mjs).
// They repeat, on whatever version is installed, the measurements the README's "How it works" rests on:
// which sessions Claude Code's cleanup removes, and that a touched session survives it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DAY, Transcript, addCompanions } from "./helpers.mjs";
import { fakeApi, put, runClaude, sandbox, skip } from "./claude-sandbox.mjs";

const ids = {
  oldCli: "11111111-1111-4111-8111-111111111111",
  freshOldStamps: "22222222-2222-4222-8222-222222222222",
  oldDesktop: "33333333-3333-4333-8333-333333333333",
  desktopDeleted: "44444444-4444-4444-8444-444444444444",
  desktopArchived: "55555555-5555-4555-8555-555555555555",
  oldSdk: "66666666-6666-4666-8666-666666666666",
  kept: "77777777-7777-4777-8777-777777777777",
  twin: "88888888-8888-4888-8888-888888888888",
};

// Writes a session with the records, file time and companion files given.
function seed(sb, id, { entrypoint = "cli", mtime, stamp = Date.now(), companions = true, marker } = {}) {
  const t = new Transcript({ id, cwd: sb.work, entrypoint, start: new Date(stamp - 600000).toISOString() });
  t.prompt(`hello from ${id.slice(0, 8)}`);
  t.say("hi");
  const w = t.write(sb.cfg, { mtime });
  const rel = companions ? addCompanions(sb.cfg, w.slug, id, { mtime }) : [];
  if (marker) put(path.join(w.dir, `${id}.desktop-released.json`), JSON.stringify({ reason: marker }), mtime);
  return { ...w, rel };
}
const has = (sb, ...p) => fs.existsSync(sb.file(...p));

test("the cleanup removes sessions by the file's time, takes the session's folder along, skips Claude Desktop sessions, and everything list predicted came true", { skip: skip(), timeout: 240000 }, async () => {
  const sb = sandbox("retention");
  const now = Date.now();
  const old = now - 5 * DAY;
  const fresh = now - 60000;
  fs.writeFileSync(sb.file("settings.json"), JSON.stringify({ cleanupPeriodDays: 1 }));

  const s = {
    oldCli: seed(sb, ids.oldCli, { mtime: old }),
    freshOldStamps: seed(sb, ids.freshOldStamps, { mtime: fresh, stamp: old }),
    oldDesktop: seed(sb, ids.oldDesktop, { mtime: old, entrypoint: "claude-desktop" }),
    desktopDeleted: seed(sb, ids.desktopDeleted, { mtime: old, entrypoint: "claude-desktop", marker: "delete" }),
    desktopArchived: seed(sb, ids.desktopArchived, { mtime: old, entrypoint: "claude-desktop", marker: "archive" }),
    oldSdk: seed(sb, ids.oldSdk, { mtime: old, entrypoint: "sdk-cli" }),
    kept: seed(sb, ids.kept, { mtime: old }),
    twin: seed(sb, ids.twin, { mtime: old }),
  };
  // Something of ours that must survive: an old file in the trash and the keep list.
  put(sb.file("session-tidy", "trash", "x", "files", "note.txt"), "old trash", old);

  // keep the one session, then let five days pass (put its files back to their old times) and run refresh, as the hook would
  assert.equal(sb.tidy(["keep", ids.kept]).code, 0);
  for (const f of [s.kept.file, ...s.kept.rel.map((r) => sb.file(...r.split("/")))]) fs.utimesSync(f, new Date(old), new Date(old));
  const refreshed = sb.tidy(["refresh", "--json"]);
  assert.equal(refreshed.code, 0, refreshed.all);
  assert.deepEqual(JSON.parse(refreshed.out).touched.map((t) => t.id), [ids.kept]);

  // what list says will happen
  const listed = JSON.parse(sb.tidy(["list", "--all", "--json"]).out);
  const predicted = Object.fromEntries(listed.sessions.map((x) => [x.id, x.sweep.state]));
  assert.deepEqual(predicted, {
    [ids.oldCli]: "due", [ids.freshOldStamps]: "scheduled", [ids.oldDesktop]: "exempt", [ids.desktopDeleted]: "due",
    [ids.desktopArchived]: "due", [ids.oldSdk]: "due", [ids.kept]: "scheduled", [ids.twin]: "due",
  });

  // run the real Claude Code, long enough for the cleanup (about 5 seconds after it starts) to finish
  const api = await fakeApi({ delayMs: 40000 });
  const marker = sb.file(".last-cleanup");
  const run = await runClaude(sb, api, ["-p", "say nothing", "--max-turns", "1"], { untilFile: marker, timeout: 150000 });
  await api.close();
  assert.ok(fs.existsSync(marker), `the cleanup did not run within the time allowed (exit ${run.code}) ${run.err.slice(0, 300)}`);

  // 1. the file's time decides, not the records inside it
  assert.ok(!has(sb, "projects", sb.slug, `${ids.oldCli}.jsonl`), "old file, fresh records: removed");
  assert.ok(has(sb, "projects", sb.slug, `${ids.freshOldStamps}.jsonl`), "fresh file, old records: kept");
  // 2. a removed session takes its folder along, even when the files in it are new
  assert.ok(!has(sb, "projects", sb.slug, ids.oldCli), "the session folder went with it");
  assert.ok(!has(sb, "projects", sb.slug, ids.twin), "also the twin's");
  // 3. Claude Desktop sessions are skipped, unless the app released them
  assert.ok(has(sb, "projects", sb.slug, `${ids.oldDesktop}.jsonl`), "a Claude Desktop session is skipped");
  assert.ok(!has(sb, "projects", sb.slug, `${ids.desktopDeleted}.jsonl`), "deleted in the Desktop app: released");
  assert.ok(!has(sb, "projects", sb.slug, `${ids.desktopArchived}.jsonl`), "archived long ago in the Desktop app: released");
  assert.ok(!has(sb, "projects", sb.slug, `${ids.oldSdk}.jsonl`), "only the three desktop entrypoints are skipped");
  // 4. tool results are judged one by one, even for a session that stays
  assert.ok(!has(sb, "projects", sb.slug, ids.oldDesktop, "tool-results", "toolu_01.txt"), "an old tool result of a surviving session is removed");
  assert.ok(has(sb, "projects", sb.slug, ids.oldDesktop, "subagents", "agent-a1b2c3.jsonl"), "its subagent files are not");
  assert.ok(has(sb, "projects", sb.slug, ids.oldDesktop, "custom-title.json"));
  // 5. a touched session survives whole: transcript, tool results, subagents, title
  assert.ok(has(sb, "projects", sb.slug, `${ids.kept}.jsonl`), "the kept session survived");
  for (const r of s.kept.rel.filter((x) => x.startsWith("projects/") || x.startsWith("todos/"))) assert.ok(has(sb, ...r.split("/")), `${r} of the kept session survived`);
  assert.ok(!has(sb, "projects", sb.slug, `${ids.twin}.jsonl`), "its twin, not kept, did not");
  // 6. what the cleanup leaves behind when it removes a session (nothing in these folders is judged by age)
  for (const id of [ids.oldCli, ids.twin]) {
    assert.ok(has(sb, "file-history", id, "0fb339eae9426361@v1"), "file history stays");
    assert.ok(has(sb, "session-env", id, "env.sh"), "session-env stays");
    assert.ok(has(sb, "uploads", id, "shot.png"), "uploads stay");
    assert.ok(has(sb, "tasks", id, "1.json"), "tasks stay");
    assert.ok(!has(sb, "todos", `${id}-agent-${id}.json`), "old todo files go on their own time");
    assert.ok(!has(sb, "debug", `${id}.txt`), "so do debug logs");
  }
  // 7. our own folder is not touched by it
  assert.ok(has(sb, "session-tidy", "trash", "x", "files", "note.txt"), "the trash survives the cleanup");
  assert.ok(has(sb, "session-tidy", "keep.json"));
});

test("the SessionStart hook that init installs runs refresh before the cleanup, prints nothing, and saves the kept session", { skip: skip(), timeout: 240000 }, async () => {
  const sb = sandbox("hook");
  const now = Date.now();
  const old = now - 5 * DAY;
  fs.writeFileSync(sb.file("settings.json"), JSON.stringify({ cleanupPeriodDays: 1, model: "opus" }, null, 2));
  const kept = seed(sb, ids.kept, { mtime: old });
  const twin = seed(sb, ids.twin, { mtime: old });
  assert.equal(sb.tidy(["keep", ids.kept]).code, 0);
  for (const f of [kept.file, ...kept.rel.map((r) => sb.file(...r.split("/")))]) fs.utimesSync(f, new Date(old), new Date(old));
  const init = sb.tidy(["init"]);
  assert.equal(init.code, 0, init.all);

  const api = await fakeApi({ delayMs: 40000 });
  const marker = sb.file(".last-cleanup");
  const run = await runClaude(sb, api, ["-p", "say nothing", "--max-turns", "1"], { untilFile: marker, timeout: 150000 });
  assert.ok(fs.existsSync(marker), `the cleanup did not run (exit ${run.code}) ${run.err.slice(0, 300)}`);
  const body = JSON.stringify(api.requests[0] || {});
  await api.close();

  assert.ok(has(sb, "projects", sb.slug, `${ids.kept}.jsonl`), "the hook touched the kept session before the cleanup came");
  assert.ok(has(sb, "projects", sb.slug, ids.kept, "tool-results", "toolu_01.txt"), "and its tool results");
  assert.ok(!has(sb, "projects", sb.slug, `${ids.twin}.jsonl`), "the session that was not kept was removed");
  assert.ok(Date.now() - fs.statSync(kept.file).mtimeMs < 120000, "its file time is new");
  assert.ok(!body.includes("session-tidy") && !body.includes("refresh --quiet"), "nothing of the hook reached the model");
  assert.ok(!fs.existsSync(sb.file("session-tidy", "errors.log")), "and it logged no error");
  assert.ok(twin.file);
});
