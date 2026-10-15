// Reading what `list` and `tidy` need from a session's transcript, without keeping it in memory:
// where it ran, when it was last used, how many prompts were typed, and what it is called.
//
// A transcript is one JSON object per line. The ones that matter here:
//   user       what the person typed (text, images), or what Claude Code wrote in their name (tool results,
//              injected context, command output); `entrypoint` names the app that started the session
//   assistant  Claude's reply, one record per content block
//   custom-title / ai-title / summary   the /rename name, Claude's title, an older kind of title
// Everything else (queue-operation, attachment, file-history-snapshot ...) is bookkeeping.
import path from "node:path";
import { forEachLine, oneLine, readHeadText, readTailText, tryParse } from "./util.mjs";

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;
const ENTRYPOINT = /"entrypoint":"([^"\\]*)"/g;
const TIMESTAMP = /"timestamp":"(\d{4}-\d{2}-\d{2}T[\d:.]+Z)"/g;

// ---------------------------------------------------------------------------------------------
// User records: what is a prompt
// ---------------------------------------------------------------------------------------------

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
// One injected element such as <ide_opened_file>...</ide_opened_file> or <task-notification>...: a
// lowercase name with a "-" or "_", opened and closed around the whole block.
const WRAPPER = /^<([a-z][a-z0-9]*[-_][a-z0-9_-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>$/;
const COMMAND = /^(?:<command-message>[\s\S]*?<\/command-message>\s*)?<command-name>\s*([^<]*?)\s*<\/command-name>/;
const BASH_INPUT = /^<bash-input>([\s\S]*?)<\/bash-input>$/;
const OUTPUT_OF_ONE = /^<(?:bash-stdout|bash-stderr|local-command-stdout|local-command-stderr|local-command-caveat)>/;

function classifyText(raw) {
  const t = String(raw).replace(REMINDER, "").trim();
  if (!t) return null;
  let m = COMMAND.exec(t);
  if (m) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t);
    return { kind: "command", text: args && args[1].trim() ? `${m[1]} ${args[1].trim()}` : m[1] };
  }
  m = BASH_INPUT.exec(t);
  if (m) return { kind: "bash", text: `! ${m[1].trim()}` };
  if (OUTPUT_OF_ONE.test(t) || WRAPPER.test(t) || /^Caveat:/.test(t) || /^\[Request interrupted/.test(t)) return { kind: "skip" };
  return { kind: "prompt", text: t };
}

// What a user record is, when the person typed it: { kind: "prompt" | "command" | "bash", text }, else null.
// A slash command and a "!" shell command count as prompts; tool results, injected context, command
// output, interruptions and compaction summaries do not.
export function promptOf(rec) {
  if (!rec || rec.type !== "user" || rec.isMeta || rec.isCompactSummary || rec.isSidechain) return null;
  const content = rec.message && rec.message.content;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  const texts = [];
  let special = null;
  let media = false;
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "image" || b.type === "document") media = true;
    else if (b.type === "text" && typeof b.text === "string") {
      const c = classifyText(b.text);
      if (!c || c.kind === "skip") continue;
      if (c.kind === "prompt") texts.push(c.text);
      else special ||= c;
    }
  }
  if (special) return special;
  if (texts.length) return { kind: "prompt", text: texts.join("\n\n") };
  if (media) return { kind: "prompt", text: "(image)" };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------------------------

// A title stored in a transcript record, or null. custom-title (set with /rename) beats ai-title.
export function titleOf(rec) {
  if (rec.type === "custom-title" && typeof rec.customTitle === "string" && rec.customTitle) return { custom: rec.customTitle };
  if (rec.type === "ai-title" && typeof rec.aiTitle === "string" && rec.aiTitle) return { ai: rec.aiTitle };
  // Older versions stored a short summary line as the title. A long one is a compaction summary.
  if (rec.type === "summary" && typeof rec.summary === "string" && rec.summary.length <= 160) return { summary: rec.summary };
  return null;
}
export const pickTitle = (t, firstPrompt = "") => t.custom || t.ai || t.summary || oneLine(firstPrompt, 70) || "(untitled session)";

// ---------------------------------------------------------------------------------------------
// Looking at a transcript
// ---------------------------------------------------------------------------------------------

// The first record that names a working directory gives the project folder, branch and start time;
// the entrypoint says which app started the session (cli, sdk-cli, claude-vscode, claude-desktop ...).
export function quickMeta(file) {
  const meta = { cwd: "", branch: "", started: "", entrypoint: "" };
  let seen = 0;
  forEachLine(file, (line) => {
    seen++;
    if (!meta.cwd && !line.includes('"cwd":"')) return seen < 200;
    const rec = tryParse(line);
    if (rec && typeof rec === "object") {
      if (!meta.cwd && typeof rec.cwd === "string") meta.cwd = rec.cwd;
      if (!meta.branch && typeof rec.gitBranch === "string") meta.branch = rec.gitBranch;
      if (!meta.started && rec.cwd && typeof rec.timestamp === "string") meta.started = rec.timestamp;
      if (!meta.entrypoint && typeof rec.entrypoint === "string") meta.entrypoint = rec.entrypoint;
    }
    return !(meta.cwd && meta.entrypoint && meta.started) && seen < 200;
  }, { chunk: 16 * 1024 });
  return meta;
}

// The app that started the session, from the start of the file and from its end (a session that was
// continued in another app has two). Claude Code's cleanup checks both ends the same way.
export function entrypoints(file) {
  const all = (text) => [...text.matchAll(ENTRYPOINT)].map((m) => m[1]);
  const head = all(readHeadText(file, HEAD_BYTES));
  const tail = all(readTailText(file, TAIL_BYTES));
  return { first: head[0] || "", last: tail.length ? tail[tail.length - 1] : head[head.length - 1] || "" };
}

// The newest timestamp near the end of the file, as milliseconds (NaN when there is none).
export function lastActivity(file) {
  for (const bytes of [16 * 1024, 1024 * 1024]) {
    const tail = readTailText(file, bytes);
    let last = "";
    for (const m of tail.matchAll(TIMESTAMP)) last = m[1];
    if (last) return Date.parse(last);
    if (tail.length < bytes) break; // that was the whole file
  }
  return NaN;
}

// Everything `list` shows, by reading the file once. A cheap text test skips the lines that cannot
// matter (tool results, the bulk of a session) before any JSON is parsed. With `stopAtPrompt` it
// stops at the first prompt, which is all `tidy` needs to know a session is not empty.
export function scanTranscript(file, { stopAtPrompt = false } = {}) {
  const info = { prompts: 0, firstPrompt: "", hasAssistant: false, titles: {}, cwd: "", branch: "", started: "", readable: true };
  let headLines = 0;
  info.readable = forEachLine(file, (line) => {
    if (line.includes('"isSidechain":true')) return undefined;
    const wantHead = headLines < 80 && !(info.cwd && info.started);
    const isTitle = line.includes('-title"') || line.includes('"type":"summary"');
    const isUser = line.includes('"type":"user"') && !(line.length > 4096 && line.includes('"type":"tool_result"'));
    if (!(wantHead || isTitle || isUser)) {
      if (line.includes('"type":"assistant"')) info.hasAssistant = true;
      return undefined;
    }
    if (wantHead) headLines++;
    const rec = tryParse(line);
    if (!rec || typeof rec !== "object") return undefined;
    if (!info.cwd && typeof rec.cwd === "string") info.cwd = rec.cwd;
    if (!info.branch && typeof rec.gitBranch === "string") info.branch = rec.gitBranch;
    if (!info.started && rec.cwd && typeof rec.timestamp === "string") info.started = rec.timestamp;
    const title = titleOf(rec);
    if (title) Object.assign(info.titles, title);
    if (rec.type === "assistant") info.hasAssistant = true;
    if (rec.type === "user") {
      const p = promptOf(rec);
      if (p) {
        info.prompts++;
        if (!info.firstPrompt) info.firstPrompt = p.text;
        if (stopAtPrompt) return false;
      }
    }
    return undefined;
  });
  return info;
}

// The /rename name Claude Code also keeps in <session folder>/custom-title.json ({"customTitle": "..."}).
export function customTitleFile(sessionFolder) {
  const rec = tryParse(readHeadText(path.join(sessionFolder, "custom-title.json"), 4096));
  return rec && typeof rec.customTitle === "string" ? rec.customTitle : "";
}
