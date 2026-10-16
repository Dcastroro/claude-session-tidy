// Small shared helpers: errors, number and date formatting, terminal-safe text, colours, file reading.
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

// A problem the person can fix (wrong id, bad option). Printed without a stack trace, exit code 1 by default.
export class UserError extends Error {}
export const fail = (message, exitCode = 1) => { throw Object.assign(new UserError(message), { exitCode }); };

export const DAY = 86400000;
export const MINUTE = 60000;

// Compares two strings by code unit: the same order on every machine, whatever its locale.
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------------------------
// Numbers, sizes, dates
// ---------------------------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, "0");
const num = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

// 950 -> "950 B", 12345 -> "12 KB", 4400000 -> "4.2 MB", 3e9 -> "2.8 GB".
export function size(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${n} B`;
  const kb = Math.round(n / 1024);
  if (kb < 1024) return `${kb} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}

// Local time for the person at the keyboard: 2026-10-15 09:30. JSON output uses UTC ISO strings instead.
export function localStamp(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
export const localDay = (ms) => localStamp(ms).slice(0, 10);

// 20261015-093012, local time, for backup names.
export function fileStamp(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

export const isoOf = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : "");

// ---------------------------------------------------------------------------------------------
// Text that came from a transcript and is about to be printed: titles, prompts, paths.
// ---------------------------------------------------------------------------------------------

// Colour sequences and other terminal control sequences, bidirectional overrides that make text read
// differently from how it is stored, and stray control characters.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g;

// One safe line: a crafted session title cannot drive the terminal it is printed in.
export function oneLine(s, max = 200) {
  const t = String(s ?? "").replace(ANSI, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(1, max - 1)).replace(/[\ud800-\udbff]$/, "") + "…";
}

// The last part of a path in either spelling, whatever the OS we run on ("C:\a\b" and "/a/b" give "b").
export function baseName(p) {
  return String(p ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
}

// ---------------------------------------------------------------------------------------------
// Colours: on for a terminal, off for pipes and when NO_COLOR is set. FORCE_COLOR switches them on anywhere.
// ---------------------------------------------------------------------------------------------

export function makeColors(env = process.env, isTTY = !!process.stdout.isTTY) {
  const forced = !!env.FORCE_COLOR && env.FORCE_COLOR !== "0";
  const on = forced || (isTTY && !env.NO_COLOR);
  const paint = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { on, bold: paint("1"), dim: paint("2"), red: paint("31"), green: paint("32"), yellow: paint("33"), cyan: paint("36") };
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export const tryParse = (text) => { try { return JSON.parse(text); } catch { return null; } };

export function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}
export function statOf(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}
export const exists = (p) => statOf(p) !== null;

// Sum of the sizes of a file, or of everything below a folder. Links are counted as links, never followed.
// Returns { bytes, files }.
export function measure(p) {
  const st = statOf(p);
  if (!st) return { bytes: 0, files: 0 };
  if (!st.isDirectory()) return { bytes: st.size, files: 1 };
  let bytes = 0;
  let files = 0;
  for (const e of listDir(p)) {
    const m = measure(path.join(p, e.name));
    bytes += m.bytes;
    files += m.files;
  }
  return { bytes, files };
}

// Every file below a folder (or the file itself), as absolute paths. Links are not followed.
export function filesUnder(p, out = []) {
  const st = statOf(p);
  if (!st) return out;
  if (!st.isDirectory()) { if (st.isFile()) out.push(p); return out; }
  for (const e of listDir(p)) filesUnder(path.join(p, e.name), out);
  return out;
}

// Calls fn(line) for every non-empty line of a UTF-8 file, reading it in pieces so a session of
// hundreds of megabytes never has to fit in memory. A byte-order mark and the "\r" of a Windows
// line ending are dropped. Stops when fn returns false. Returns false when the file cannot be opened.
export function forEachLine(file, fn, { chunk = 1 << 20 } = {}) {
  let fd;
  try { fd = fs.openSync(file, "r"); } catch { return false; }
  const buf = Buffer.allocUnsafe(chunk);
  const decoder = new StringDecoder("utf8");
  let pieces = []; // the unfinished last line, kept as pieces so a huge line is joined only once
  let first = true;
  const emit = (raw) => {
    let line = raw;
    if (first) { first = false; if (line.charCodeAt(0) === 0xfeff) line = line.slice(1); }
    if (line.endsWith("\r")) line = line.slice(0, -1);
    return line ? fn(line) : undefined;
  };
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      const text = decoder.write(buf.subarray(0, n));
      let start = 0;
      for (let nl = text.indexOf("\n", start); nl !== -1; nl = text.indexOf("\n", start)) {
        pieces.push(text.slice(start, nl));
        start = nl + 1;
        const line = pieces.length === 1 ? pieces[0] : pieces.join("");
        pieces = [];
        if (emit(line) === false) return true;
      }
      if (start < text.length) pieces.push(text.slice(start));
    }
    pieces.push(decoder.end());
    const last = pieces.join("");
    if (last) emit(last);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

// The first or last `bytes` of a file as text ("" when it cannot be read). A cut may land inside a
// multi-byte character or a line; callers only run patterns over it.
export function readHeadText(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString("utf8", 0, n);
  } catch { return ""; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function readTailText(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const total = fs.fstatSync(fd).size;
    const span = Math.min(bytes, total);
    const buf = Buffer.alloc(span);
    fs.readSync(fd, buf, 0, span, total - span);
    return buf.toString("utf8");
  } catch { return ""; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Writes a file so a reader never sees half of it: to a temporary name next to it, then a rename.
// A symbolic link (a dotfiles manager's settings.json) is written through, so the link stays a link.
export function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const st = statOf(file);
  if (st && st.isSymbolicLink()) { fs.writeFileSync(file, text); return; }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw e;
  }
}

// `base` if nothing is there yet, else `base-2`, `base-3` ...
export function uniquePath(base) {
  if (!exists(base)) return base;
  for (let i = 2; i < 1000; i++) if (!exists(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}

// The path with forward slashes, for output and for hook commands that must read the same everywhere.
export const forwardSlashes = (p) => String(p).replace(/\\/g, "/");
