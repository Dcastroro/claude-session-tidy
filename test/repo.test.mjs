import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";
import { COMMANDS } from "../src/cli.mjs";
import { VERSION } from "../src/version.mjs";

// Git may check out repository text with CRLF on Windows; compare its logical content.
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");
const json = (...p) => JSON.parse(read(...p));
const pkg = json("package.json");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, "/");
const sources = ["bin", "src", "test"].flatMap((d) => walk(path.join(ROOT, d))).filter((f) => /\.m?js$/.test(f));

// The specifiers of the static imports at the top of a module. Our files keep their imports together before
// any code, so reading stops at the first other statement.
function headerImports(code) {
  const out = [];
  let buf = "";
  for (const line of code.split("\n")) {
    const t = line.trim();
    if (!buf) {
      if (!t || t.startsWith("//") || t.startsWith("#!")) continue;
      if (!/^import\b/.test(t) && !(/^export\b/.test(t) && /\bfrom\b/.test(t))) break;
    }
    buf += ` ${t}`;
    const m = /^\s*(?:import|export)\b.*?\bfrom\s*["']([^"']+)["'];?\s*$|^\s*import\s*["']([^"']+)["'];?\s*$/.exec(buf);
    if (m) { out.push(m[1] || m[2]); buf = ""; }
  }
  return out;
}

// --- package ------------------------------------------------------------------------------------

test("package.json: name, version, module type, bin, engines, scripts, links, license", () => {
  assert.equal(pkg.name, "claude-session-tidy");
  assert.equal(pkg.version, "1.1.0");
  assert.equal(pkg.type, "module");
  assert.deepEqual(pkg.bin, { "claude-session-tidy": "bin/claude-session-tidy.mjs" });
  assert.equal(pkg.engines.node, ">=18");
  assert.equal(pkg.scripts.test, "node --test");
  assert.equal(pkg.repository, "github:nrzz/claude-session-tidy");
  assert.equal(pkg.homepage, "https://github.com/nrzz/claude-session-tidy#readme");
  assert.equal(pkg.bugs, "https://github.com/nrzz/claude-session-tidy/issues");
  assert.equal(pkg.author, "Naresh Prabu");
  assert.equal(pkg.license, "MIT");
  assert.ok(pkg.description.length > 60);
  for (const k of ["claude-code", "sessions", "transcript", "cleanup", "retention", "disk-space", "backup"]) assert.ok(pkg.keywords.includes(k), k);
  assert.ok(fs.existsSync(path.join(ROOT, pkg.bin["claude-session-tidy"])));
});

test("the version is the same in the package, the code and the plugin", () => {
  assert.equal(VERSION, pkg.version);
  assert.equal(json(".claude-plugin", "plugin.json").version, pkg.version);
  assert.match(read("CHANGELOG.md"), new RegExp(`^## \\[${pkg.version.replace(/\./g, "\\.")}\\] - 2026-10-15$`, "m"));
});

test("the published files exist, and nothing outside the package is listed", () => {
  for (const f of pkg.files) {
    assert.ok(!f.startsWith("/") && !f.includes(".."), f);
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is listed in files but missing`);
  }
  for (const f of ["bin", "src", "skills", "hooks", ".claude-plugin", "README.md", "LICENSE"]) assert.ok(pkg.files.includes(f), f);
  assert.ok(!pkg.files.includes("test"));
});

test("zero dependencies: no dependency fields, no lockfile, no node_modules, only node: and relative imports", () => {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "bundledDependencies"]) assert.equal(pkg[field], undefined, field);
  for (const f of ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "node_modules"]) assert.ok(!fs.existsSync(path.join(ROOT, f)), `${f} must not exist`);
  assert.ok(sources.length >= 25);
  for (const file of sources) {
    const code = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(code, /\brequire\(/, `${rel(file)} is ESM`);
    const specifiers = [...headerImports(code), ...[...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1])];
    for (const spec of specifiers) {
      if (spec.startsWith("node:")) continue;
      assert.ok(spec.startsWith("."), `${rel(file)} imports "${spec}": only node: built-ins and relative files are allowed`);
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), spec)), `${rel(file)} -> ${spec} exists`);
    }
  }
});

test("headerImports reads multi-line imports and stops at the first code", () => {
  const code = '#!/usr/bin/env node\n// comment\nimport fs from "node:fs";\nimport {\n  a,\n  b,\n} from "./x.mjs";\nimport "./side.mjs";\nexport { c } from "./y.mjs";\nconst text = `\nimport z from "not-me";\n`;\n';
  assert.deepEqual(headerImports(code), ["node:fs", "./x.mjs", "./side.mjs", "./y.mjs"]);
});

test("the code stays within what Node 18 has", () => {
  const newer = [/\.toSorted\(/, /\.toReversed\(/, /\.toSpliced\(/, /\.with\(\d/, /Object\.groupBy/, /Map\.groupBy/, /Array\.fromAsync/, /Promise\.withResolvers/, /\.isWellFormed\(/, /import\.meta\.(dirname|filename)/, /process\.getBuiltinModule/, /\.union\(|\.intersection\(|\.difference\(/, /fs\.glob\(/, /readdirSync\([^)]*recursive/, /\.findLast\(/, /\.findLastIndex\(/];
  for (const file of sources.filter((f) => !rel(f).startsWith("test/repo.test"))) {
    const code = fs.readFileSync(file, "utf8").replace(/\/\/.*$/gm, "");
    for (const re of newer) assert.doesNotMatch(code, re, `${rel(file)} uses ${re}`);
  }
});

test("every module in src is used by something", () => {
  const all = sources.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  for (const f of fs.readdirSync(path.join(ROOT, "src"))) assert.ok(all.includes(`/${f}"`) || all.includes(`./${f}"`), `${f} is not imported anywhere`);
});

test("the command's entry file starts with a shebang and imports only the program", () => {
  const code = read("bin", "claude-session-tidy.mjs");
  assert.ok(code.startsWith("#!/usr/bin/env node\n"));
  assert.match(code, /import \{ main \} from "\.\.\/src\/cli\.mjs";/);
  assert.equal([...code.matchAll(/^import /gm)].length, 1);
});

test("repo housekeeping files", () => {
  assert.ok(!fs.existsSync(path.join(ROOT, ".gitattributes")), "the plugin directory validator rejects repositories with .gitattributes");
  assert.equal(read(".gitignore"), "node_modules/\n*.log\n.DS_Store\n");
  assert.match(read("LICENSE"), /^MIT License\n\nCopyright \(c\) 2026 Naresh Prabu\n/);
  for (const f of ["CODE_OF_CONDUCT.md", "CONTRIBUTING.md", "SECURITY.md", "SUPPORT.md", "ROADMAP.md", "CHANGELOG.md", ".github/PULL_REQUEST_TEMPLATE.md", ".github/dependabot.yml", ".github/ISSUE_TEMPLATE/bug_report.yml", ".github/ISSUE_TEMPLATE/feature_request.yml", ".github/ISSUE_TEMPLATE/config.yml"]) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  for (const f of ["SECURITY.md", "SUPPORT.md", "CONTRIBUTING.md", ".github/ISSUE_TEMPLATE/config.yml"]) assert.ok(read(f).includes("nrzz/claude-session-tidy"), `${f} links to this repository`);
  assert.ok(!/claude-code-handover|md-doctor/.test(read("SECURITY.md") + read("SUPPORT.md") + read("CONTRIBUTING.md") + read(".github/ISSUE_TEMPLATE/config.yml") + read(".github/ISSUE_TEMPLATE/bug_report.yml") + read(".github/ISSUE_TEMPLATE/feature_request.yml")), "no leftover name of the repository these were copied from");
});

test("CI runs the tests on Linux, Windows and macOS with Node 20, 22 and 24, and the real-binary checks on Linux and macOS", () => {
  const wf = read(".github", "workflows", "test.yml");
  for (const part of ["name: test", "ubuntu-latest", "windows-latest", "macos-latest", "node: [20, 22, 24]", "- run: npm test", "fail-fast: false", "node: 18"]) assert.ok(wf.includes(part), part);
  assert.match(wf, /actions\/checkout@v\d+/);
  assert.match(wf, /actions\/setup-node@v\d+/);
  const e2e = read(".github", "workflows", "e2e.yml");
  for (const part of ["name: e2e", "ubuntu-latest, macos-latest", "npm install -g @anthropic-ai/claude-code", "continue-on-error: true", "E2E_CLAUDE: claude", "test/e2e-retention.test.mjs", "test/e2e-resume.test.mjs", "test/e2e-plugin.test.mjs", "schedule:", "workflow_dispatch"]) assert.ok(e2e.includes(part), part);
  assert.ok(!e2e.includes("windows"));
});

// --- the plugin -----------------------------------------------------------------------------------

test("plugin.json describes one plugin named session-tidy, and there is no marketplace.json (the hub lists it)", () => {
  const p = json(".claude-plugin", "plugin.json");
  assert.equal(p.name, "session-tidy");
  assert.equal(p.displayName, "Session Tidy");
  assert.deepEqual(p.author, { name: "Naresh Prabu" });
  assert.equal(p.license, "MIT");
  assert.equal(p.homepage, "https://github.com/nrzz/claude-session-tidy");
  assert.equal(p.repository, "https://github.com/nrzz/claude-session-tidy");
  assert.equal(p.privacyPolicyUrl, "https://github.com/nrzz/claude-session-tidy#privacy");
  assert.ok(p.description.length > 60);
  for (const k of ["sessions", "transcript", "cleanup", "retention", "disk-space", "backup"]) assert.ok(p.keywords.includes(k), k);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, ".claude-plugin")).sort(), ["icon.png", "plugin.json"]);
  const icon = fs.readFileSync(path.join(ROOT, ".claude-plugin", "icon.png"));
  assert.deepEqual(icon.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), "the plugin icon is a PNG");
});

test("the plugin's hook is one silent SessionStart entry that runs refresh --quiet from the plugin folder", () => {
  assert.deepEqual(json("hooks", "hooks.json"), {
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/bin/claude-session-tidy.mjs", "refresh", "--quiet"], timeout: 10 }] }] },
  });
});

test("the skill is user-only, with a short description, one command and a short reply; only list is pre-approved", () => {
  const text = read("skills", "list", "SKILL.md");
  const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  const fields = Object.fromEntries(front.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
  assert.equal(fields.name, "list");
  assert.equal(fields["disable-model-invocation"], "true");
  assert.ok(fields.description.length < 60, `description is ${fields.description.length} characters`);
  assert.equal(fields["allowed-tools"], 'Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/claude-session-tidy.mjs" list *) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/claude-session-tidy.mjs list *)');
  assert.ok(!/ (delete|keep|restore|tidy|empty-trash|init|uninstall) /.test(fields["allowed-tools"]), "delete and keep still ask");
  const [command, ...rest] = body.trim().split("\n\n");
  assert.equal(command, '!`node "${CLAUDE_PLUGIN_ROOT}/bin/claude-session-tidy.mjs" list --project "${CLAUDE_PROJECT_DIR}" --markdown --limit 15`');
  assert.match(rest.join("\n\n"), /at most 6 lines/);
  assert.match(rest.join("\n\n"), /Do nothing until the user agrees/);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "skills")), ["list"]);
  assert.ok(text.length < 900, `the skill stays small (${text.length} characters)`);
});

// --- the README -----------------------------------------------------------------------------------

const readme = read("README.md");

test("README follows the family template, in order", () => {
  const headings = [...readme.matchAll(/^## (.*)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, ["What you get", "What it costs in tokens", "Install", "Use", "How it works", "What was verified, and how", "Files", "Contributing", "Part of the Claude Code toolkit", "License"]);
  assert.match(readme, /^# claude-session-tidy\n\n\[!\[test\]\(https:\/\/github\.com\/nrzz\/claude-session-tidy\/actions\/workflows\/test\.yml\/badge\.svg\)\]\(https:\/\/github\.com\/nrzz\/claude-session-tidy\/actions\/workflows\/test\.yml\)[^\n]*license: MIT[^\n]*node >= 18[^\n]*dependencies: none[^\n]*\n\n/);
  assert.ok(readme.includes("### Privacy"), "plugin.json points at #privacy");
});

test("README: install commands, the token table, no emoji, no leftover placeholders", () => {
  for (const cmd of ["npx -y github:nrzz/claude-session-tidy list", "npx -y github:nrzz/claude-session-tidy init", "/plugin install session-tidy@claude-code-toolkit", "/session-tidy:list"]) assert.ok(readme.includes(cmd), cmd);
  const tokens = readme.split("## What it costs in tokens")[1].split("\n## ")[0];
  assert.match(tokens, /\| Part \| Tokens \| \|/);
  assert.match(tokens, /\| 0 \|/);
  assert.ok(!/\p{Extended_Pictographic}/u.test(readme), "no emoji in the README");
  assert.ok(!readme.includes("@@"), "every number was filled in");
  assert.ok(!/\bTODO\b|\bTBD\b/.test(readme));
});

test("README names every command and option the program has", () => {
  for (const [name, spec] of Object.entries(COMMANDS)) {
    assert.ok(readme.includes(`claude-session-tidy ${name}`), `README does not mention the command ${name}`);
    for (const flag of [...spec.bool, ...spec.value]) assert.ok(readme.includes(`--${flag}`), `README does not mention --${flag} (${name})`);
  }
  for (const word of ["CLAUDE_CONFIG_DIR", "NO_COLOR", "cleanupPeriodDays", "E2E_CLAUDE", "keep.json", "manifest.json", "settings.json.bak-session-tidy", "errors.log", "desktop-released", "--continue"]) assert.ok(readme.includes(word), `README does not mention ${word}`);
});

test("the help text and the README agree on what each command does", () => {
  const help = fs.readFileSync(path.join(ROOT, "src", "cli.mjs"), "utf8");
  for (const name of Object.keys(COMMANDS)) assert.ok(help.includes(`claude-session-tidy ${name}`), name);
});

test("README's file table lists every module and top-level folder that holds code", () => {
  const files = readme.split("## Files")[1].split("\n## ")[0];
  for (const f of ["bin/claude-session-tidy.mjs", "skills/list/SKILL.md", "hooks/hooks.json", ".claude-plugin/plugin.json", "test/", ".github/workflows/"]) assert.ok(files.includes(f), `Files does not list ${f}`);
  for (const f of fs.readdirSync(path.join(ROOT, "src"))) assert.ok(files.includes(f.replace(/\.mjs$/, "")), `Files does not mention src/${f}`);
});

test("the toolkit list names the twelve tools, the two new ones as the hub describes them", () => {
  const list = readme.split("## Part of the Claude Code toolkit")[1];
  for (const repo of ["claude-code-handover", "claude-code-team-sync", "claude-code-glow", "claude-code-guardrails", "claude-code-notify", "claude-cost-guard", "claude-md-doctor", "claude-code-starter-kits", "claude-session-replay", "claude-chat-ferry", "claude-permission-doctor", "claude-session-tidy"]) {
    assert.ok(list.includes(`[${repo}](https://github.com/nrzz/${repo})`), repo);
  }
  assert.ok(list.includes("claude-permission-doctor](https://github.com/nrzz/claude-permission-doctor): why a permission prompt appeared, dead rules, rules from your history"));
  assert.ok(list.includes("claude-session-tidy](https://github.com/nrzz/claude-session-tidy): list, delete, keep and restore your sessions before the 30-day sweep"));
  assert.ok(list.includes("a star on its repository helps other people find it"));
});

test("the README's claims about the checked version and the numbers it measured still match the checks", () => {
  assert.ok(readme.includes("Claude Code 2.1.295"));
  for (const f of ["test/e2e-retention.test.mjs", "test/e2e-resume.test.mjs", "test/e2e-plugin.test.mjs", "test/install.test.mjs", "test/jsonedit.test.mjs", "test/trash.test.mjs"]) {
    assert.ok(readme.includes(f), `${f} is cited`);
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
  }
  // a claim that names a number of cases is the number the test has
  assert.match(readme, /16 different files/);
  assert.match(read("test", "install.test.mjs"), /16 different files/);
  assert.match(readme, /300 random ones/);
  assert.match(read("test", "install.test.mjs"), /\(300 files\)/);
});
