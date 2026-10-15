// Finding sessions, and finding everything that belongs to one.
//
// A session is <config>/projects/<slug>/<id>.jsonl. What else Claude Code 2.1.x keeps for it, named by the
// same id (names seen in a real config folder, and the headless files re-created with the real binary):
//   projects/<slug>/<id>/                 subagents/, tool-results/, custom-title.json, workflows/
//   projects/<slug>/<id>.<something>      desktop-released.json (the Desktop app's archive marker), ccr-tip.json ...
//   file-history/<id>/                    the file snapshots behind /rewind
//   session-env/<id>/                     environment files of the session's shell
//   uploads/<id>/                         images and files the person attached
//   tasks/<id>/                           the task list
//   todos/<id>-*.json                     older versions kept the todo list here
//   debug/<id>.txt                        the --debug log
//   usage-data/facets/<id>.json, usage-data/session-meta/<id>.json    what /insights worked out about it
// Not session files, so never touched: plans/, paste-cache/, shell-snapshots/, history.jsonl, sessions/ (the
// list of running processes), and the project's memory/ folder.
import fs from "node:fs";
import path from "node:path";
import { claudeDir, isInside, projectSlug, projectsDir } from "./config.mjs";
import { cmp, listDir, measure, statOf, baseName, tryParse, readHeadText, fail, plural } from "./util.mjs";
import { quickMeta } from "./transcript.mjs";

// The top-level folders of the config folder that hold session-named files. Trash and restore only ever
// move paths that start with one of these, whatever a manifest claims.
export const COMPANION_ROOTS = ["projects", "file-history", "session-env", "uploads", "tasks", "todos", "debug", "usage-data"];

// A session id that is safe to use in a path. Claude Code's ids are UUIDs; letters, digits, "-" and "_" are
// accepted, so no id can contain a separator or a dot, and one id can never be taken for part of another's file name.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const safeId = (id) => SAFE_ID.test(id);

// ---------------------------------------------------------------------------------------------
// Finding sessions
// ---------------------------------------------------------------------------------------------

// A folder path without its trailing separator (but a drive or filesystem root keeps it).
const trimSlash = (p) => (p.length > 1 && !/^[A-Za-z]:[\\/]?$/.test(p) ? p.replace(/[\\/]+$/, "") || p : p);

// All session files as { id, slug, dir, file, mtimeMs, bytes, cwd, branch, started, entrypoint }.
// With `all`, every project; otherwise the sessions whose working directory is `root` or inside it (the
// folder name is a quick filter, the recorded cwd the final word). Never reads more than the first
// records of a file, and with `all` and `meta: false` reads none: cwd, branch, started and entrypoint are then
// undefined until withMeta (overview.mjs) fills them, which is all that finding a session by its id needs.
export function findSessions(env, { all = false, root: given = "", meta: wantMeta = true } = {}) {
  const base = projectsDir(env);
  const root = trimSlash(given);
  const rootSlug = root ? projectSlug(root).toLowerCase() : "";
  const out = [];
  for (const d of listDir(base)) {
    if (!d.isDirectory()) continue;
    const name = d.name.toLowerCase();
    if (!all && name !== rootSlug && !name.startsWith(`${rootSlug}-`)) continue;
    const dir = path.join(base, d.name);
    for (const f of listDir(dir)) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const id = f.name.slice(0, -6);
      // agent-<id>.jsonl beside the sessions is a subagent's transcript from older Claude Code versions.
      if (id.startsWith("agent-") || !safeId(id)) continue;
      const file = path.join(dir, f.name);
      const st = statOf(file);
      if (!st || !st.isFile()) continue;
      const meta = all && !wantMeta ? {} : quickMeta(file);
      if (!all) {
        const inside = meta.cwd ? isInside(root, meta.cwd) : name === rootSlug;
        if (!inside) continue;
      }
      out.push({ id, slug: d.name, dir, file, mtimeMs: st.mtimeMs, bytes: st.size, cwd: meta.cwd, branch: meta.branch, started: meta.started, entrypoint: meta.entrypoint });
    }
  }
  return out;
}

// Turns what the person typed into sessions: [{ id, copies: [session, ...] }], one entry per distinct id.
// The same id can sit in two project folders (a folder that was moved, a session resumed from elsewhere);
// those are one session, and all copies are returned. Throws for an id that matches nothing, or for a
// short id that matches more than one session.
export function resolveIds(env, refs, { label = "session" } = {}) {
  if (!refs.length) fail(`Which ${label}? Give its id (claude-session-tidy list shows them).`);
  const universe = findSessions(env, { all: true, meta: false });
  const out = new Map();
  for (const ref of refs) {
    const want = String(ref).toLowerCase();
    const hits = universe.filter((s) => { const id = s.id.toLowerCase(); return id === want || (want.length >= 6 && id.startsWith(want)); });
    const ids = [...new Set(hits.map((h) => h.id))];
    if (ids.length === 0) {
      fail(want.length < 6 && !universe.some((s) => s.id.toLowerCase() === want)
        ? `No ${label} has the id "${ref}". Short ids need at least 6 characters.`
        : `No ${label} has the id "${ref}" (claude-session-tidy list shows the ids; --all covers every project).`);
    }
    if (ids.length > 1) {
      const shown = ids.slice(0, 6).map((id) => `  ${id}`).join("\n");
      fail(`"${ref}" is ambiguous: ${plural(ids.length, "session")} start with it:\n${shown}${ids.length > 6 ? "\n  ..." : ""}\nUse more of the id.`);
    }
    const id = ids[0];
    if (!out.has(id)) out.set(id, { id, copies: [] });
    for (const h of hits) if (!out.get(id).copies.some((c) => c.file === h.file)) out.get(id).copies.push(h);
  }
  return [...out.values()];
}

// The shortest prefix of at least 8 characters that tells every session of the list apart.
export function shortIds(ids) {
  const sorted = [...new Set(ids)].sort(cmp);
  const lengthFor = (id, i) => {
    let n = Math.min(8, id.length);
    for (const other of [sorted[i - 1], sorted[i + 1]]) {
      if (!other) continue;
      let k = 0;
      while (k < id.length && k < other.length && id[k] === other[k]) k++;
      n = Math.max(n, Math.min(id.length, k + 1));
    }
    return n;
  };
  const map = new Map();
  sorted.forEach((id, i) => map.set(id, id.slice(0, lengthFor(id, i))));
  return map;
}

// ---------------------------------------------------------------------------------------------
// What belongs to a session
// ---------------------------------------------------------------------------------------------

// Folder listings are read once per command, however many sessions ask.
export function makeStore(env) {
  const cfg = claudeDir(env);
  const cache = new Map();
  const names = (...parts) => {
    const key = parts.join("/");
    if (!cache.has(key)) cache.set(key, listDir(path.join(cfg, ...parts)).map((e) => e.name));
    return cache.get(key);
  };
  return { cfg, env, names };
}

// The paths of everything that belongs to the session, as { rel (from the config folder, with forward
// slashes), abs, kind: "file" | "dir" }. The transcript comes first. Missing things are left out.
export function companionsOf(store, session) {
  const { cfg, names } = store;
  const { id } = session;
  const out = [];
  const add = (rel) => {
    const abs = path.join(cfg, ...rel.split("/"));
    const st = statOf(abs);
    if (st) out.push({ rel, abs, kind: st.isDirectory() ? "dir" : "file" });
  };
  const project = `projects/${session.slug}`;
  add(`${project}/${id}.jsonl`);
  add(`${project}/${id}`);
  for (const name of names("projects", session.slug)) {
    if (name.startsWith(`${id}.`) && !name.endsWith(".jsonl")) add(`${project}/${name}`);
  }
  for (const dir of ["file-history", "session-env", "uploads", "tasks"]) add(`${dir}/${id}`);
  for (const name of names("todos")) if (name === `${id}.json` || (name.startsWith(`${id}-agent-`) && name.endsWith(".json"))) add(`todos/${name}`);
  add(`debug/${id}.txt`);
  add(`usage-data/facets/${id}.json`);
  add(`usage-data/session-meta/${id}.json`);
  return out;
}

// Companions of every copy of a session (the same id in two project folders), without repeats.
export function allCompanions(store, copies) {
  const seen = new Set();
  const out = [];
  for (const copy of copies) {
    for (const c of companionsOf(store, copy)) if (!seen.has(c.rel)) { seen.add(c.rel); out.push(c); }
  }
  return out;
}

// Adds sizes: each companion gets { bytes, files }, and the list's totals are returned.
export function sized(list) {
  let bytes = 0;
  let files = 0;
  const items = list.map((c) => {
    const m = measure(c.abs);
    bytes += m.bytes;
    files += m.files;
    return { ...c, bytes: m.bytes, files: m.files };
  });
  return { items, bytes, files };
}

// What Claude Code's desktop app writes beside a transcript when a session is archived or deleted there:
// { reason: "archive" | "delete" | "", mtimeMs } or null when there is no marker. (At most 4096 bytes are read.)
export function readReleaseMarker(session) {
  const file = path.join(session.dir, `${session.id}.desktop-released.json`);
  const st = statOf(file);
  if (!st || !st.isFile()) return null;
  const rec = tryParse(readHeadText(file, 4096));
  return { reason: rec && typeof rec.reason === "string" ? rec.reason : "", mtimeMs: st.mtimeMs };
}

// The project folder a session ran in, for display: the last part of its working directory.
export const projectName = (session) => baseName(session.cwd) || session.slug;

// Does the working directory still exist? Returns true, false, or null when this machine cannot tell:
// the path is in another system's spelling (a Windows path read on Linux), or it is on a drive or mount
// that is not there right now (an unplugged disk is not a deleted project).
export function projectFolderExists(cwd, platform = process.platform) {
  if (!cwd) return null;
  const win = platform === "win32";
  if (win ? !/^[a-zA-Z]:[\\/]|^\\\\/.test(cwd) : !cwd.startsWith("/")) return null;
  const api = win ? path.win32 : path.posix;
  const root = api.parse(cwd).root;
  if (!root || !fs.existsSync(root)) return null;
  if (win && root.startsWith("\\\\")) return null; // a network share: slow, and it may simply be offline
  return fs.existsSync(cwd);
}
