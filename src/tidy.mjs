// What is worth deleting: sessions with nothing typed in them, sessions of projects whose folder is gone, and
// sessions nobody has touched for a number of days. Never a kept session, never one changed in the last
// 10 minutes (it may be open in Claude Code right now).
import { DAY, MINUTE } from "./util.mjs";
import { findSessions, projectFolderExists } from "./sessions.mjs";
import { withActivity, withMeta } from "./overview.mjs";
import { scanTranscript } from "./transcript.mjs";

export const ACTIVE_MS = 10 * MINUTE;
const RANK = ["empty", "orphan", "older"]; // the order reasons are shown in

// opts: { all, root, empty, orphans, olderDays (0 = off), keepIds (a Set), now }
// Returns { candidates: [{ id, copies, row, reasons: [{ kind: "empty" | "orphan" | "older", detail }] }],
// skipped: [{ id, reason: "kept" | "active", why: [kind] }], considered }.
export function findCandidates(env, opts) {
  const { all = false, root = "", empty = false, orphans = false, olderDays = 0, keepIds = new Set(), now = Date.now() } = opts;
  const found = findSessions(env, { all, root, meta: false });
  const groups = new Map(); // one session id can sit in two project folders: judge it once, move all copies
  for (const s of found) {
    if (!groups.has(s.id)) groups.set(s.id, []);
    groups.get(s.id).push(s);
  }
  const out = { candidates: [], skipped: [], considered: groups.size };
  for (const [id, copies] of groups) {
    copies.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const row = copies[0];
    const reasons = [];
    if (orphans && projectFolderExists(withMeta(row).cwd) === false) reasons.push({ kind: "orphan", detail: `the folder ${row.cwd} no longer exists` });
    if (olderDays) {
      withActivity(row);
      const idle = Math.floor((now - row.lastActiveMs) / DAY);
      if (now - row.lastActiveMs > olderDays * DAY) reasons.push({ kind: "older", detail: `last used ${idle} days ago` });
    }
    if (empty) {
      const info = scanTranscript(row.file, { stopAtPrompt: true });
      if (info.readable && info.prompts === 0) reasons.push({ kind: "empty", detail: "nothing was typed in it" });
    }
    if (!reasons.length) continue;
    reasons.sort((a, b) => RANK.indexOf(a.kind) - RANK.indexOf(b.kind));
    if (keepIds.has(id)) out.skipped.push({ id, reason: "kept", why: reasons.map((r) => r.kind) });
    else if (copies.some((c) => now - c.mtimeMs < ACTIVE_MS)) out.skipped.push({ id, reason: "active", why: reasons.map((r) => r.kind) });
    else out.candidates.push({ id, copies, row, reasons });
  }
  return out;
}
