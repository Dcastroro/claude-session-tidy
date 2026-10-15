// Where Claude Code keeps its files, how project folders are named inside them, and which retention
// period Claude Code's cleanup will use.
//
// <config>/projects/<slug>/<id>.jsonl            one session, one JSON object per line
// <config>/settings.json                          user settings (cleanupPeriodDays lives here or in a project's)
// <config>/session-tidy/keep.json, trash/         this tool's own files; nothing else is ever written by it
// <config> is $CLAUDE_CONFIG_DIR, or ~/.claude.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IS_WIN = process.platform === "win32";

export function homeDir(env = process.env) {
  const fromEnv = IS_WIN ? env.USERPROFILE || env.HOME : env.HOME;
  return fromEnv || os.homedir();
}
export function claudeDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(homeDir(env), ".claude");
}
export const projectsDir = (env = process.env) => path.join(claudeDir(env), "projects");
export const tidyDir = (env = process.env) => path.join(claudeDir(env), "session-tidy");
export const trashRoot = (env = process.env) => path.join(tidyDir(env), "trash");
export const keepFile = (env = process.env) => path.join(tidyDir(env), "keep.json");
export const appDir = (env = process.env) => path.join(tidyDir(env), "app");
export const settingsFile = (env = process.env) => path.join(claudeDir(env), "settings.json");

// The folder name Claude Code uses under projects/ for a working directory: every character that is
// not a letter or digit becomes "-", and names over 200 characters are cut and suffixed with a hash
// of the full path (the same rule as Claude Code 2.1.x).
export function projectSlug(p) {
  const s = String(p).replace(/[^a-zA-Z0-9]/g, "-");
  if (s.length <= 200) return s;
  let h = 0;
  for (let i = 0; i < p.length; i++) h = ((h << 5) - h + p.charCodeAt(i)) | 0;
  return `${s.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

// A recorded working directory can be in either spelling, whatever OS reads it back (a config folder
// that was synced or copied from another machine).
const looksWindows = (s) => /^[a-zA-Z]:[\\/]|^\\\\/.test(String(s));

// Is p the folder `root` or somewhere below it? Windows spellings compare without regard to case and
// with either slash.
export function isInside(root, p) {
  if (!root || !p) return false;
  const win = looksWindows(root) || looksWindows(p);
  const api = win ? path.win32 : path.posix;
  let a = api.normalize(root);
  let b = api.normalize(p);
  if (win) { a = a.toLowerCase(); b = b.toLowerCase(); }
  const rel = api.relative(a, b);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel));
}

// ---------------------------------------------------------------------------------------------
// Settings files
// ---------------------------------------------------------------------------------------------

// Reads a settings file without changing it. status: "missing" | "ok" (a JSON object in `data`) |
// "invalid" (not JSON, not an object, or unreadable; `reason` says which).
export function readSettingsFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return { status: "missing", data: {}, raw: null };
    return { status: "invalid", data: null, raw: null, reason: `cannot be read (${e && (e.code || e.message)})` };
  }
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!text.trim()) return { status: "ok", data: {}, raw };
  let data;
  try { data = JSON.parse(text); } catch { return { status: "invalid", data: null, raw, reason: "is not valid JSON" }; }
  if (data && typeof data === "object" && !Array.isArray(data)) return { status: "ok", data, raw };
  return { status: "invalid", data: null, raw, reason: "is valid JSON but not an object" };
}

// ---------------------------------------------------------------------------------------------
// Retention: the period Claude Code's cleanup uses
// ---------------------------------------------------------------------------------------------

const DEFAULT_DAYS = 30;

// Claude Code deletes a session when its file has not been modified for `cleanupPeriodDays` (default
// 30). The setting comes from the user's settings.json, then the project's .claude/settings.json,
// then its settings.local.json; the last one that sets it wins (checked on Claude Code 2.1.295; the
// project files count for the project Claude Code is started in). Claude Code skips the whole cleanup
// when one of these files cannot be parsed or when cleanupPeriodDays is not a whole number of 1 or more.
// Organisation-managed settings are not read.
//
// Returns { days, source: "default" | "user" | "project" | "local", file, paused: null | { file, reason },
// desktopDays, checked: [{ scope, file, status }] }. `days` is the period that applies, or the default
// when the cleanup is paused (for display only).
export function readRetention(env = process.env, { projectDir = "" } = {}) {
  const sources = [{ scope: "user", file: settingsFile(env) }];
  if (projectDir) {
    sources.push({ scope: "project", file: path.join(projectDir, ".claude", "settings.json") });
    sources.push({ scope: "local", file: path.join(projectDir, ".claude", "settings.local.json") });
  }
  const out = { days: DEFAULT_DAYS, source: "default", file: "", paused: null, desktopDays: 0, checked: [] };
  for (const s of sources) {
    const r = readSettingsFile(s.file);
    out.checked.push({ scope: s.scope, file: s.file, status: r.status });
    if (r.status === "missing") continue;
    if (r.status === "invalid") { out.paused ||= { file: s.file, reason: r.reason }; continue; }
    const v = r.data.cleanupPeriodDays;
    if (v !== undefined) {
      if (Number.isInteger(v) && v >= 1) { out.days = v; out.source = s.scope; out.file = s.file; }
      else out.paused ||= { file: s.file, reason: `sets cleanupPeriodDays to ${JSON.stringify(v)}, which is not a whole number of days, 1 or more` };
    }
    // How long Claude Desktop sessions are kept at most (0 = no limit). Read from the user's file only.
    const d = r.data.desktopSessionCleanupPeriodDays;
    if (s.scope === "user" && Number.isInteger(d) && d >= 0) out.desktopDays = d;
  }
  return out;
}

// One line for people: which setting applied.
export function describeRetention(r) {
  if (r.paused) return `Claude Code's cleanup is paused: ${r.paused.file} ${r.paused.reason}. Nothing is swept until that is fixed`;
  if (r.source === "default") return `${r.days} days without a change (cleanupPeriodDays is not set, so Claude Code's default applies)`;
  return `${r.days} days without a change (cleanupPeriodDays ${r.days} in ${r.file})`;
}
