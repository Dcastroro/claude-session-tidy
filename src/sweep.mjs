// When will Claude Code's cleanup remove a session? (Behaviour checked against Claude Code 2.1.295 with
// the real binary; test/e2e-retention.test.mjs repeats the checks whenever E2E_CLAUDE points at one.)
//
// The cleanup runs in the background about 5 seconds after Claude Code starts working, at most once a
// day. It deletes a session's transcript when the file's modification time is older than the retention
// period; the timestamps written inside the transcript play no part. Together with the transcript it
// removes the session's folder (subagents, tool results) and the markers beside it. So the day a session
// goes is its file's modification time plus the period, and touching the file moves that day.
//
// One exception: sessions started by Claude Desktop (entrypoint claude-desktop, claude-desktop-3p or
// local-agent) are skipped until the desktop app releases them. Archiving or deleting one in the app writes
// <id>.desktop-released.json beside it; "delete" releases it at once, "archive" a period after the marker was
// written. desktopSessionCleanupPeriodDays, when set, is a ceiling: past it a desktop session goes like any other.
import { DAY } from "./util.mjs";

const DESKTOP = new Set(["claude-desktop", "claude-desktop-3p", "local-agent"]);
export const isDesktopEntrypoint = (e) => DESKTOP.has(e === "local_agent" ? "local-agent" : e);

// facts: { mtimeMs, desktop (the session was started by Claude Desktop), marker (readReleaseMarker or null) }
// retention: what readRetention returned.
// Returns { state, dueMs }:
//   scheduled  dueMs is the moment after which the next cleanup removes it, in the future
//   due        dueMs has passed: the next cleanup removes it (it runs when Claude Code is next started)
//   exempt     a Claude Desktop session that nothing releases, so the cleanup skips it
//   paused     Claude Code skips the whole cleanup until a settings problem is fixed
export function sweepOf(facts, retention, now = Date.now()) {
  if (retention.paused) return { state: "paused", dueMs: null };
  const period = retention.days * DAY;
  let due = facts.mtimeMs + period;
  if (facts.desktop) {
    let release = Infinity;
    if (retention.desktopDays > 0) release = Math.min(release, facts.mtimeMs + retention.desktopDays * DAY);
    const marker = facts.marker;
    if (marker && marker.reason === "delete") release = -Infinity;
    else if (marker && marker.reason === "archive") release = Math.min(release, marker.mtimeMs + period);
    if (release === Infinity) return { state: "exempt", dueMs: null };
    due = Math.max(due, release);
  }
  return { state: due <= now ? "due" : "scheduled", dueMs: due };
}

// Whole days from `now` until `dueMs`, rounded up (0 on the last day, negative once it has passed).
export const daysUntil = (dueMs, now = Date.now()) => Math.ceil((dueMs - now) / DAY);

// `keep` and `refresh` touch a session when half of its time or more is used up. Touching sooner would
// buy nothing, and since `claude --continue` goes by modification time (checked with the real binary),
// every touch moves a session to the front of that list.
export const needsTouch = (mtimeMs, days, now = Date.now()) => now - mtimeMs >= (days * DAY) / 2;
