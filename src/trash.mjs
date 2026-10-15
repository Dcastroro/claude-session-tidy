// The trash: sessions are moved, never deleted, to <config>/session-tidy/trash/<id>/.
//
//   trash/<id>/manifest.json        what was moved and where it came from
//   trash/<id>/files/<path>         every item, at the same path it had inside the config folder
//
// `restore` moves the items back to the paths in the manifest, so `claude --resume <id>` finds the session
// again. Only `empty-trash --yes` deletes anything for good. Everything stays inside the config folder, so a
// move is a rename: instant, atomic per item, and file times are kept.
import fs from "node:fs";
import path from "node:path";
import { claudeDir, trashRoot } from "./config.mjs";
import { readKeep, touchFiles, touchTargets } from "./keep.mjs";
import { COMPANION_ROOTS, allCompanions, makeStore, safeId, sized } from "./sessions.mjs";
import { needsTouch } from "./sweep.mjs";
import { DAY, UserError, exists, fail, isoOf, listDir, measure, plural, statOf, tryParse, writeFileAtomic } from "./util.mjs";
import { VERSION } from "./version.mjs";

// The file operation that moves an item. Tests swap it to make a move fail halfway.
export const ops = { rename: (from, to) => fs.renameSync(from, to) };

function movePath(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    ops.rename(from, to);
  } catch (e) {
    if (!e || e.code !== "EXDEV") throw e;
    // The item lives on another volume (a projects folder that is a link): copy it, then remove the original.
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

// A manifest is a file on disk and could be edited: a path in it is used only when it is a plain relative
// path of forward-slash segments below one of the folders sessions use, and stays inside the config folder.
function safeRel(rel) {
  if (typeof rel !== "string" || !rel || rel.length > 1024 || rel.includes("\\") || rel.startsWith("/")) return false;
  const parts = rel.split("/");
  if (parts.length < 2 || !COMPANION_ROOTS.includes(parts[0])) return false;
  return parts.every((p) => p && p !== "." && p !== ".." && !p.includes(":") && !/[\x00-\x1f]/.test(p));
}
const absOf = (cfg, rel) => path.join(cfg, ...rel.split("/"));

// ---------------------------------------------------------------------------------------------
// What is in the trash
// ---------------------------------------------------------------------------------------------

function readManifest(dir, id) {
  let text = "";
  try { text = fs.readFileSync(path.join(dir, "manifest.json"), "utf8"); } catch { return null; }
  const m = tryParse(text);
  if (!m || typeof m !== "object" || m.id !== id || !Array.isArray(m.items)) return null;
  return m;
}

// Trash entries as { id, dir, manifest (or null when unreadable), trashedAtMs, bytes, title, complete }, newest first.
export function listTrash(env) {
  const root = trashRoot(env);
  const out = [];
  for (const d of listDir(root)) {
    if (!d.isDirectory() || !safeId(d.name)) continue;
    const dir = path.join(root, d.name);
    const manifest = readManifest(dir, d.name);
    const at = manifest ? Date.parse(manifest.trashedAt) : NaN;
    const st = statOf(dir);
    out.push({
      id: d.name,
      dir,
      manifest,
      trashedAtMs: Number.isFinite(at) ? at : st ? st.mtimeMs : 0,
      bytes: manifest && Number.isFinite(manifest.bytes) ? manifest.bytes : measure(dir).bytes,
      title: manifest && typeof manifest.title === "string" ? manifest.title : "",
      complete: !!manifest && manifest.complete !== false,
    });
  }
  return out.sort((a, b) => b.trashedAtMs - a.trashedAtMs || (a.id < b.id ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------------------------

// resolved: what resolveIds returned. describe(r) gives { title, cwd, lastActive } for the manifest.
// Moves each session with everything that belongs to it into the trash; with dryRun only plans it.
// Returns [{ id, title, bytes, files, items: [{ rel, bytes, files }], trash }]. Nothing moves unless every
// session passes the checks (not kept, not already in the trash).
export function deleteSessions(env, resolved, { describe = () => ({}), dryRun = false, now = Date.now() } = {}) {
  const keep = readKeep(env);
  if (keep.status === "invalid") fail(`${keep.file} ${keep.reason}, so I cannot tell which sessions are kept. Fix it, or move it away, first.`);
  const store = makeStore(env);
  const cfg = claudeDir(env);
  const root = trashRoot(env);
  const plans = [];
  for (const r of resolved) {
    if (Object.hasOwn(keep.kept, r.id)) fail(`${r.id} is on the keep list. Run: claude-session-tidy unkeep ${r.id.slice(0, 8)}`);
    if (exists(path.join(root, r.id))) fail(`${r.id} is already in the trash. Restore it (claude-session-tidy restore ${r.id.slice(0, 8)}) or empty the trash first.`);
    const s = sized(allCompanions(store, r.copies));
    const odd = s.items.find((i) => !safeRel(i.rel));
    if (odd) fail(`${r.id} has a file with a name I will not move, because restore could not put it back safely: ${odd.rel}`);
    plans.push({ id: r.id, copies: r.copies, items: s.items, bytes: s.bytes, files: s.files, meta: describe(r) || {}, trash: path.join(root, r.id) });
  }
  const view = (p) => ({ id: p.id, title: p.meta.title || "", bytes: p.bytes, files: p.files, items: p.items.map((i) => ({ rel: i.rel, bytes: i.bytes, files: i.files })), trash: p.trash });
  if (dryRun) return plans.map(view);
  const done = [];
  try {
    for (const p of plans) { moveIn(cfg, p, now); done.push(p); }
  } catch (e) {
    for (const p of done.reverse()) { try { moveBack(cfg, p.trash, p.items.map((i) => i.rel)); fs.rmSync(p.trash, { recursive: true, force: true }); } catch { /* best effort: the trash entry still lists them */ } }
    throw e;
  }
  return plans.map(view);
}

function moveIn(cfg, plan, now) {
  const files = path.join(plan.trash, "files");
  fs.mkdirSync(files, { recursive: true });
  const manifest = {
    version: 1,
    tool: "claude-session-tidy",
    toolVersion: VERSION,
    id: plan.id,
    title: plan.meta.title || "",
    cwd: plan.meta.cwd || "",
    slug: plan.copies[0].slug,
    lastActive: plan.meta.lastActive || "",
    trashedAt: isoOf(now),
    configDir: cfg,
    complete: false,
    bytes: plan.bytes,
    files: plan.files,
    items: plan.items.map((i) => ({ path: i.rel, from: i.abs, kind: i.kind, bytes: i.bytes, files: i.files, mtime: isoOf((statOf(i.abs) || {}).mtimeMs) })),
  };
  writeFileAtomic(path.join(plan.trash, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const moved = [];
  try {
    for (const i of plan.items) { movePath(i.abs, absOf(files, i.rel)); moved.push(i.rel); }
  } catch (e) {
    try { moveBack(cfg, plan.trash, moved); fs.rmSync(plan.trash, { recursive: true, force: true }); } catch { /* the manifest still lists what is where */ }
    throw new UserError(`Could not move a file of ${plan.id} (${e && (e.code || e.message)}). Nothing was changed. If the session is open in Claude Code, close it and try again.`);
  }
  manifest.complete = true;
  writeFileAtomic(path.join(plan.trash, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

// Moves the listed items from the trash entry back to their paths in the config folder, newest move first.
function moveBack(cfg, trashDir, rels) {
  const files = path.join(trashDir, "files");
  for (const rel of [...rels].reverse()) movePath(absOf(files, rel), absOf(cfg, rel));
}

// ---------------------------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------------------------

// Finds the trash entry for an id or an id's first 6 or more characters.
export function findTrashEntry(env, ref) {
  const want = String(ref).toLowerCase();
  const all = listTrash(env);
  const hits = all.filter((e) => e.id.toLowerCase() === want || (want.length >= 6 && e.id.toLowerCase().startsWith(want)));
  if (hits.length === 0) fail(`The trash has no session "${ref}".${all.length ? ` In the trash: ${all.map((e) => e.id.slice(0, 8)).join(", ")}.` : " The trash is empty."}`);
  if (hits.length > 1) fail(`"${ref}" is ambiguous: ${plural(hits.length, "trashed session")} start with it:\n${hits.map((h) => `  ${h.id}`).join("\n")}\nUse more of the id.`);
  return hits[0];
}

// Puts a trashed session back exactly where it was. Fails, moving nothing, when something is already at one
// of the original paths. Then, when the transcript is old enough that the next cleanup would remove it, its
// files are touched (the same rule as `refresh`); otherwise file times stay as they were.
// Returns { id, title, restored: [{ rel, bytes }], missing: [rel], bytes, touched }.
export function restoreSession(env, ref, { dryRun = false, now = Date.now(), days = 30 } = {}) {
  const entry = findTrashEntry(env, ref);
  const cfg = claudeDir(env);
  const manifest = entry.manifest;
  if (!manifest) fail(`The trash entry ${entry.dir} has no readable manifest.json, so I cannot tell where its files belong. They are under ${path.join(entry.dir, "files")}.`);
  const bad = manifest.items.filter((i) => !i || !safeRel(i.path));
  if (bad.length) fail(`The manifest of ${entry.id} lists a path outside the places sessions live in, so I did not restore it: ${JSON.stringify(bad[0] && bad[0].path)}.`);
  const files = path.join(entry.dir, "files");
  const present = manifest.items.filter((i) => statOf(absOf(files, i.path)));
  const missing = manifest.items.filter((i) => !statOf(absOf(files, i.path))).map((i) => i.path);
  if (!present.length) fail(`Nothing is left in the trash entry for ${entry.id}.`);
  const conflicts = present.filter((i) => statOf(absOf(cfg, i.path)));
  if (conflicts.length) {
    fail(`Cannot restore ${entry.id}: ${plural(conflicts.length, "path")} already exist${conflicts.length === 1 ? "s" : ""} in ${cfg}:\n${conflicts.slice(0, 5).map((c) => `  ${c.path}`).join("\n")}${conflicts.length > 5 ? "\n  ..." : ""}\nMove those aside (or delete the new session that took their place) and run restore again.`);
  }
  const restored = present.map((i) => ({ rel: i.path, bytes: Number.isFinite(i.bytes) ? i.bytes : 0 }));
  const result = { id: entry.id, title: entry.title, restored, missing, bytes: restored.reduce((n, r) => n + r.bytes, 0), touched: 0 };
  if (dryRun) return result;
  const moved = [];
  try {
    for (const i of present) { movePath(absOf(files, i.path), absOf(cfg, i.path)); moved.push(i.path); }
  } catch (e) {
    for (const rel of moved.reverse()) { try { movePath(absOf(cfg, rel), absOf(files, rel)); } catch { /* best effort */ } }
    throw new UserError(`Could not move a file back (${e && (e.code || e.message)}). Nothing was changed.`);
  }
  fs.rmSync(entry.dir, { recursive: true, force: true });
  // An old session would be removed by the next cleanup: touch it, as `refresh` does.
  const store = makeStore(env);
  for (const rel of moved) {
    const m = /^projects\/([^/]+)\/([^/]+)\.jsonl$/.exec(rel);
    if (!m) continue;
    const dir = path.join(cfg, "projects", m[1]);
    const file = path.join(dir, `${m[2]}.jsonl`);
    const st = statOf(file);
    if (st && needsTouch(st.mtimeMs, days, now)) result.touched += touchFiles(touchTargets(store, { id: m[2], slug: m[1], dir, file }), now);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// empty-trash
// ---------------------------------------------------------------------------------------------

// Deletes trash entries for good: all of them, or those moved to the trash more than `olderDays` days ago.
// Without `yes` (or with dryRun) it only lists them. Returns { deleted, entries: [{ id, title, bytes, trashedAt }], bytes }.
export function emptyTrash(env, { olderDays = 0, yes = false, dryRun = false, now = Date.now() } = {}) {
  const chosen = listTrash(env).filter((e) => !olderDays || now - e.trashedAtMs > olderDays * DAY);
  const entries = chosen.map((e) => ({ id: e.id, title: e.title, bytes: e.bytes, trashedAt: isoOf(e.trashedAtMs) }));
  const bytes = chosen.reduce((n, e) => n + e.bytes, 0);
  if (!yes || dryRun || !chosen.length) return { deleted: false, entries, bytes };
  for (const e of chosen) fs.rmSync(e.dir, { recursive: true, force: true });
  try { fs.rmdirSync(trashRoot(env)); } catch { /* not empty, or already gone */ }
  return { deleted: true, entries, bytes };
}
