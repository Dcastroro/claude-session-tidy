// What the commands print: aligned text for a terminal, a compact markdown table for the skill. Pure functions
// of the data they are given, so the same model also becomes JSON in cli.mjs.
import { describeRetention } from "./config.mjs";
import { baseName, localDay, localStamp, oneLine, plural, size } from "./util.mjs";

const dirName = (p) => String(p).replace(/[\\/][^\\/]*$/, "");

export const MARKDOWN_ROW_CAP = 40; // the skill's report never grows past this many rows, whatever --limit says

const SORT_LABEL = { age: "newest first", size: "largest first", prompts: "most prompts first" };

// What the SWEEP column says: the day Claude Code's cleanup removes the session, or why there is no day.
// "due" means the day has passed and the next cleanup (when Claude Code is next started) removes it.
function sweepCell(row) {
  switch (row.sweep.state) {
    case "scheduled": return localDay(row.sweep.dueMs);
    case "due": return "due";
    case "exempt": return "exempt";
    default: return "paused";
  }
}

// The lines under the table that need the person's attention.
function notes(m) {
  const out = [];
  const due = m.rows.filter((r) => !r.kept && r.sweep.state === "due").length;
  const keptDue = m.rows.filter((r) => r.kept && r.sweep.state === "due").length;
  if (due) out.push(`${plural(due, "session")} ${due === 1 ? "is" : "are"} past the cleanup date: Claude Code removes ${due === 1 ? "it" : "them"} the next time it starts. "keep" saves a session.`);
  if (keptDue) out.push(`${plural(keptDue, "kept session")} ${keptDue === 1 ? "is" : "are"} past the cleanup date too, because nothing has touched ${keptDue === 1 ? "it" : "them"} lately: run claude-session-tidy refresh now.`);
  if (m.keptCount) {
    const how = m.hook.installed ? "the SessionStart hook refreshes them" : m.hook.plugin ? `the plugin ${m.hook.plugin} refreshes them` : "no hook refreshes them yet: run claude-session-tidy init";
    out.push(`${m.keptCount} kept; ${how}.`);
  }
  if (m.keptMissing.length) out.push(`${plural(m.keptMissing.length, "kept session")} no longer exist${m.keptMissing.length === 1 ? "s" : ""}: ${m.keptMissing.map((id) => id.slice(0, 8)).join(", ")}. "unkeep" takes them off the list.`);
  return out;
}

function header(m, markdown = false) {
  let count = m.due === undefined
    ? (m.shown < m.total ? `${m.shown} of ${m.total}` : `${m.total}`)
    : `${m.shown < m.matched ? `${m.shown} of ${m.matched}` : m.shown} due within ${plural(m.due, "day")}, of ${m.total}`;
  if (m.title !== undefined) {
    let query = JSON.stringify(oneLine(m.title, 70));
    if (markdown) query = query.replace(/[\\`*_[\]<>|]/g, "\\$&");
    count = `${m.shown < m.matched ? `${m.shown} of ${m.matched}` : m.shown} matching ${query}${m.due === undefined ? "" : `, due within ${plural(m.due, "day")}`}, of ${m.total}`;
  }
  const where = m.scope.all ? "all projects" : m.scope.label;
  return { title: `Sessions in ${where} (${count}, ${SORT_LABEL[m.sort]})`, cleanup: `Cleanup: ${describeRetention(m.retention)}.` };
}

// The terminal table.
export function renderListText(m, { columns = 100, color }) {
  const c = color;
  const h = header(m);
  const lines = [c.bold(h.title), c.dim(h.cleanup), ""];
  if (!m.rows.length) return [...lines.slice(0, 2), "", "No sessions."].join("\n");
  const projectCol = m.scope.all;
  const projects = m.rows.map((r) => oneLine(r.project, 18));
  const pw = projectCol ? Math.min(18, Math.max(7, ...projects.map((p) => p.length))) : 0;
  const idw = Math.max(8, ...m.rows.map((r) => r.short.length));
  const fixed = 2 + idw + 2 + 16 + 2 + 7 + 2 + 8 + 2 + 4 + 2 + 10 + 2 + (projectCol ? pw + 2 : 0);
  const room = Math.max(20, columns - fixed);
  lines.push(c.dim(`  ${"ID".padEnd(idw)}  ${"LAST ACTIVITY".padEnd(16)}  ${"PROMPTS".padStart(7)}  ${"SIZE".padStart(8)}  ${"KEPT".padEnd(4)}  ${"SWEEP".padEnd(10)}  ${projectCol ? `${"PROJECT".padEnd(pw)}  ` : ""}TITLE`));
  m.rows.forEach((r, i) => {
    const sweep = sweepCell(r).padEnd(10);
    const paintedSweep = r.sweep.state === "due" ? c.red(sweep) : sweep;
    const kept = (r.kept ? "yes" : "").padEnd(4);
    lines.push(`  ${c.cyan(r.short.padEnd(idw))}  ${localStamp(r.lastActiveMs).padEnd(16)}  ${String(r.prompts).padStart(7)}  ${size(r.totalBytes).padStart(8)}  ${r.kept ? c.green(kept) : kept}  ${paintedSweep}  ${projectCol ? `${projects[i].padEnd(pw)}  ` : ""}${oneLine(r.title, room)}`);
  });
  lines.push("");
  if (m.totalBytes !== null) lines.push(`${plural(m.total, "session")}, ${size(m.totalBytes)} on disk, counting each session's own subagent, tool-result and file-history files.`);
  for (const n of notes(m)) lines.push(n);
  if (m.trash.count) lines.push(`Trash: ${plural(m.trash.count, "session")}, ${size(m.trash.bytes)}. claude-session-tidy restore <id> brings one back.`);
  return lines.join("\n");
}

const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/`/g, "'");

// The skill's report: a markdown table, at most MARKDOWN_ROW_CAP rows, a few lines of notes.
export function renderListMarkdown(m) {
  const h = header(m, true);
  const rows = m.rows.slice(0, MARKDOWN_ROW_CAP);
  const lines = [`**${h.title}**`, h.cleanup, ""];
  if (!rows.length) return [...lines, "No sessions."].join("\n");
  const projectCol = m.scope.all;
  lines.push(`| id | last activity | prompts | size | kept | sweep |${projectCol ? " project |" : ""} title |`);
  lines.push(`| --- | --- | ---: | ---: | --- | --- |${projectCol ? " --- |" : ""} --- |`);
  for (const r of rows) {
    lines.push(`| ${r.short} | ${localStamp(r.lastActiveMs)} | ${r.prompts} | ${size(r.totalBytes)} | ${r.kept ? "yes" : ""} | ${sweepCell(r)} |${projectCol ? ` ${cell(oneLine(r.project, 24))} |` : ""} ${cell(oneLine(r.title, 60))} |`);
  }
  if (m.rows.length > rows.length) lines.push("", `(${rows.length} rows shown; the report is capped at ${MARKDOWN_ROW_CAP}.)`);
  const ns = notes(m);
  if (ns.length) lines.push("", ...ns);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// delete, restore, keep, tidy, empty-trash, refresh
// ---------------------------------------------------------------------------------------------

const idLine = (c, short, title, tail) => `  ${c.cyan(short)}  ${oneLine(title || "(untitled session)", 56).padEnd(56)}  ${tail}`;

export function renderMoved(plans, { dryRun, trashDir, shortOf, color: c }) {
  const bytes = plans.reduce((n, p) => n + p.bytes, 0);
  const lines = [c.bold(`${dryRun ? "Would move" : "Moved"} ${plural(plans.length, "session")} to the trash (${size(bytes)}):`)];
  for (const p of plans) lines.push(idLine(c, shortOf(p.id), p.title, `${plural(p.files, "file")}, ${size(p.bytes)}`));
  lines.push(dryRun ? c.dim("Nothing was moved (--dry-run).") : c.dim(`The trash is ${trashDir}. Undo with: claude-session-tidy restore <id>`));
  return lines.join("\n");
}

export function renderRestored(r, { dryRun, color: c }) {
  const lines = [c.bold(`${dryRun ? "Would restore" : "Restored"} ${r.id}${r.title ? ` "${oneLine(r.title, 60)}"` : ""} (${plural(r.restored.length, "item")}, ${size(r.bytes)})`)];
  if (r.missing.length) lines.push(c.yellow(`Not in the trash any more: ${r.missing.join(", ")}`));
  if (dryRun) lines.push(c.dim("Nothing was moved (--dry-run)."));
  else {
    if (r.touched) lines.push(c.dim(`Its files were touched (${plural(r.touched, "file")}), because the next cleanup would have removed the session otherwise.`));
    lines.push(`Resume it with: claude --resume ${r.id}`);
  }
  return lines.join("\n");
}

export function renderTrashList(entries, { color: c, shortOf }) {
  if (!entries.length) return "The trash is empty.";
  const lines = [c.bold(`In the trash: ${plural(entries.length, "session")}`)];
  for (const e of entries) lines.push(idLine(c, shortOf(e.id), e.title, `${size(e.bytes)}, moved ${localDay(Date.parse(e.trashedAt) || e.trashedAtMs)}`));
  return lines.join("\n");
}

export function renderKept(results, { dryRun, hook, keepPath, shortOf, color: c }) {
  const lines = [c.bold(`${dryRun ? "Would keep" : "Kept"} ${plural(results.length, "session")}${dryRun ? "" : ` (${plural(results.reduce((n, r) => n + r.files, 0), "file")} touched)`}:`)];
  for (const r of results) lines.push(`  ${c.cyan(shortOf(r.id))}${r.already ? "  (was already kept; touched again)" : ""}`);
  if (!dryRun) lines.push(c.dim(`The keep list is ${keepPath}.`));
  if (!hook.installed && !hook.plugin) lines.push("Nothing refreshes them yet, so they are safe for one retention period only. Run: claude-session-tidy init   (or install the plugin).");
  return lines.join("\n");
}

export function renderUnkept(r, { dryRun, shortOf, color: c }) {
  const lines = [];
  if (r.released.length) lines.push(c.bold(`${dryRun ? "Would take" : "Took"} ${plural(r.released.length, "session")} off the keep list: ${r.released.map(shortOf).join(", ")}`));
  if (r.notKept.length) lines.push(`Not on the keep list: ${r.notKept.join(", ")}`);
  if (r.released.length && !dryRun) lines.push(c.dim("Their files keep the time they were last touched; the cleanup treats them like any other session again."));
  return lines.join("\n");
}

export function renderRefresh(r, { dryRun, shortOf, color: c }) {
  if (!r.kept) return "No sessions are kept. keep <id> adds one.";
  const lines = [c.bold(`${dryRun ? "Would refresh" : "Refreshed"} ${r.touched.length} of ${plural(r.kept, "kept session")}`)];
  for (const t of r.touched) lines.push(`  ${c.cyan(shortOf(t.id))}  ${plural(t.files, "file")}`);
  const recent = r.skipped.filter((s) => s.reason === "recent").length;
  const exempt = r.skipped.filter((s) => s.reason === "exempt").length;
  if (recent) lines.push(c.dim(`${plural(recent, "session")} left alone: used up less than half of its time.`));
  if (exempt) lines.push(c.dim(`${plural(exempt, "session")} left alone: started by Claude Desktop, which the cleanup skips.`));
  if (r.missing.length) lines.push(c.yellow(`${plural(r.missing.length, "kept session")} no longer exist${r.missing.length === 1 ? "s" : ""}: ${r.missing.map(shortOf).join(", ")}`));
  return lines.join("\n");
}

const REASON_WORD = { empty: "empty", orphan: "orphan", older: "older" };

export function renderTidy(plan, { dryRun, scopeLabel, trashDir, shortOf, color: c }) {
  const lines = [c.bold(`Tidy: looked at ${plural(plan.considered, "session")} in ${scopeLabel}`)];
  if (!plan.moved.length) {
    lines.push("Nothing to tidy.");
  } else {
    for (const p of plan.moved) {
      const why = p.reasons.map((r) => REASON_WORD[r.kind]).join("+");
      lines.push(`  ${c.cyan(shortOf(p.id))}  ${why.padEnd(14)}  ${oneLine(p.title || "(untitled session)", 44).padEnd(44)}  ${size(p.bytes)}`);
    }
    const bytes = plan.moved.reduce((n, p) => n + p.bytes, 0);
    lines.push(c.bold(`${dryRun ? "Would move" : "Moved"} ${plural(plan.moved.length, "session")} to the trash (${size(bytes)}).`));
  }
  const kept = plan.skipped.filter((s) => s.reason === "kept").length;
  const active = plan.skipped.filter((s) => s.reason === "active").length;
  if (kept) lines.push(c.dim(`Left alone: ${plural(kept, "kept session")}.`));
  if (active) lines.push(c.dim(`Left alone: ${plural(active, "session")} changed in the last 10 minutes (may be open in Claude Code).`));
  if (plan.moved.length) lines.push(dryRun ? c.dim("Nothing was moved (--dry-run).") : c.dim(`The trash is ${trashDir}. Undo with: claude-session-tidy restore <id>`));
  return lines.join("\n");
}

export function renderEmptyTrash(r, { dryRun, olderDays, shortOf, color: c }) {
  if (!r.entries.length) return olderDays ? `Nothing in the trash was moved there more than ${plural(olderDays, "day")} ago.` : "The trash is empty.";
  const lines = [c.bold(`${r.deleted ? "Deleted for good" : "In the trash"}: ${plural(r.entries.length, "session")}, ${size(r.bytes)}`)];
  for (const e of r.entries) lines.push(idLine(c, shortOf(e.id), e.title, `${size(e.bytes)}, moved ${localDay(Date.parse(e.trashedAt))}`));
  if (!r.deleted) lines.push(dryRun ? c.dim("Nothing was deleted (--dry-run).") : c.yellow("Nothing was deleted. Run it again with --yes to delete these for good."));
  return lines.join("\n");
}

export function renderInit(r, { color: c }) {
  const lines = [c.bold(`claude-session-tidy init${r.dryRun ? " (dry run)" : ""}`), `  config folder   ${r.configDir}`];
  if (!r.ok) {
    lines.push("", c.red(`  ${r.settings.problem}`), "  Add this by hand under the top-level \"hooks\" key, then run init again:", "", hookSnippet(r));
    return lines.join("\n");
  }
  lines.push(r.app.copied ? `  copied bin/ and src/ into ${r.app.dir}` : r.dryRun ? `  would copy bin/ and src/ into ${r.app.dir}` : `  ${r.app.reason || "the program copy is in place"}`);
  if (r.settings.backup) lines.push(`  backed up settings.json to ${r.settings.backup}`);
  const verb = { created: "created with the hook", added: "SessionStart hook added (other settings untouched)", replaced: "SessionStart hook replaced (other settings untouched)", unchanged: "already runs the hook, left as it is" }[r.settings.state];
  lines.push(`  settings.json: ${r.dryRun && r.settings.state !== "unchanged" ? `would be changed, ${verb}` : verb}`);
  if (r.check) lines.push(r.check.ok ? `  checked: the installed copy runs (version ${r.check.version})` : c.yellow(`  ! the installed copy did not start cleanly: ${r.check.error}`));
  if (r.plugin) lines.push(c.yellow(`  ! the plugin ${r.plugin} is enabled as well and runs the same hook; once is enough, and running twice does no harm`));
  lines.push("", "The hook runs `refresh --quiet` when a session starts. It prints nothing, so it costs no tokens.", "Start a new Claude Code session (or run /hooks) so it picks the hook up.");
  return lines.join("\n");
}

function hookSnippet(r) {
  const entry = r.snippet || { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node", args: ["<config>/session-tidy/app/bin/claude-session-tidy.mjs", "refresh", "--quiet"], timeout: 10 }] }] } };
  return JSON.stringify(entry, null, 2).split("\n").map((l) => `    ${l}`).join("\n");
}

export function renderUninstall(r, { color: c }) {
  const lines = [c.bold(`claude-session-tidy uninstall${r.dryRun ? " (dry run)" : ""}`)];
  if (!r.ok) { lines.push(c.red(`  ${r.settings.problem}`)); return lines.join("\n"); }
  if (r.settings.state === "removed") {
    if (r.settings.backup) lines.push(`  backed up settings.json to ${r.settings.backup}`);
    lines.push(`  ${r.dryRun ? "would remove" : "removed"} ${plural(r.settings.removed, "SessionStart hook")} from settings.json (other settings untouched)`);
  } else lines.push("  settings.json has no hook of ours; left as it is");
  lines.push(r.app.removed ? `  ${r.dryRun ? "would delete" : "deleted"} ${r.app.dir}` : "  no installed copy to delete");
  if (r.kept.length) lines.push(`  left in place: ${r.kept.map((p) => baseName(p)).join(", ")} (in ${dirName(r.app.dir)}). They are your data; delete them by hand if you want them gone.`);
  return lines.join("\n");
}

