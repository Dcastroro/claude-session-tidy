// Running the real claude binary at zero cost, for the checks that need it (test/e2e-*.test.mjs).
//
// A check runs only when E2E_CLAUDE names a Claude Code binary ("claude" on a CI machine after
// `npm install -g @anthropic-ai/claude-code`, or the full path to claude.exe). Otherwise it is skipped, and
// `npm test` needs nothing but Node. The binary runs in a throwaway folder with its own config folder and home,
// with an environment scrubbed of every CLAUDE_* and ANTHROPIC_* variable of the machine, and with
// ANTHROPIC_BASE_URL pointing at a tiny server on 127.0.0.1 that answers with fixed text. No request leaves the
// machine, no token is spent, no login is needed.
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { projectSlug } from "../src/config.mjs";
import { tmpDir, runCli } from "./helpers.mjs";

export const CLAUDE = process.env.E2E_CLAUDE || "";

// { ok, version, reason }: whether E2E_CLAUDE is set and runs.
let info;
export function claudeInfo() {
  if (info) return info;
  if (!CLAUDE) return (info = { ok: false, version: "", reason: "E2E_CLAUDE is not set (point it at a claude binary to run the checks against the real thing)" });
  const home = tmpDir("cst-e2e-probe-");
  const r = spawnSync(CLAUDE, ["--version"], { encoding: "utf8", timeout: 60000, windowsHide: true, env: baseEnv({ CLAUDE_CONFIG_DIR: path.join(home, ".claude"), HOME: home, USERPROFILE: home }) });
  const version = (r.stdout || "").trim();
  info = r.status === 0 && version ? { ok: true, version, reason: "" } : { ok: false, version: "", reason: `E2E_CLAUDE (${CLAUDE}) did not run: ${(r.error && r.error.message) || (r.stderr || "").trim().slice(0, 120)}` };
  return info;
}
export const skip = () => (claudeInfo().ok ? false : claudeInfo().reason);

// The machine's environment without anything that could steer Claude Code (an API key, a base URL, the app that
// launched this test), plus `extra`.
function baseEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC|CLAUDECODE|AI_AGENT)/i.test(k)) env[k] = v;
  return { ...env, DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", NO_COLOR: "1", ...extra };
}

// A throwaway world for the binary: home, config folder and a project folder that Claude Code already trusts.
export function sandbox(label) {
  const root = tmpDir(`cst-e2e-${label}-`);
  const home = path.join(root, "home");
  const cfg = path.join(root, "cfg");
  const work = path.join(root, "work");
  for (const d of [home, cfg, work]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(cfg, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: { [work]: { hasTrustDialogAccepted: true, allowedTools: [] } } }));
  const slug = projectSlug(work);
  const sb = {
    root, home, cfg, work, slug, proj: path.join(cfg, "projects", slug),
    // the environment for our own CLI
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: cfg, NO_COLOR: "1" },
    tidy: (args, opts = {}) => runCli(args, { cwd: sb.work, env: sb.env, ...opts }),
    file: (...p) => path.join(cfg, ...p),
  };
  return sb;
}

export function put(file, text = "x", mtimeMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtimeMs !== undefined) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}

// --- the fake Messages API -----------------------------------------------------------------------

const head = (j, n) => ["message_start", { type: "message_start", message: { id: `msg_${n}`, type: "message", role: "assistant", model: j.model || "x", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }];
export const textReply = (j, n, text) => [head(j, n),
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
  ["message_stop", { type: "message_stop" }]];

// A server that records every request and answers with text. `reply(request, n)` can return other events;
// `delayMs` holds each answer back (the cleanup starts about 5 seconds after Claude Code does, so a run that
// must see it has to last longer than that).
export function fakeApi({ reply = (j, n) => textReply(j, n, "ANSWER-ONE"), delayMs = 0 } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (!req.url.includes("/v1/messages")) { res.writeHead(404); res.end("{}"); return; }
      let j = {};
      try { j = JSON.parse(body); } catch { /* an empty probe request */ }
      requests.push(j);
      const events = reply(j, requests.length);
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const [ev, data] of events) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
        res.end();
      }, delayMs);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => { server.unref(); resolve({
    port: server.address().port,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  }); }));
}

// Runs the binary in the sandbox's project folder. `untilFile`: stop it (a second and a half after) once that
// file exists. Resolves { code, out, err }.
export function runClaude(sb, api, args, { timeout = 120000, untilFile, env = {} } = {}) {
  return new Promise((resolve) => {
    const childEnv = baseEnv({ CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, USERPROFILE: sb.home, ANTHROPIC_API_KEY: "sk-ant-probe", ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`, ...env });
    const p = spawn(CLAUDE, args, { cwd: sb.work, env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    p.stdout.on("data", (c) => { out += c; });
    p.stderr.on("data", (c) => { err += c; });
    const killer = setTimeout(() => p.kill(), timeout);
    let poll;
    if (untilFile) poll = setInterval(() => { if (fs.existsSync(untilFile)) { clearInterval(poll); setTimeout(() => p.kill(), 1500); } }, 250);
    p.on("close", (code) => { clearTimeout(killer); clearInterval(poll); resolve({ code, out, err }); });
  });
}

// What a fake API request carried, as one string, for "did the history arrive" checks.
export const messagesOf = (request) => JSON.stringify((request && request.messages) || []);
