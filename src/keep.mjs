// The keep list: <config>/session-tidy/keep.json, and touching kept sessions so Claude Code's cleanup, which
// goes by a file's modification time, leaves them alone.
//
//   { "version": 1, "kept": { "<session id>": { "since": "<ISO time>", "slug": "<project folder name>" } } }
//
// A kept session is "touched": the modification time of its transcript and of the files the cleanup judges
// one by one (tool results; the todo files of older versions) is set to now. `keep` touches at once;
// `refresh` touches again when half of a session's time is used up, from a hook, a cron job or by hand.
import fs from "node:fs";
import path from "node:path";
import { keepFile, projectsDir, readRetention } from "./config.mjs";
import { sweepOf, isDesktopEntrypoint, needsTouch } from "./sweep.mjs";
import { entrypoints } from "./transcript.mjs";
import { makeStore, readReleaseMarker, safeId } from "./sessions.mjs";
import { UserError, fail, filesUnder, isoOf, listDir, statOf, writeFileAtomic } from "./util.mjs";

// ---------------------------------------------------------------------------------------------
// keep.json
// ---------------------------------------------------------------------------------------------

// status: "missing" | "ok" | "invalid" (not JSON, or not the shape above). A file that is not valid is
// never overwritten.
export function readKeep(env) {
  const file = keepFile(env);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return { status: "missing", kept: {}, file };
    return { status: "invalid", kept: {}, file, reason: `cannot be read (${e && (e.code || e.message)})` };
  }
  let data;
  try { data = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); } catch { return { status: "invalid", kept: {}, file, reason: "is not valid JSON" }; }
  if (!data || typeof data !== "object" || Array.isArray(data) || !data.kept || typeof data.kept !== "object" || Array.isArray(data.kept)) {
    return { status: "invalid", kept: {}, file, reason: 'does not have the shape {"version": 1, "kept": {...}}' };
  }
  const kept = {};
  for (const [id, v] of Object.entries(data.kept)) {
    if (!safeId(id)) continue;
    kept[id] = { since: v && typeof v.since === "string" ? v.since : "", slug: v && typeof v.slug === "string" ? v.slug : "" };
  }
  return { status: "ok", kept, file };
}

function readKeepForWrite(env) {
  const keep = readKeep(env);
  if (keep.status === "invalid") fail(`${keep.file} ${keep.reason}, so I left it alone. Fix it, or move it away, and run the command again.`);
  return keep;
}

const writeKeep = (env, kept) => writeFileAtomic(keepFile(env), `${JSON.stringify({ version: 1, kept }, null, 2)}\n`);

// ---------------------------------------------------------------------------------------------
// Touching
// ---------------------------------------------------------------------------------------------

// The files whose modification time the cleanup looks at, for one copy of a session: the transcript, every
// file in the session's folder (tool results are judged one by one even when the transcript is fresh), the
// markers beside the transcript (except the Desktop app's, which is its own record), and older versions'
// todo files.
export function touchTargets(store, session) {
  const { id } = session;
  const out = [session.file, ...filesUnder(path.join(session.dir, id))];
  for (const name of store.names("projects", session.slug)) {
    if (name.startsWith(`${id}.`) && !name.endsWith(".jsonl") && !name.endsWith(".desktop-released.json")) out.push(path.join(session.dir, name));
  }
  for (const name of store.names("todos")) {
    if (name === `${id}.json` || (name.startsWith(`${id}-agent-`) && name.endsWith(".json"))) out.push(path.join(store.cfg, "todos", name));
  }
  return out.filter((f) => statOf(f));
}

// Sets the modification (and access) time of each file to `now`. Returns how many worked.
export function touchFiles(files, now) {
  const t = new Date(now);
  let touched = 0;
  for (const f of files) {
    try { fs.utimesSync(f, t, t); touched++; } catch { /* read-only or just removed: the rest still count */ }
  }
  return touched;
}

// ---------------------------------------------------------------------------------------------
// keep, unkeep, refresh
// ---------------------------------------------------------------------------------------------

// resolved: what resolveIds returned. Records the sessions in keep.json and touches them now.
// Returns [{ id, already, files }].
export function keepSessions(env, resolved, { now = Date.now(), dryRun = false } = {}) {
  const keep = readKeepForWrite(env);
  const store = makeStore(env);
  const results = [];
  for (const r of resolved) {
    const already = Object.hasOwn(keep.kept, r.id);
    const files = r.copies.flatMap((copy) => touchTargets(store, copy));
    if (!dryRun) touchFiles(files, now);
    keep.kept[r.id] = { since: already && keep.kept[r.id].since ? keep.kept[r.id].since : isoOf(now), slug: r.copies[0].slug };
    results.push({ id: r.id, already, files: files.length });
  }
  if (!dryRun) writeKeep(env, keep.kept);
  return results;
}

// Takes ids off the keep list (ids are matched against the list, so a session whose files are gone can
// still be released). Returns { released: [id], notKept: [ref] }. A ref that is neither kept nor a session
// that exists is an error.
export function unkeepSessions(env, refs, { dryRun = false, exists } = {}) {
  const keep = readKeepForWrite(env);
  if (!refs.length) fail("Which session? Give its id (claude-session-tidy list shows them).");
  const released = [];
  const notKept = [];
  for (const ref of refs) {
    const want = String(ref).toLowerCase();
    const hits = Object.keys(keep.kept).filter((id) => id.toLowerCase() === want || (want.length >= 6 && id.toLowerCase().startsWith(want)));
    if (hits.length > 1) fail(`"${ref}" is ambiguous: ${hits.length} kept sessions start with it. Use more of the id.`);
    if (hits.length === 1) { if (!released.includes(hits[0])) released.push(hits[0]); continue; }
    if (exists && exists(ref)) notKept.push(ref);
    else fail(`No kept session has the id "${ref}". Kept: ${Object.keys(keep.kept).map((id) => id.slice(0, 8)).join(", ") || "none"}.`);
  }
  if (!dryRun && released.length) {
    for (const id of released) delete keep.kept[id];
    writeKeep(env, keep.kept);
  }
  return { released, notKept };
}

// Where a kept session's files are now: the project folder remembered in keep.json first, then any project.
function locate(env, id, slugHint) {
  const base = projectsDir(env);
  const slugs = listDir(base).filter((d) => d.isDirectory()).map((d) => d.name);
  if (slugHint) slugs.sort((a, b) => Number(b === slugHint) - Number(a === slugHint));
  const copies = [];
  for (const slug of slugs) {
    const dir = path.join(base, slug);
    const file = path.join(dir, `${id}.jsonl`);
    const st = statOf(file);
    if (st && st.isFile()) copies.push({ id, slug, dir, file, mtimeMs: st.mtimeMs });
  }
  return copies;
}

// Touches every kept session that needs it (half of its time or more used up) and not those the cleanup
// skips anyway (Claude Desktop sessions). `projectDir` is where Claude Code is being started, for a
// project-level cleanupPeriodDays. Returns { kept, touched: [{ id, files }], skipped: [{ id, reason }],
// missing: [id] }. Throws a UserError when keep.json is invalid.
export function refreshKept(env, { now = Date.now(), dryRun = false, projectDir = "" } = {}) {
  const keep = readKeep(env);
  if (keep.status === "invalid") throw new UserError(`${keep.file} ${keep.reason}`);
  const retention = readRetention(env, { projectDir });
  const store = makeStore(env);
  const report = { kept: Object.keys(keep.kept).length, touched: [], skipped: [], missing: [] };
  for (const [id, info] of Object.entries(keep.kept)) {
    const copies = locate(env, id, info.slug);
    if (!copies.length) { report.missing.push(id); continue; }
    let files = 0;
    let reason = "";
    for (const copy of copies) {
      if (!needsTouch(copy.mtimeMs, retention.days, now)) { reason ||= "recent"; continue; } // the cheap test first: the hook runs at every start
      const ep = entrypoints(copy.file);
      const desktop = isDesktopEntrypoint(ep.first) || isDesktopEntrypoint(ep.last);
      const sweep = sweepOf({ mtimeMs: copy.mtimeMs, desktop, marker: desktop ? readReleaseMarker(copy) : null }, retention, now);
      if (sweep.state === "exempt") { reason ||= "exempt"; continue; }
      const targets = touchTargets(store, copy);
      if (!dryRun) touchFiles(targets, now);
      files += targets.length;
    }
    if (files) report.touched.push({ id, files });
    else report.skipped.push({ id, reason });
  }
  return report;
}
