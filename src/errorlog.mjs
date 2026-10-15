// A silent hook must leave a trace somewhere, or a failure is invisible: one line per problem in
// <config>/session-tidy/errors.log, cut to its newest 16 KB once it passes 32 KB. It holds messages, never
// session text.
import fs from "node:fs";
import path from "node:path";
import { tidyDir } from "./config.mjs";

const LIMIT = 32 * 1024;
const KEEP = 16 * 1024;

export const errorLogFile = (env) => path.join(tidyDir(env), "errors.log");

export function logError(env, message, now = Date.now()) {
  try {
    const file = errorLogFile(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = `${new Date(now).toISOString()} ${String(message).replace(/\s+/g, " ").slice(0, 500)}\n`;
    let old = "";
    try { old = fs.readFileSync(file, "utf8"); } catch { /* first line */ }
    let text = old + line;
    if (text.length > LIMIT) text = text.slice(text.length - KEEP).replace(/^[^\n]*\n/, "");
    fs.writeFileSync(file, text);
  } catch { /* a log that cannot be written must not break the hook */ }
}
