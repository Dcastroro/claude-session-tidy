// Turns the sessions found on disk into the rows `list` and `tidy` show. Each step reads only what it needs
// and remembers the answer on the row, so sorting by age reads a few KB of every file but a table of 15 rows
// reads only those 15 files in full.
import path from "node:path";
import { companionsOf, readReleaseMarker, sized } from "./sessions.mjs";
import { daysUntil, isDesktopEntrypoint, sweepOf } from "./sweep.mjs";
import { customTitleFile, entrypoints, lastActivity, pickTitle, quickMeta, scanTranscript } from "./transcript.mjs";

// The folder the session ran in, its branch and start time, from the first records.
export function withMeta(row) {
  if (row.cwd === undefined) {
    const m = quickMeta(row.file);
    row.cwd = m.cwd;
    row.branch = m.branch;
    row.started = m.started;
    row.entrypoint = row.entrypoint || m.entrypoint;
  }
  return row;
}

// When the session was last used: the newest timestamp inside the transcript, else the file's time.
export function withActivity(row) {
  if (row.lastActiveMs === undefined) {
    const t = lastActivity(row.file);
    row.lastActiveMs = Number.isFinite(t) ? t : row.mtimeMs;
  }
  return row;
}

// Size of the transcript and of everything that belongs to the session.
export function withSize(store, row) {
  if (row.totalBytes === undefined) {
    const s = sized(companionsOf(store, row));
    row.totalBytes = s.bytes;
    row.totalFiles = s.files;
  }
  return row;
}

// Prompts typed and the title, by reading the whole transcript.
export function withScan(row) {
  if (row.prompts === undefined) {
    const info = scanTranscript(row.file);
    row.prompts = info.prompts;
    row.readable = info.readable;
    row.hasAssistant = info.hasAssistant;
    if (!row.cwd) row.cwd = info.cwd;
    const custom = customTitleFile(path.join(row.dir, row.id));
    row.title = pickTitle({ ...info.titles, custom: custom || info.titles.custom }, info.firstPrompt);
  }
  return row;
}

// Which app started the session, and the Desktop app's release marker, for the cleanup's rules.
function withFacts(row) {
  if (row.desktop === undefined) {
    const ep = entrypoints(row.file);
    row.entrypoint = ep.first || row.entrypoint || "";
    row.desktop = isDesktopEntrypoint(ep.first) || isDesktopEntrypoint(ep.last);
    row.marker = row.desktop ? readReleaseMarker(row) : null;
  }
  return row;
}

// When Claude Code's cleanup removes the session: { state, dueMs, daysLeft }.
export function withSweep(row, retention, now) {
  withFacts(row);
  const s = sweepOf({ mtimeMs: row.mtimeMs, desktop: row.desktop, marker: row.marker }, retention, now);
  row.sweep = { state: s.state, dueMs: s.dueMs, daysLeft: s.dueMs === null ? null : daysUntil(s.dueMs, now) };
  return row;
}
