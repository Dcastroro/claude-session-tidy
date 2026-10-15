// init and uninstall: one SessionStart hook in <config>/settings.json that runs `refresh --quiet`.
//
//   <config>/session-tidy/app/    our copy of bin/ and src/ (the hook runs from here, so it keeps working after
//                                 npx forgets its cache)
//   <config>/settings.json        only our own hook entry is added or taken out, as a text edit after a backup
//                                 named settings.json.bak-session-tidy-<time>; nothing else in the file moves,
//                                 so uninstall after init gives back the same bytes
// keep.json, the trash and errors.log are the person's data and stay when uninstalling.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appDir, claudeDir, settingsFile } from "./config.mjs";
import { findMember, insertItem, insertMember, parseDoc, removeItem, removeMember, sameJson } from "./jsonedit.mjs";
import { exists, fileStamp, forwardSlashes, listDir, uniquePath, writeFileAtomic } from "./util.mjs";

const EVENT = "SessionStart";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_MARK = /session-tidy\/app\/bin\/claude-session-tidy\.mjs/;

// The settings.json entry that runs our installed copy. Exec form (no shell), so a path with spaces is safe.
export const hookEntryFor = (env) => ({
  type: "command",
  command: "node",
  args: [forwardSlashes(path.join(appDir(env), "bin", "claude-session-tidy.mjs")), "refresh", "--quiet"],
  timeout: 10,
});
const groupFor = (env) => ({ hooks: [hookEntryFor(env)] });

// True for a hook that runs a copy of this tool made by init: recognised by the script path, either slash style.
export function isOurHook(h) {
  if (!h || typeof h !== "object") return false;
  const text = [h.command, ...(Array.isArray(h.args) ? h.args : [])].filter((x) => typeof x === "string").join(" ").replace(/\\/g, "/");
  return SCRIPT_MARK.test(text);
}

// ---------------------------------------------------------------------------------------------
// Reading settings.json
// ---------------------------------------------------------------------------------------------

// Looks at the file's text without changing anything. status: "missing" | "ok" | "invalid" (not JSON, not an
// object, or a "hooks" / "hooks.SessionStart" of the wrong kind). For "ok": `body` (the text without a
// byte-order mark), `bom`, `data`, `doc`, and `ours`: our entries as { group, hook, entry } indexes into SessionStart.
export function readForEdit(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return { status: "missing", raw: null, ours: [] };
    return { status: "invalid", raw: null, reason: `cannot be read (${e && (e.code || e.message)})`, ours: [] };
  }
  const bom = raw.charCodeAt(0) === 0xfeff ? "﻿" : "";
  const body = bom ? raw.slice(1) : raw;
  if (!body.trim()) return { status: "ok", raw, bom, body: "{}\n", empty: true, data: {}, doc: parseDoc("{}\n"), ours: [] };
  return analyse(raw, bom, body);
}

function analyse(raw, bom, body) {
  const doc = parseDoc(body);
  if (!doc.ok) return { status: "invalid", raw, reason: `is not valid JSON (${doc.reason})`, ours: [] };
  if (doc.root.type !== "object") return { status: "invalid", raw, reason: "is valid JSON but not an object", ours: [] };
  const data = JSON.parse(body);
  const hooks = findMember(doc.root, "hooks");
  if (hooks && hooks.member.value.type !== "object") return { status: "invalid", raw, reason: 'has a "hooks" value that is not an object', ours: [] };
  const ss = hooks && findMember(hooks.member.value, EVENT);
  if (ss && ss.member.value.type !== "array") return { status: "invalid", raw, reason: `has a "hooks.${EVENT}" value that is not an array`, ours: [] };
  const ours = [];
  const groups = (data.hooks && data.hooks[EVENT]) || [];
  groups.forEach((g, gi) => {
    if (!g || typeof g !== "object" || !Array.isArray(g.hooks)) return;
    g.hooks.forEach((h, hi) => { if (isOurHook(h)) ours.push({ group: gi, hook: hi, entry: h }); });
  });
  return { status: "ok", raw, bom, body, data, doc, ours };
}

// The plugins of settings.json that run the same hook, for init's note.
const pluginOf = (data) => Object.entries((data && data.enabledPlugins) || {}).filter(([k, v]) => v && /^session-tidy@/.test(k)).map(([k]) => k)[0] || "";

// What the hooks of settings.json say about us, for `list`: { installed, plugin (the enabled plugin that runs
// the same hook, or ""), invalid }.
export function hookStatus(env) {
  const r = readForEdit(settingsFile(env));
  if (r.status === "invalid") return { installed: false, plugin: "", invalid: true };
  if (r.status === "missing") return { installed: false, plugin: "", invalid: false };
  return { installed: r.ours.length > 0, plugin: pluginOf(r.data), invalid: false };
}

// ---------------------------------------------------------------------------------------------
// Text edits: put our entry in, take it out
// ---------------------------------------------------------------------------------------------

function reparse(text) {
  const doc = parseDoc(text);
  return doc.ok ? analyse(text, "", text) : null;
}

// Takes every entry of ours out of the text, and any container that leaves empty.
function withoutOurs(body) {
  let text = body;
  for (let guard = 0; guard < 100; guard++) {
    const a = reparse(text);
    if (!a || !a.ours.length) break;
    const { group, hook } = a.ours[a.ours.length - 1];
    const hooks = findMember(a.doc.root, "hooks").member.value;
    const ssArr = findMember(hooks, EVENT).member.value;
    const groupHooks = findMember(ssArr.items[group], "hooks").member.value;
    text = groupHooks.items.length === 1 ? removeItem(text, ssArr, group) : removeItem(text, groupHooks, hook);
    const b = reparse(text);
    const h = findMember(b.doc.root, "hooks");
    const s = findMember(h.member.value, EVENT);
    if (!s.member.value.items.length) {
      text = removeMember(text, h.member.value, s.index);
      const c = reparse(text);
      const h2 = findMember(c.doc.root, "hooks");
      if (!h2.member.value.members.length) text = removeMember(text, c.doc.root, h2.index);
    }
  }
  return text;
}

function withGroup(text, group) {
  const a = reparse(text);
  const hooks = findMember(a.doc.root, "hooks");
  if (!hooks) return insertMember(text, a.doc.root, "hooks", { [EVENT]: [group] });
  const ss = findMember(hooks.member.value, EVENT);
  if (!ss) return insertMember(text, hooks.member.value, EVENT, [group]);
  return insertItem(text, ss.member.value, group);
}

// The same two changes made to the parsed data, to check the text edits against.
function dataWithoutOurs(data) {
  const next = structuredClone(data);
  const groups = next.hooks && Array.isArray(next.hooks[EVENT]) ? next.hooks[EVENT] : null;
  if (!groups) return next;
  let removed = false;
  const kept = [];
  for (const g of groups) {
    if (!g || typeof g !== "object" || !Array.isArray(g.hooks)) { kept.push(g); continue; }
    const rest = g.hooks.filter((h) => !isOurHook(h));
    if (rest.length === g.hooks.length) { kept.push(g); continue; }
    removed = true;
    if (rest.length) kept.push({ ...g, hooks: rest });
  }
  if (!removed) return next;
  if (kept.length) next.hooks[EVENT] = kept; else delete next.hooks[EVENT];
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return next;
}
function dataWithGroup(data, group) {
  const next = structuredClone(data);
  if (!next.hooks) next.hooks = {};
  if (!Array.isArray(next.hooks[EVENT])) next.hooks[EVENT] = [];
  next.hooks[EVENT].push(group);
  return next;
}

// What to write for init, from readForEdit's answer: { state: "created" | "added" | "replaced" | "unchanged", text }
// or { problem } when the edit did not come out as expected (the text edit is checked against the same change
// made to the parsed data, and nothing is written if they differ).
export function planInstall(cur, env) {
  const wanted = hookEntryFor(env);
  const current = cur.status === "ok" ? cur.ours : [];
  const base = cur.status === "ok" ? cur.body : "{}\n";
  if (current.length === 1 && sameJson(current[0].entry, wanted)) return { state: "unchanged", text: base };
  const text = withGroup(withoutOurs(base), groupFor(env));
  const expected = dataWithGroup(dataWithoutOurs(cur.status === "ok" ? cur.data : {}), groupFor(env));
  if (!parseDoc(text).ok || !sameJson(JSON.parse(text), expected)) return { problem: "the edit did not give the result expected" };
  return { state: current.length ? "replaced" : cur.status === "missing" ? "created" : "added", text };
}

// What to write for uninstall: { removed: how many entries, text } or { problem }.
export function planRemoval(cur) {
  if (cur.status !== "ok" || !cur.ours.length) return { removed: 0, text: cur.body };
  const text = withoutOurs(cur.body);
  if (!parseDoc(text).ok || !sameJson(JSON.parse(text), dataWithoutOurs(cur.data))) return { problem: "the edit did not give the result expected" };
  return { removed: cur.ours.length, text };
}

// ---------------------------------------------------------------------------------------------
// The installed copy
// ---------------------------------------------------------------------------------------------

function samePath(a, b) {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return path.resolve(a) === path.resolve(b); }
}
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of listDir(from)) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copyDir(src, dst);
    else if (e.isFile()) fs.copyFileSync(src, dst);
  }
}
function prune(from, to) { // whatever is in `to` and no longer in `from` (a file an older version had)
  for (const e of listDir(to)) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (!exists(src)) fs.rmSync(dst, { recursive: true, force: true });
    else if (e.isDirectory()) prune(src, dst);
  }
}
function copyApp(env) {
  const dest = appDir(env);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(dest, "package.json"));
  for (const sub of ["bin", "src"]) { copyDir(path.join(ROOT, sub), path.join(dest, sub)); prune(path.join(ROOT, sub), path.join(dest, sub)); }
}

// Runs the installed copy once, to prove the hook can start. Returns { ok, version, error }.
function checkApp(env) {
  const script = path.join(appDir(env), "bin", "claude-session-tidy.mjs");
  const r = spawnSync(process.execPath, [script, "--version"], { encoding: "utf8", timeout: 10000, windowsHide: true, env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir(env) } });
  const version = (r.stdout || "").trim();
  return r.status === 0 && version ? { ok: true, version } : { ok: false, version: "", error: (r.error && r.error.message) || (r.stderr || "").trim().slice(0, 200) || `exit ${r.status}` };
}

// ---------------------------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------------------------

// Installs the hook. Returns { ok, dryRun, configDir, app: { dir, copied, reason }, settings: { file, state,
// backup, problem }, plugin, check, snippet }. settings.state: "created" | "added" | "replaced" | "unchanged" |
// "invalid". An invalid settings.json is left alone and nothing is copied (ok is false, snippet is what to add by hand).
export function init(env, { dryRun = false, now = Date.now() } = {}) {
  const file = settingsFile(env);
  const cur = readForEdit(file);
  const out = { ok: true, dryRun, configDir: claudeDir(env), app: { dir: appDir(env), copied: false, reason: "" }, settings: { file, state: "unchanged", backup: "", problem: "" }, plugin: "", check: null };
  const refuse = (problem) => {
    out.ok = false;
    out.settings.state = "invalid";
    out.settings.problem = problem;
    out.snippet = { hooks: { [EVENT]: [groupFor(env)] } };
    return out;
  };
  if (cur.status === "invalid") return refuse(`${file} ${cur.reason}, so I left it alone and copied nothing.`);
  const plan = planInstall(cur, env);
  if (plan.problem) return refuse(`I could not edit ${file} safely (${plan.problem}), so I left it alone and copied nothing.`);
  out.plugin = cur.status === "ok" ? pluginOf(cur.data) : "";
  // The copy first: the hook must never point at a script that is not there.
  if (samePath(ROOT, appDir(env))) out.app.reason = "running from the installed copy";
  else if (!dryRun) { copyApp(env); out.app.copied = true; }
  if (plan.state !== "unchanged" && !dryRun) {
    if (cur.status === "ok") {
      out.settings.backup = uniquePath(`${file}.bak-session-tidy-${fileStamp(now)}`);
      fs.copyFileSync(file, out.settings.backup);
    }
    writeFileAtomic(file, (cur.bom || "") + plan.text);
  }
  out.settings.state = plan.state;
  if (!dryRun) out.check = checkApp(env);
  return out;
}

// ---------------------------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------------------------

// Takes our hook out of settings.json and deletes our copy of the program. Returns { ok, dryRun, settings:
// { file, state, backup, removed, problem }, app: { dir, removed }, kept: [paths] }. settings.state:
// "removed" | "unchanged" | "invalid". With an invalid settings.json nothing is changed (the hook must go first,
// or it would point at a deleted script).
export function uninstall(env, { dryRun = false, now = Date.now() } = {}) {
  const file = settingsFile(env);
  const cur = readForEdit(file);
  const out = { ok: true, dryRun, settings: { file, state: "unchanged", backup: "", removed: 0, problem: "" }, app: { dir: appDir(env), removed: false }, kept: [] };
  const refuse = (problem) => { out.ok = false; out.settings.state = "invalid"; out.settings.problem = problem; return out; };
  if (cur.status === "invalid") return refuse(`${file} ${cur.reason}, so I left it alone and removed nothing. Take out the ${EVENT} entry that runs session-tidy/app/bin/claude-session-tidy.mjs by hand, then run uninstall again.`);
  const plan = planRemoval(cur);
  if (plan.problem) return refuse(`I could not edit ${file} safely (${plan.problem}), so I left it alone and removed nothing.`);
  if (plan.removed) {
    if (!dryRun) {
      out.settings.backup = uniquePath(`${file}.bak-session-tidy-${fileStamp(now)}`);
      fs.copyFileSync(file, out.settings.backup);
      writeFileAtomic(file, cur.bom + plan.text);
    }
    out.settings.state = "removed";
    out.settings.removed = plan.removed;
  }
  if (exists(appDir(env))) {
    if (!dryRun) fs.rmSync(appDir(env), { recursive: true, force: true });
    out.app.removed = true;
  }
  const tidy = path.dirname(appDir(env));
  for (const name of ["keep.json", "trash", "errors.log"]) if (exists(path.join(tidy, name))) out.kept.push(path.join(tidy, name));
  return out;
}
