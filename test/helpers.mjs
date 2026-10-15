// Shared test helpers: throwaway worlds (a Claude config folder, a home folder, project folders), sessions with
// their companion files, and ways to run the CLI.
//
// SAFETY: nothing here reads or writes the real Claude folder. Importing this file points HOME, USERPROFILE and
// CLAUDE_CONFIG_DIR of the test process at an empty temporary folder, so even a test that forgets to pass its own
// environment cannot reach ~/.claude. Every child process gets a world's environment, and runCli refuses to run
// with a config folder outside the OS temp folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Transcript, addBystanders, addCompanions, snapshot, uuid } from "./synthetic.mjs";
import { main } from "../src/cli.mjs";
import { projectSlug } from "../src/config.mjs";

export { Transcript, addBystanders, addCompanions, snapshot, uuid, projectSlug };
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = path.join(ROOT, "bin", "claude-session-tidy.mjs");
export const DAY = 86400000;
// The moment the in-process tests pretend it is, so ages and sweep days do not depend on the clock.
export const NOW = Date.parse("2026-10-15T12:00:00.000Z");

const made = [];
export function tmpDir(prefix = "cst-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}
process.on("exit", () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

// The guard: an empty home and config folder for this process.
const guard = tmpDir("cst-guard-");
process.env.HOME = guard;
process.env.USERPROFILE = guard;
process.env.CLAUDE_CONFIG_DIR = path.join(guard, ".claude");
for (const k of Object.keys(process.env)) if (/^(CLAUDE_CODE_|ANTHROPIC_)/.test(k)) delete process.env[k];

const underTmp = (p) => path.resolve(p).toLowerCase().startsWith(fs.realpathSync(os.tmpdir()).toLowerCase());
const configDirOf = (e) => e.CLAUDE_CONFIG_DIR || path.join((process.platform === "win32" ? e.USERPROFILE || e.HOME : e.HOME) || "", ".claude");

// A throwaway world: base/home/.claude is the config folder, base/work/<name> are project folders.
export function world(name = "w") {
  const base = tmpDir(`cst-${name}-`);
  const home = path.join(base, "home");
  const claude = path.join(home, ".claude");
  fs.mkdirSync(claude, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claude, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  return {
    base, home, claude, env,
    project(n) { const d = path.join(base, "work", n); fs.mkdirSync(d, { recursive: true }); return d; },
    settings(obj) { fs.writeFileSync(path.join(claude, "settings.json"), typeof obj === "string" ? obj : `${JSON.stringify(obj, null, 2)}\n`); },
  };
}

// Runs the real CLI in a child process.
export function runCli(args, { cwd, env, input } = {}) {
  const e = { ...process.env, ...env };
  if (!underTmp(configDirOf(e)) || !underTmp(e.HOME || "") || !underTmp(e.USERPROFILE || "")) {
    throw new Error("runCli needs an environment from world(): the Claude config and home folders must be temporary");
  }
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: e, input, encoding: "utf8", windowsHide: true, timeout: 120000 });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "", all: `${r.stdout || ""}${r.stderr || ""}` };
}

// Runs main() in this process and captures what it prints.
export async function run(args, w, { cwd, columns = 120, env = {}, now = NOW } = {}) {
  const out = [];
  const err = [];
  const code = await main(args, { cwd: cwd || w.base, env: { ...w.env, ...env }, tty: false, columns, now, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join(""), err: err.join(""), all: out.join("") + err.join("") };
}

// Writes a session into a world and returns { id, file, dir, slug, root, rel (companions) }.
//   project  the project folder's name under work/ (created, so it exists on disk), or cwd for an exact path
//   ageDays  how old the transcript file is (its modification time), default 1
//   stampDays  how old the records inside are (default: as old as the file)
//   prompt   the first prompt; prompts: 0 writes a session with nothing typed in it
//   companions  also create the session's folder, file history, uploads and so on (the same age)
export function session(w, o = {}) {
  const id = o.id || uuid(o.seed || `s-${Math.random()}`, 0);
  const root = o.cwd ? o.cwd : w.project(o.project ?? "webapp");
  const mtime = o.mtime ?? NOW - (o.ageDays ?? 1) * DAY;
  const stamp = o.stampDays === undefined ? mtime : NOW - o.stampDays * DAY;
  const t = new Transcript({ id, seed: id, cwd: root, entrypoint: o.entrypoint ?? "cli", start: new Date(stamp - 600000).toISOString() });
  t.bookkeeping();
  if (o.prompts !== 0) {
    t.prompt(o.prompt ?? "hello there");
    t.say(o.answer ?? "hi");
    for (let i = 1; i < (o.prompts ?? 1); i++) { t.prompt(`${o.prompt ?? "hello there"} ${i + 1}`); t.say("ok"); }
  }
  if (o.customTitle) t.customTitle(o.customTitle);
  if (o.aiTitle) t.aiTitle(o.aiTitle);
  const written = t.write(w.claude, { mtime, text: o.text });
  const rel = o.companions ? addCompanions(w.claude, written.slug, id, { mtime }) : [];
  return { ...written, root, mtime, rel };
}

// The mode a file has, as a short string, for tests that must not change it.
export const exists = (p) => fs.existsSync(p);
export const read = (p) => fs.readFileSync(p, "utf8");
export const mtimeOf = (p) => Math.round(fs.statSync(p).mtimeMs); // whole milliseconds: file systems differ in the digits after
