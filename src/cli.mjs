// claude-session-tidy: list, delete, keep and restore Claude Code sessions. Commands: list, delete, restore,
// keep, unkeep, refresh, tidy, empty-trash, init, uninstall. It reads and writes files under Claude Code's
// config folder only, runs no model and makes no network request.
import path from "node:path";
import { claudeDir, keepFile, projectsDir, readRetention, trashRoot } from "./config.mjs";
import { logError } from "./errorlog.mjs";
import { hookStatus, init, uninstall } from "./install.mjs";
import { keepSessions, readKeep, refreshKept, unkeepSessions } from "./keep.mjs";
import { withActivity, withScan, withSize, withSweep } from "./overview.mjs";
import {
  MARKDOWN_ROW_CAP, renderEmptyTrash, renderInit, renderKept, renderListMarkdown, renderListText, renderMoved, renderRefresh,
  renderRestored, renderTidy, renderTrashList, renderUninstall, renderUnkept,
} from "./render.mjs";
import { findSessions, makeStore, projectName, resolveIds, shortIds } from "./sessions.mjs";
import { ACTIVE_MS, findCandidates } from "./tidy.mjs";
import { deleteSessions, emptyTrash, listTrash, restoreSession } from "./trash.mjs";
import { UserError, cmp, fail, isoOf, makeColors, plural } from "./util.mjs";
import { REPO_URL, VERSION } from "./version.mjs";

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

export const COMMANDS = {
  list: { run: cmdList, bool: ["all", "json", "markdown"], value: ["project", "sort", "limit", "due", "title"] },
  delete: { run: cmdDelete, bool: ["dry-run", "json"], value: [] },
  restore: { run: cmdRestore, bool: ["dry-run", "json"], value: [] },
  keep: { run: cmdKeep, bool: ["dry-run", "json"], value: [] },
  unkeep: { run: cmdUnkeep, bool: ["dry-run", "json"], value: [] },
  refresh: { run: cmdRefresh, bool: ["quiet", "dry-run", "json"], value: [] },
  tidy: { run: cmdTidy, bool: ["all", "empty", "orphans", "dry-run", "json"], value: ["project", "older"] },
  "empty-trash": { run: cmdEmptyTrash, bool: ["yes", "dry-run", "json"], value: ["older"] },
  init: { run: cmdInit, bool: ["dry-run", "json"], value: [] },
  uninstall: { run: cmdUninstall, bool: ["dry-run", "json"], value: [] },
};

function parseArgs(argv, spec) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { args._.push(...argv.slice(i + 1)); break; }
    if (a === "-h" || a === "--help") { args.help = true; continue; }
    if (!a.startsWith("--")) { args._.push(a); continue; }
    const eq = a.indexOf("=");
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (spec.bool.includes(key)) {
      if (eq > 0) fail(`--${key} does not take a value.`);
      args[key] = true;
    } else if (spec.value.includes(key)) {
      if (eq > 0) args[key] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) args[key] = argv[++i];
      else fail(`--${key} needs a value.`);
    } else fail(`Unknown option --${key}. Run claude-session-tidy --help for the options.`);
  }
  return args;
}

function wholeNumber(value, name, { min = 1 } = {}) {
  const n = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(n) || n < min) fail(`${name} needs a whole number, ${min} or more.`);
  return n;
}

function scopeOf(args, ctx) {
  const dir = args.project ? path.resolve(ctx.cwd, args.project) : ctx.cwd;
  if (args.all) return { all: true, root: "", dir, label: "all projects" };
  return { all: false, root: dir, dir, label: dir };
}

// ---------------------------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------------------------

const jsonRow = (r) => ({
  id: r.id,
  short: r.short,
  project: r.project,
  cwd: r.cwd,
  slug: r.slug,
  title: r.title,
  prompts: r.prompts,
  lastActivity: isoOf(r.lastActiveMs),
  modified: isoOf(r.mtimeMs),
  bytes: r.totalBytes,
  files: r.totalFiles,
  kept: r.kept,
  entrypoint: r.entrypoint,
  sweep: { state: r.sweep.state, on: isoOf(r.sweep.dueMs), daysLeft: r.sweep.daysLeft },
  file: r.file,
});

function trashSummary(env) {
  const entries = listTrash(env);
  return { count: entries.length, bytes: entries.reduce((n, e) => n + e.bytes, 0) };
}

async function cmdList(args, ctx) {
  if (args.json && args.markdown) fail("Choose --json or --markdown, not both.");
  const sort = args.sort === undefined ? "age" : String(args.sort);
  if (!["age", "size", "prompts"].includes(sort)) fail("--sort must be age, size or prompts.");
  const limit = args.limit === undefined ? Infinity : wholeNumber(args.limit, "--limit");
  const due = args.due === undefined ? undefined : wholeNumber(args.due, "--due");
  const title = args.title === undefined ? undefined : String(args.title);
  if (title !== undefined && !title.trim()) fail("--title needs non-empty text.");
  const scope = scopeOf(args, ctx);
  const { env, now } = ctx;
  const retention = readRetention(env, { projectDir: scope.dir });
  const keep = readKeep(env);
  if (keep.status === "invalid") ctx.warn(`claude-session-tidy: ${keep.file} ${keep.reason}; kept sessions are not marked.`);
  const store = makeStore(env);
  const sessions = findSessions(env, { all: scope.all, root: scope.root, meta: false });
  const byTime = (a, b) => b.lastActiveMs - a.lastActiveMs || b.mtimeMs - a.mtimeMs || cmp(a.id, b.id);
  let measured = false;
  if (sort === "age") { sessions.forEach(withActivity); sessions.sort(byTime); }
  else if (sort === "size") { sessions.forEach((s) => withSize(store, s)); measured = true; sessions.forEach(withActivity); sessions.sort((a, b) => b.totalBytes - a.totalBytes || byTime(a, b)); }
  else { sessions.forEach((s) => { withScan(s); withActivity(s); }); sessions.sort((a, b) => b.prompts - a.prompts || byTime(a, b)); }
  if (due !== undefined) sessions.forEach((s) => withSweep(s, retention, now));
  let matching = due === undefined ? sessions : sessions.filter((s) => s.sweep.daysLeft !== null && s.sweep.daysLeft <= due);
  if (title !== undefined) {
    const needle = title.toLowerCase();
    matching = matching.filter((s) => withScan(s).title.toLowerCase().includes(needle));
  }
  const rows = matching.slice(0, limit);
  const shorts = shortIds(sessions.map((s) => s.id));
  for (const r of rows) {
    withScan(r); withActivity(r); withSize(store, r); withSweep(r, retention, now);
    r.project = projectName(r);
    r.short = shorts.get(r.id);
    r.kept = Object.hasOwn(keep.kept, r.id);
  }
  if (rows.length === sessions.length && !measured) measured = true;
  const keptHere = rows.filter((r) => r.kept).length;
  const everKept = Object.keys(keep.kept);
  const hook = hookStatus(env);
  const present = new Set(sessions.map((s) => s.id));
  // Kept sessions that are not in this table may sit in another project; only those missing everywhere are reported.
  const keptMissing = scope.all ? everKept.filter((id) => !present.has(id)) : [];
  const model = {
    scope, sort, retention, rows, due, title, matched: matching.length, shown: rows.length, total: sessions.length,
    totalBytes: measured ? sessions.reduce((n, s) => n + (s.totalBytes ?? 0), 0) : null,
    keptCount: scope.all ? everKept.length : keptHere, keptMissing, hook, trash: trashSummary(env),
  };
  if (args.json) {
    ctx.out(`${JSON.stringify({
      schema: 1, tool: "claude-session-tidy", version: VERSION, configDir: claudeDir(env),
      scope: { all: scope.all, project: scope.all ? null : scope.root },
      retention: { days: retention.days, source: retention.source, file: retention.file, paused: retention.paused, desktopDays: retention.desktopDays },
      hook: { installed: hook.installed, plugin: hook.plugin },
      total: model.total, shown: model.shown, bytes: model.totalBytes, keptMissing,
      ...(title === undefined ? {} : { title, matched: model.matched }),
      sessions: rows.map(jsonRow),
    }, null, 2)}\n`);
    return 0;
  }
  if (args.markdown) { ctx.say(renderListMarkdown(model)); return 0; }
  if (!rows.length && due === undefined && title === undefined) {
    ctx.say(`No Claude Code sessions found for ${scope.label} (looked in ${projectsDir(env)}).`);
    if (!scope.all) ctx.say(ctx.c.dim("Use --all to list every project's sessions."));
    return 0;
  }
  ctx.say(renderListText(model, { columns: ctx.columns, color: ctx.c }));
  return 0;
}

// A row for the manifest and the reports: the title, folder and last use of a session found by id.
function describe(env) {
  return (resolved) => {
    const row = withActivity(withScan({ ...resolved.copies.slice().sort((a, b) => b.mtimeMs - a.mtimeMs)[0] }));
    return { title: row.title, cwd: row.cwd, lastActive: isoOf(row.lastActiveMs) };
  };
}

// The short form of an id, long enough to tell the sessions apart that are on the screen.
const shortOfAll = (ids) => { const m = shortIds(ids); return (id) => m.get(id) || id.slice(0, 8); };

// ---------------------------------------------------------------------------------------------
// delete, restore, tidy, empty-trash
// ---------------------------------------------------------------------------------------------

function noteRecent(resolved, ctx) {
  const recent = resolved.filter((r) => r.copies.some((c) => ctx.now - c.mtimeMs < ACTIVE_MS));
  for (const r of recent) ctx.warn(`claude-session-tidy: note: ${r.id.slice(0, 8)} changed in the last 10 minutes. If it is open in Claude Code, close it first.`);
}

async function cmdDelete(args, ctx) {
  const { env, now } = ctx;
  const resolved = resolveIds(env, args._);
  noteRecent(resolved, ctx);
  const plans = deleteSessions(env, resolved, { describe: describe(env), dryRun: !!args["dry-run"], now });
  if (args.json) {
    ctx.out(`${JSON.stringify({ ok: true, dryRun: !!args["dry-run"], moved: plans.map((p) => ({ id: p.id, title: p.title, bytes: p.bytes, files: p.files, items: p.items, trash: p.trash })), bytes: plans.reduce((n, p) => n + p.bytes, 0), trash: trashRoot(env) }, null, 2)}\n`);
    return 0;
  }
  ctx.say(renderMoved(plans, { dryRun: !!args["dry-run"], trashDir: trashRoot(env), shortOf: shortOfAll(plans.map((p) => p.id)), color: ctx.c }));
  return 0;
}

async function cmdRestore(args, ctx) {
  const { env, now } = ctx;
  if (!args._.length) {
    const entries = listTrash(env).map((e) => ({ id: e.id, title: e.title, bytes: e.bytes, trashedAt: isoOf(e.trashedAtMs), trashedAtMs: e.trashedAtMs }));
    if (args.json) { ctx.out(`${JSON.stringify({ ok: false, error: "Which session? Give its id.", trash: entries }, null, 2)}\n`); return 1; }
    ctx.warn(`${ctx.c.red("✗")} Which session? Give the id of one in the trash.`);
    ctx.warn(renderTrashList(entries, { color: ctx.c, shortOf: shortOfAll(entries.map((e) => e.id)) }));
    return 1;
  }
  if (args._.length > 1) fail("restore takes one session at a time.");
  const retention = readRetention(env, { projectDir: ctx.cwd });
  const r = restoreSession(env, args._[0], { dryRun: !!args["dry-run"], now, days: retention.days });
  if (args.json) { ctx.out(`${JSON.stringify({ ok: true, dryRun: !!args["dry-run"], ...r }, null, 2)}\n`); return 0; }
  ctx.say(renderRestored(r, { dryRun: !!args["dry-run"], color: ctx.c }));
  return 0;
}

async function cmdTidy(args, ctx) {
  const { env, now } = ctx;
  const scope = scopeOf(args, ctx);
  const olderDays = args.older === undefined ? 0 : wholeNumber(args.older, "--older");
  const picked = !!args.empty || !!args.orphans || olderDays > 0;
  const want = { empty: picked ? !!args.empty : true, orphans: picked ? !!args.orphans : true, olderDays };
  const keep = readKeep(env);
  if (keep.status === "invalid") fail(`${keep.file} ${keep.reason}, so I cannot tell which sessions are kept. Fix it, or move it away, first.`);
  const found = findCandidates(env, { all: scope.all, root: scope.root, ...want, keepIds: new Set(Object.keys(keep.kept)), now });
  const resolved = found.candidates.map((c) => ({ id: c.id, copies: c.copies }));
  const dryRun = !!args["dry-run"];
  const plans = deleteSessions(env, resolved, { describe: describe(env), dryRun, now });
  const moved = plans.map((p) => ({ ...p, reasons: found.candidates.find((c) => c.id === p.id).reasons }));
  const plan = { considered: found.considered, moved, skipped: found.skipped };
  if (args.json) {
    ctx.out(`${JSON.stringify({
      ok: true, dryRun, scope: { all: scope.all, project: scope.all ? null : scope.root }, categories: want, considered: found.considered,
      sessions: moved.map((p) => ({ id: p.id, title: p.title, bytes: p.bytes, files: p.files, reasons: p.reasons, trash: p.trash })),
      bytes: moved.reduce((n, p) => n + p.bytes, 0), skipped: found.skipped, trash: trashRoot(env),
    }, null, 2)}\n`);
    return 0;
  }
  ctx.say(renderTidy(plan, { dryRun, scopeLabel: scope.label, trashDir: trashRoot(env), shortOf: shortOfAll(moved.map((p) => p.id)), color: ctx.c }));
  return 0;
}

async function cmdEmptyTrash(args, ctx) {
  const { env, now } = ctx;
  const olderDays = args.older === undefined ? 0 : wholeNumber(args.older, "--older");
  const r = emptyTrash(env, { olderDays, yes: !!args.yes, dryRun: !!args["dry-run"], now });
  if (args.json) { ctx.out(`${JSON.stringify({ ok: r.deleted || !r.entries.length || !!args["dry-run"], ...r, dryRun: !!args["dry-run"] }, null, 2)}\n`); return r.deleted || !r.entries.length || args["dry-run"] ? 0 : 1; }
  ctx.say(renderEmptyTrash(r, { dryRun: !!args["dry-run"], olderDays, shortOf: shortOfAll(r.entries.map((e) => e.id)), color: ctx.c }));
  return r.deleted || !r.entries.length || args["dry-run"] ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// keep, unkeep, refresh
// ---------------------------------------------------------------------------------------------

async function cmdKeep(args, ctx) {
  const { env, now } = ctx;
  const resolved = resolveIds(env, args._);
  const results = keepSessions(env, resolved, { now, dryRun: !!args["dry-run"] });
  const hook = hookStatus(env);
  if (args.json) { ctx.out(`${JSON.stringify({ ok: true, dryRun: !!args["dry-run"], kept: results, hook: { installed: hook.installed, plugin: hook.plugin }, file: keepFile(env) }, null, 2)}\n`); return 0; }
  ctx.say(renderKept(results, { dryRun: !!args["dry-run"], hook, keepPath: keepFile(env), shortOf: shortOfAll(results.map((r) => r.id)), color: ctx.c }));
  return 0;
}

async function cmdUnkeep(args, ctx) {
  const { env } = ctx;
  const r = unkeepSessions(env, args._, {
    dryRun: !!args["dry-run"],
    exists: (ref) => { try { return resolveIds(env, [ref]).length > 0; } catch { return false; } },
  });
  if (args.json) { ctx.out(`${JSON.stringify({ ok: true, dryRun: !!args["dry-run"], ...r }, null, 2)}\n`); return 0; }
  ctx.say(renderUnkept(r, { dryRun: !!args["dry-run"], shortOf: shortOfAll(r.released), color: ctx.c }));
  return 0;
}

async function cmdRefresh(args, ctx) {
  const { env, now } = ctx;
  if (args.quiet) {
    // Run from a hook: print nothing at all, whatever happens, and leave a line in errors.log if it fails.
    try {
      const r = refreshKept(env, { now, dryRun: !!args["dry-run"], projectDir: ctx.cwd });
      if (r.missing.length) logError(env, `${plural(r.missing.length, "kept session")} no longer exist: ${r.missing.map((id) => id.slice(0, 8)).join(", ")}`, now);
    } catch (e) {
      logError(env, e && e.message ? e.message : String(e), now);
    }
    return 0;
  }
  const r = refreshKept(env, { now, dryRun: !!args["dry-run"], projectDir: ctx.cwd });
  if (args.json) { ctx.out(`${JSON.stringify({ ok: true, dryRun: !!args["dry-run"], ...r }, null, 2)}\n`); return 0; }
  ctx.say(renderRefresh(r, { dryRun: !!args["dry-run"], shortOf: shortOfAll([...r.touched.map((t) => t.id), ...r.missing]), color: ctx.c }));
  return 0;
}

// ---------------------------------------------------------------------------------------------
// init, uninstall
// ---------------------------------------------------------------------------------------------

async function cmdInit(args, ctx) {
  const r = init(ctx.env, { dryRun: !!args["dry-run"], now: ctx.now });
  if (args.json) { ctx.out(`${JSON.stringify(r, null, 2)}\n`); return r.ok ? 0 : 1; }
  const text = renderInit(r, { color: ctx.c });
  if (r.ok) ctx.say(text); else ctx.warn(text);
  return r.ok ? 0 : 1;
}

async function cmdUninstall(args, ctx) {
  const r = uninstall(ctx.env, { dryRun: !!args["dry-run"], now: ctx.now });
  if (args.json) { ctx.out(`${JSON.stringify(r, null, 2)}\n`); return r.ok ? 0 : 1; }
  const text = renderUninstall(r, { color: ctx.c });
  if (r.ok) ctx.say(text); else ctx.warn(text);
  return r.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

const helpText = (c) => `${c.bold("claude-session-tidy")} ${VERSION}: list, delete, keep and restore your Claude Code sessions.

${c.bold("Look")}
  claude-session-tidy list [--all | --project <dir>] [--sort age|size|prompts] [--due <days>] [--title <text>] [--limit <n>] [--json | --markdown]

${c.bold("Delete, with a way back")}
  claude-session-tidy delete <id...> [--dry-run] [--json]      move sessions to the trash
  claude-session-tidy restore [<id>] [--dry-run] [--json]      put one back (no id: list the trash)
  claude-session-tidy tidy [--all | --project <dir>] [--empty] [--orphans] [--older <days>] [--dry-run] [--json]
                                                               move empty, orphaned and old sessions to the trash
  claude-session-tidy empty-trash [--older <days>] [--yes] [--dry-run] [--json]
                                                               delete the trash for good (asks for --yes)

${c.bold("Keep past the cleanup")}
  claude-session-tidy keep <id...> [--dry-run] [--json]        hold sessions back from Claude Code's cleanup
  claude-session-tidy unkeep <id...> [--dry-run] [--json]
  claude-session-tidy refresh [--quiet] [--dry-run] [--json]   touch kept sessions that need it

${c.bold("Hook")}
  claude-session-tidy init [--dry-run] [--json]                run refresh when a Claude Code session starts
  claude-session-tidy uninstall [--dry-run] [--json]           take that hook out again

<id> is a session id, or its first 6 or more characters when that is enough to tell it from the others.
Sessions are the ones whose folder is the current project; --all or --project <dir> changes that. tidy with none
of --empty, --orphans and --older looks for empty and orphaned sessions. --markdown prints at most ${MARKDOWN_ROW_CAP} rows.
Claude Code removes a session when its file has not been modified for cleanupPeriodDays (default 30); keep touches
the file again. Files are read from and written to $CLAUDE_CONFIG_DIR, or ~/.claude. Nothing is sent anywhere.
${REPO_URL}`;

export async function main(argv, io = {}) {
  const env = io.env || process.env;
  const tty = io.tty ?? !!process.stdout.isTTY;
  const ctx = {
    cwd: io.cwd || process.cwd(),
    env,
    now: io.now ?? Date.now(),
    tty,
    columns: io.columns ?? process.stdout.columns ?? 100,
    c: makeColors(env, tty),
    out: io.out || ((s) => process.stdout.write(s)),
    err: io.err || ((s) => process.stderr.write(s)),
  };
  ctx.say = (s = "") => ctx.out(`${s}\n`);
  ctx.warn = (s = "") => ctx.err(`${s}\n`);
  let json = false;
  try {
    const [name, ...rest] = argv;
    if (!name || name === "help" || name === "--help" || name === "-h") { ctx.say(helpText(ctx.c)); return 0; }
    if (name === "--version" || name === "-v" || name === "version") { ctx.say(VERSION); return 0; }
    const command = COMMANDS[name];
    if (!command) { ctx.warn(`${ctx.c.red("✗")} Unknown command "${name}".`); ctx.warn(helpText(ctx.c)); return 1; }
    const args = parseArgs(rest, command);
    json = !!args.json;
    if (args.help) { ctx.say(helpText(ctx.c)); return 0; }
    return (await command.run(args, ctx)) ?? 0;
  } catch (err) {
    if (err instanceof UserError) {
      if (json) ctx.out(`${JSON.stringify({ ok: false, error: err.message }, null, 2)}\n`);
      else ctx.warn(`${ctx.c.red("✗")} ${err.message}`);
      return 1;
    }
    ctx.warn(`${ctx.c.red("✗")} claude-session-tidy hit an unexpected error: ${err?.stack || err}`);
    return 2;
  }
}
