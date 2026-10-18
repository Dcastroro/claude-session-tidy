# claude-session-tidy

[![test](https://github.com/nrzz/claude-session-tidy/actions/workflows/test.yml/badge.svg)](https://github.com/nrzz/claude-session-tidy/actions/workflows/test.yml) [![e2e](https://github.com/nrzz/claude-session-tidy/actions/workflows/e2e.yml/badge.svg)](https://github.com/nrzz/claude-session-tidy/actions/workflows/e2e.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![node >= 18](https://img.shields.io/badge/node-%3E%3D18-339933.svg) ![dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen.svg) [![part of the Claude Code toolkit](https://img.shields.io/badge/Claude%20Code-toolkit-d97757.svg)](https://github.com/nrzz/claude-code-toolkit)

Claude Code cannot delete a session from inside, and it silently removes transcripts that have not been touched for `cleanupPeriodDays` (30 by default), with no warning, no trash and no restore. claude-session-tidy lists your sessions with their size and the day that cleanup will remove each one, moves the ones you do not want to a trash you can restore from, keeps the ones you do want past the cleanup, and finds empty and orphaned sessions. It is a plain Node program that runs outside Claude, so it costs no tokens.

## What you get

- `list`: every session of a project (or of all of them) with its short id, last activity, prompts typed, size on disk including its subagent, tool-result and file-history files, whether it is kept, the day the cleanup removes it, and its title.
- `delete <id...>` and `restore <id>`: sessions move to a trash with a manifest and come back exactly, so `claude --resume <id>` works again. `empty-trash --yes` is the only thing that deletes for good.
- `keep <id...>`, `unkeep <id...>` and `refresh`: a keep list that outlives the 30-day cleanup, because the cleanup goes by a file's modification time and a touch moves it.
- `init` and `uninstall`: a silent `SessionStart` hook that runs `refresh`, added to and taken out of `settings.json` without moving anything else in it.
- `tidy`: finds empty sessions, sessions of projects whose folder is gone, and sessions older than a number of days, shows the disk they take and moves them to the trash.
- A plugin, `session-tidy`, with one user-only skill, `/session-tidy:list`, and the same hook.

## What it costs in tokens

| Part | Tokens | |
| --- | --- | --- |
| The tool: every command, `--json`, `--markdown`, `tidy`, `refresh`, `init` | 0 | A separate Node process. It reads and writes local files and never calls Claude or the network |
| The `SessionStart` hook (from `init`, or the plugin's own) | 0 | `refresh --quiet` prints nothing at all, also when it fails (it writes a line to `session-tidy/errors.log` instead), so nothing is added to the session. It adds about 0.1 to 0.2 second to starting one (measured, below) |
| The skill in Claude's skill list | 0 | `/session-tidy:list` is user-only (`disable-model-invocation`). With the plugin loaded, the request Claude Code sent to the model had no trace of the plugin or the skill's description (checked with a fake server, `test/e2e-plugin.test.mjs`). `claude plugin details` still projects about 15 tokens "always-on" for the description; it counts it although the skill is user-only |
| `/session-tidy:list` | about 1,300 to 1,500, once | Going in: the skill text (a header line and 455 characters of instructions, about 140 tokens; `claude plugin details` estimates about 100) and the table for 15 sessions, 1,800 to 2,200 characters (about 450 to 550). Claude Code 2.1.295 on Windows hands the model the command as "run this first" (about 70 more tokens for the call); Claude Code 2.1.300 on Linux and macOS runs it itself and pastes the table into the skill text. Coming out: the table shown again, as the skill asks (the same 450 to 550), and at most 6 lines of advice (about 120). The table is capped: `--markdown` never prints more than 40 rows or about 60 lines, and the skill asks for 15. Token figures are characters divided by 4, an estimate, not a count by Claude's tokenizer. The free route is the same table in a terminal: `claude-session-tidy list` |

`--due` does not change the default skill command or its row cap. If you explicitly pass a filtered markdown report to a model, its header adds 19 characters in the example `(3 due within 7 days, of 41)` compared with `(3 of 41)`, or 25 with a limit, `(3 of 10 due within 7 days, of 41)`: about 5 or 6 extra input tokens by the same characters-divided-by-4 estimate. The CLI itself still costs 0 tokens.

`--title` also leaves the default skill command and row cap unchanged. A synthetic report with `--title stripe --limit 3` changes `(3 of 41)` to `(3 of 10 matching "stripe", of 41)`: 25 extra characters, about 6 input tokens by the same estimate, only if you explicitly pass that filtered report to a model. The header shows at most 70 characters of the search text; matching still uses the whole text. The CLI makes no model request.

## Install

**From a terminal**, with Node 18 or newer. There is nothing to install and no dependency:

```bash
npx -y github:nrzz/claude-session-tidy list
```

```bash
npx -y github:nrzz/claude-session-tidy tidy --dry-run
```

```bash
npx -y github:nrzz/claude-session-tidy keep 7ec217ec
```

```bash
npx -y github:nrzz/claude-session-tidy init
```

`claude-session-tidy` in the rest of this document means `npx -y github:nrzz/claude-session-tidy`, or `npm i -g github:nrzz/claude-session-tidy` once, or after `init` `node ~/.claude/session-tidy/app/bin/claude-session-tidy.mjs`.

**As a Claude Code plugin.** In Claude Code:

```text
/plugin install session-tidy@claude-code-toolkit
```

Then type `/session-tidy:list`. It lists the current project's 15 newest sessions, says in at most 6 lines which look worth deleting and which worth keeping, and changes nothing until you agree. The plugin also carries the silent hook, so a session you keep is touched again when a later session starts. Use the plugin's hook or `init`, not both: with both, `refresh` simply runs twice, which does no harm.

## Use

```text
claude-session-tidy list [--all | --project <dir>] [--sort age|size|prompts] [--due <days>] [--title <text>] [--limit <n>] [--json | --markdown]
claude-session-tidy delete <id...> [--dry-run] [--json]
claude-session-tidy restore [<id>] [--dry-run] [--json]
claude-session-tidy keep <id...> [--dry-run] [--json]
claude-session-tidy unkeep <id...> [--dry-run] [--json]
claude-session-tidy refresh [--quiet] [--dry-run] [--json]
claude-session-tidy tidy [--all | --project <dir>] [--empty] [--orphans] [--older <days>] [--dry-run] [--json]
claude-session-tidy empty-trash [--older <days>] [--yes] [--dry-run] [--json]
claude-session-tidy init [--dry-run] [--json]
claude-session-tidy uninstall [--dry-run] [--json]
```

An `<id>` is a session id, or its first 6 or more characters when that tells it from the others (the table shows 8, and more only where two sessions share their start). An ambiguous or unknown id is refused, and nothing is moved. By default a command looks at the sessions of the current folder (the ones whose recorded working directory is the folder or inside it); `--all` covers every project and `--project <dir>` another folder. `--json` prints one JSON document (errors too, as `{"ok": false, "error": ...}`). Exit codes: 0 done, 1 a problem you can fix (bad option, unknown id, a conflict), 2 an unexpected error. `CLAUDE_CONFIG_DIR` moves the config folder, as it does for Claude Code; colours stop with `NO_COLOR`.

### list

```text
$ claude-session-tidy list
Sessions in ~/work/shop (5, newest first)
Cleanup: 30 days without a change (cleanupPeriodDays is not set, so Claude Code's default applies).

  ID        LAST ACTIVITY     PROMPTS      SIZE  KEPT  SWEEP       TITLE
  42943cfa  2026-10-13 11:09       12    4.7 MB        2026-11-12  Fix login redirect loop
  7ec217ec  2026-10-06 11:28       41   20.7 MB        2026-11-05  Add Stripe webhooks
  f91306dd  2026-10-03 11:00        0     484 B        2026-11-02  (untitled session)
  75372192  2026-09-16 11:03        3    357 KB        2026-10-16  Spike: caching layer
  4da8ded7  2026-09-05 11:05        6    1.0 MB        exempt      Plan the Q4 migration

5 sessions, 26.8 MB on disk, counting each session's own subagent, tool-result and file-history files.
```

- **SWEEP** is the day Claude Code's cleanup removes the session: its file's modification time plus the period. `due` means that day has passed, so the next cleanup (when Claude Code is next started) removes it. `exempt` is a session started by Claude Desktop, which the cleanup skips. `paused` means Claude Code skips the whole cleanup until a settings problem is fixed (see below). The `Cleanup:` line says which setting applied.
- **KEPT** is `yes` for a session on the keep list. It still shows the day the cleanup would remove the session, because that is what happens if nothing refreshes it; a kept session that is `due` is flagged under the table.
- **LAST ACTIVITY** is the newest timestamp inside the transcript; the file's own modification time (which the cleanup uses) can differ, for example after a `keep` or a copy of the config folder.
- **TITLE** is the `/rename` name, else Claude's title, else the first prompt.
- `--title stripe` finds that text within the selected title, case-insensitively and literally (not as a regular expression). It filters before `--limit`, combines with `--all`, `--project`, `--sort` and `--due`, and works in text, JSON and markdown reports. Headers show matching, shown and total counts; JSON adds `title` and `matched` only when the filter is used. No matches is a successful empty report. Empty or whitespace-only text and a missing argument are usage errors with exit code 1.
- `--due 7` shows sessions whose cleanup is due within the next 7 days, including sessions already `due` and kept sessions. It excludes `exempt` and `paused` sessions, filters before `--limit`, and works with `--all`, `--json` and `--markdown`. The number of days must be a whole number of 1 or more.
- `--sort size` puts the biggest first and `--sort prompts` the longest conversations; `--limit 15` shows 15. `--markdown` prints the compact table the skill uses (at most 40 rows).

### delete and restore

```text
$ claude-session-tidy delete 75372192
Moved 1 session to the trash (357 KB):
  75372192  Spike: caching layer                                      1 file, 357 KB
The trash is ~/.claude/session-tidy/trash. Undo with: claude-session-tidy restore <id>

$ claude-session-tidy restore
✗ Which session? Give the id of one in the trash.
In the trash: 1 session
  75372192  Spike: caching layer                                      357 KB, moved 2026-10-15

$ claude-session-tidy restore 75372192
Restored 75372192-5ef3-4405-b699-d04ddc2ef9ec "Spike: caching layer" (1 item, 357 KB)
Its files were touched (1 file), because the next cleanup would have removed the session otherwise.
Resume it with: claude --resume 75372192-5ef3-4405-b699-d04ddc2ef9ec
```

`delete` moves the transcript and everything that belongs to it (see [How it works](#how-it-works)) to `<config>/session-tidy/trash/<id>/`, with a `manifest.json` that lists every original path. It never deletes outright, refuses a session on the keep list (run `unkeep` first), and warns when a session changed in the last 10 minutes because it may be open in Claude Code. `restore` puts everything back at the paths in the manifest, byte for byte with the same file times; it refuses, moving nothing, if something already sits at one of those paths. The one exception to "the same file times": a session that has used up half of its retention period or more is touched when it comes back, as `refresh` would, because otherwise the next cleanup could remove it moments after you restored it. If a move fails halfway (a file is locked because the session is open), everything already moved is moved back.

### keep, unkeep and refresh

```text
$ claude-session-tidy keep 7ec217ec
Kept 1 session (7 files touched):
  7ec217ec
The keep list is ~/.claude/session-tidy/keep.json.
Nothing refreshes them yet, so they are safe for one retention period only. Run: claude-session-tidy init   (or install the plugin).
```

Claude Code's cleanup goes by a file's modification time, so `keep` records the id in `session-tidy/keep.json` and touches the transcript and the files the cleanup judges one by one (tool results, older versions' todo files). `refresh` touches every kept session again, but only the ones that have used up half of their period: touching more often would buy nothing, and `claude --continue` picks the session with the newest file time (checked), so every touch moves a session to the front of that list. A session you keep with `keep <id>` is always touched at once. `refresh --quiet` prints nothing, whatever happens. Run it from a cron job, or let the hook do it: `init` adds it to your settings, the plugin ships it.

```text
$ claude-session-tidy refresh --dry-run
Would refresh 1 of 1 kept session
  7ec217ec  7 files

$ claude-session-tidy refresh
Refreshed 1 of 1 kept session
  7ec217ec  7 files

$ claude-session-tidy unkeep 7ec217ec
Took 1 session off the keep list: 7ec217ec
Their files keep the time they were last touched; the cleanup treats them like any other session again.
```

(That `refresh` was run when the kept session's files were 20 days old; for a session with more than half of its 30 days left it says `1 session left alone: used up less than half of its time.`)

```text
$ claude-session-tidy init
claude-session-tidy init
  config folder   ~/.claude
  copied bin/ and src/ into ~/.claude/session-tidy/app
  backed up settings.json to ~/.claude/settings.json.bak-session-tidy-20261015-120000
  settings.json: SessionStart hook added (other settings untouched)
  checked: the installed copy runs (version 1.1.0)

The hook runs `refresh --quiet` when a session starts. It prints nothing, so it costs no tokens.
Start a new Claude Code session (or run /hooks) so it picks the hook up.
```

`init` copies `bin/` and `src/` to `<config>/session-tidy/app/` (so the hook keeps working after `npx` forgets its cache) and adds one entry to `<config>/settings.json`: `{"type": "command", "command": "node", "args": ["<config>/session-tidy/app/bin/claude-session-tidy.mjs", "refresh", "--quiet"], "timeout": 10}` under `hooks.SessionStart`. The file is backed up first, and the entry is added as a text edit: your indentation, line endings, one-line arrays and key order stay as they are, and `uninstall` takes the entry out again and gives back **the same bytes** (a `settings.json` that was empty becomes `{}`, and an empty `"hooks": {}` goes with our entry). A `settings.json` that is not valid JSON, or whose `hooks` has the wrong shape, is left alone with the snippet to add by hand. `uninstall` also deletes the program copy; your keep list, trash and error log stay.

```text
$ claude-session-tidy uninstall
claude-session-tidy uninstall
  backed up settings.json to ~/.claude/settings.json.bak-session-tidy-20261015-120000-2
  removed 1 SessionStart hook from settings.json (other settings untouched)
  deleted ~/.claude/session-tidy/app
```

### tidy and empty-trash

```text
$ claude-session-tidy tidy --all --dry-run
Tidy: looked at 6 sessions in all projects
  ebe56ed1  orphan          Prototype the importer                        1.4 MB
  f91306dd  empty           (untitled session)                            484 B
Would move 2 sessions to the trash (1.4 MB).
Nothing was moved (--dry-run).
```

`tidy` looks for **empty** sessions (nothing typed in them), **orphans** (sessions of projects whose folder no longer exists on disk) and sessions **older** than `--older <days>` (by their last use inside the transcript, which survives a copied config folder), and without `--dry-run` moves them to the trash. With none of the three flags it looks for empty and orphaned sessions; name one or more to choose. It never moves a kept session or one changed in the last 10 minutes, and says how many it left alone. An orphan is only called an orphan when this machine can tell: a path in another system's spelling or on a drive that is not there right now is not judged. On Linux and macOS an unmounted disk looks like a missing folder.

```text
$ claude-session-tidy empty-trash
In the trash: 2 sessions, 1.2 MB
  59a9269a  Old experiment with queues                                914 KB, moved 2026-10-15
  75372192  Spike: caching layer                                      358 KB, moved 2026-10-15
Nothing was deleted. Run it again with --yes to delete these for good.

$ claude-session-tidy empty-trash --yes
Deleted for good: 2 sessions, 1.2 MB
  59a9269a  Old experiment with queues                                914 KB, moved 2026-10-15
  75372192  Spike: caching layer                                      358 KB, moved 2026-10-15
```

`empty-trash` lists what is in the trash and, with `--yes`, deletes it for good (`--older <days>` only those moved to the trash more than that many days ago; `--dry-run` beats `--yes`). Without `--yes` it deletes nothing and exits 1.

### The settings that decide the day

The day is the file's modification time plus `cleanupPeriodDays`, read from the user's `settings.json`, then the project's `.claude/settings.json`, then its `settings.local.json`, the last one that sets it winning (checked with the real Claude Code, see below). The project files count for the project Claude Code is started in, and the cleanup then applies that period to all projects' sessions, so `list` reads them for the folder you run it in (or `--project`). When a settings file is not valid JSON, or `cleanupPeriodDays` is not a whole number of 1 or more, Claude Code skips the whole cleanup; `list` says so and shows `paused`. Settings from an organisation's managed policy are not read.

## How it works

**What a session is.** `<config>/projects/<folder>/<id>.jsonl`, where the folder is the working directory with every character that is not a letter or digit turned into `-`. What else belongs to a session by its id, as found by listing file and folder names (never contents) in a real Claude Code config folder with 48 sessions, and in config folders the real binary (2.1.295) wrote in throwaway runs:

| Under the config folder | What it is | Seen in a real folder | What the cleanup does with it |
| --- | --- | --- | --- |
| `projects/<folder>/<id>.jsonl` | the transcript | yes | removes it when its file time is older than the period |
| `projects/<folder>/<id>/` | `subagents/`, `tool-results/`, `custom-title.json` | yes | removes it with the transcript; also judges each `tool-results` file by its own time, even for a session it keeps |
| `projects/<folder>/<id>.desktop-released.json` | the Desktop app's archive or delete marker | yes | removes it with the transcript |
| `file-history/<id>/` | file snapshots | yes | never removes it: left behind |
| `session-env/<id>/` | the session shell's environment | yes | never: left behind |
| `uploads/<id>/` | images and files you attached | yes | never: left behind |
| `tasks/<id>/` | the default task list of the session | no | never: left behind |
| `todos/<id>-agent-<id>.json` | older versions' todo list | no | removes it on its own age |
| `debug/<id>.txt` | the log of `claude --debug` | no (written by a debug run) | removes it on its own age |
| `usage-data/facets/<id>.json`, `usage-data/session-meta/<id>.json` | what `/insights` worked out | no | named in Claude Code's cleanup code; not run |

`delete` moves every one of these that exists, and only these: not `plans/`, `paste-cache/`, `shell-snapshots/`, `history.jsonl` or `sessions/` (the running processes), and not the project's `memory/` folder. I did not find a `todos/`, `debug/`, `tasks/` or `usage-data/` folder in the real config folder; they are in the list because Claude Code writes or sweeps them by session id (`claude --debug` wrote `debug/<id>.txt` in a throwaway run, and Claude Code's code names `tasks/<session id>/` as the default task list). The only other place that named session ids there was another tool's own index (`claude-code-handover-data`), which is not Claude Code's and is left alone.

**What the cleanup does** (Claude Code 2.1.295, measured with the real binary; `test/e2e-retention.test.mjs` repeats it):

- It runs in the background about 5 seconds after Claude Code starts working, at most once a day: it writes `<config>/.last-cleanup` when it is done, and a second start within the day removed nothing. `claude -p` runs it too, if it lives long enough. So a session whose day has come goes the next time Claude Code is started after that, which can be up to a day later than its day.
- It deletes a transcript when **the file's modification time** is older than the period. The timestamps inside the file play no part: a file with a fresh time and five-day-old records survived, an old file with fresh records did not. So "days until the cleanup" is the modification time plus the period, and touching the file moves it.
- Sessions started by Claude Desktop (`claude-desktop`, `claude-desktop-3p`, `local-agent` in the records' `entrypoint`) are skipped. Deleting one in the Desktop app writes `<id>.desktop-released.json` with `"reason": "delete"` and frees it at once; archiving writes `"archive"` and frees it a period after the marker was written. `desktopSessionCleanupPeriodDays`, when set, is a ceiling past which a desktop session goes like any other. Sessions started in a terminal (`cli`) or by `claude -p` and the SDK (`sdk-cli`) are not skipped.
- Besides sessions it removes, by age, old files in `backups/`, `debug/`, `file-transfers/`, `logs/`, `paste-cache/`, `plans/` (`*.md`), `shell-snapshots/` (`snapshot-*.sh`), `startup-perf/`, `statsig/` and `todos/`, and keeps the new ones. It left alone old files I put in `cache/`, `file-history/`, `ide/`, `session-env/`, `state/`, `tasks/`, `telemetry/`, `uploads/` and `usage-data/`, and everything under `session-tidy/`. Orphaned subagent worktrees, which Claude Code's settings description also names, I did not test.

**What `tidy` leaves for later.** Because the cleanup never removes `file-history/<id>/`, `session-env/<id>/`, `uploads/<id>/` and `tasks/<id>/`, they stay on disk after the cleanup removes the session. `delete` takes them along with the session; finding them for sessions that are already gone is on the [roadmap](ROADMAP.md).

**What it writes, and where.** Only `<config>/session-tidy/`: `keep.json` (`{"version": 1, "kept": {"<id>": {"since", "slug"}}}`), `trash/<id>/manifest.json` and `trash/<id>/files/<path under the config folder>`, `errors.log` (capped at 32 KB, one line per problem of the silent hook, no session text) and, after `init`, `app/`. It also sets file times when you keep a session or restore an old one, and `init` and `uninstall` edit `settings.json` as described. It writes a file so that a reader never sees half of it (a temporary name, then a rename).

**What it never does.** It never uses the network, never runs Claude, never deletes a session (only `empty-trash --yes` deletes anything), never touches a project's own files, and never rewrites your settings beyond its own hook entry.

### Privacy

claude-session-tidy runs only on your machine. It has no network code, no telemetry and no account, and sends nothing anywhere. It reads your session transcripts to count prompts, find titles and the last use, and `settings.json` files for `cleanupPeriodDays`. The only text from a transcript that ever reaches a model is what `/session-tidy:list` prints when you ask it to: up to 15 rows with the id, dates, sizes, the title (the first 60 characters, one line) and the project folder.

## What was verified, and how

The initial release was checked on 2026-10-15 on Windows 11 with Node 24.19 and Claude Code 2.1.295 (the binary bundled with the desktop app):

- **197 automated tests at the initial release** (`npm test`, Node's own runner, no dependencies; the runner also lists the 3 helper files under `test/` as passing, which are not counted). Without `E2E_CLAUDE`, 10 are skipped: the 9 that run the real binary, and 1 that needs a colon in a file name, which Windows does not allow. With `E2E_CLAUDE` pointing at Claude Code 2.1.295, 196 passed on this machine and that one was skipped. They run on synthetic config folders in temporary folders and never read `~/.claude`.
- **The due filter**, checked on macOS with Node 20.19.1 (`test/cli.test.mjs`): a fixed clock and synthetic sessions check the exact cutoff and the moments on either side, overdue, kept, exempt and paused sessions, filtering before limits for every sort, project scope, full JSON rows, text and markdown headers, and unchanged files. These checks do not run Claude Code.
- **The title filter**, checked on Windows with Node 24.20.0 (`test/title-filter.test.mjs`): six tests cover title-file and transcript rename precedence, AI-title and prompt fallbacks, literal case-insensitive matching, project scope, every sort, filtering before limits, combination with `--due`, JSON counts, empty results, invalid input, safe headers, the markdown row cap and unchanged synthetic files. A child process checks CLI exit codes. No real sessions or Claude Code binary are used.
- **Repository checks** compare logical text across LF and CRLF checkouts, retain the intentional absence of `.gitattributes` required by plugin-directory validation, and verify both the plugin manifest and its PNG icon. Session-content and restore tests still compare their files byte for byte.
- **The cleanup, against the real binary** (`test/e2e-retention.test.mjs`, run with `E2E_CLAUDE` pointing at the binary; the same checks pass in CI on Linux and macOS with Claude Code 2.1.300): eight sessions of different kinds in a throwaway config with `cleanupPeriodDays: 1`. The binary was run until it wrote `.last-cleanup`. What `list` had predicted for each session (`due`, `scheduled`, `exempt`) is what happened: old files removed with their folders, a fresh file with old records kept, Claude Desktop sessions kept, a desktop session released by a `delete` or an old `archive` marker removed, `sdk-cli` removed, old `tool-results` removed even from a kept session, and the folders listed above left behind. The same file checks that a session touched by `keep` and `refresh` survives whole (transcript, tool results, subagents, title) while its untouched twin is removed, and that the trash and the keep list survive.
- **The hook** (same file): `init` in a throwaway config, then the real binary; the kept session's files were touched before the cleanup began, the twin was removed, nothing of the hook reached the model's request, and no error was logged. The plugin's own `hooks/hooks.json` does the same (`test/e2e-plugin.test.mjs`).
- **Delete, restore, resume** (`test/e2e-resume.test.mjs`): a real session written by the binary; after `delete`, `claude -p --resume <id>` answers "No conversation found" and makes no request; after `restore` every file is back byte for byte and `--resume` sends the first prompt, its answer and the new prompt (checked on what a fake server received). A restored session that was 20 days old is touched. `claude --continue` resumes the session whose file was touched last, not the one with the newest records inside (which is why `refresh` touches a session only when it must).
- **`settings.json` is yours** (`test/install.test.mjs`, `test/jsonedit.test.mjs`): 16 different files (2, 4 and tab indentation, Windows line endings, no final newline, one-line arrays, a byte-order mark, other hooks, the person's own `SessionStart` hooks) and 300 random ones come back byte for byte after `init` plus `uninstall`; the backup is the original; invalid JSON, comments, a trailing comma, `hooks` or `SessionStart` of the wrong kind are left alone with the snippet; a second `init` changes and backs up nothing; a stale entry of ours is replaced; the text edit is checked against the same change made to the parsed data before anything is written; 500 random documents parse the way `JSON.parse` does.
- **The trash** (`test/trash.test.mjs`): the whole config folder is the same, byte for byte and with file times, after delete plus restore; `--dry-run` changes nothing; a move that fails halfway (forced) is undone, also across two sessions; a restore with something in the way moves nothing; a manifest with `..`, an absolute path, a backslash, `:` or another top-level folder is refused; a session in two project folders moves and returns as one; a symbolic link inside a session is moved, not followed.
- **Safety nets** (`test/keep.test.mjs`, `test/tidy.test.mjs`, `test/cli.test.mjs`): a kept session is never deleted or tidied; an invalid `keep.json` is never overwritten and blocks deletes; ids shorter than 6 characters and ambiguous ones are refused; Windows paths with spaces, a project folder whose name starts like another's, a `settings.json` that is not valid JSON, titles with terminal control codes.
- **The plugin** (`test/e2e-plugin.test.mjs`): `claude plugin validate` passes, also with `--strict`; the skill's expansion carries the list command with the plugin folder and the project folder filled in (the form 2.1.295 on Windows hands over), or its output (the form 2.1.300 on Linux and macOS hands over), and no unexpanded variable. Installed from a throwaway local marketplace, `claude plugin details` reports the hook as "harness-only, no model context cost", under 30 tokens always-on (15 here) and about 100 on invoke.
- **Timings** (this machine, Windows 11 on an SSD; 1,000 synthetic sessions of about 130 KB each in 20 projects, 127 MB; medians of 3 runs, three series): 0.76 to 0.79 seconds for `list --all --limit 15`, 4.8 seconds for `list --all` (every transcript read in full), 0.19 seconds for the skill's command on one project of 20, and 0.12 to 0.17 seconds for the hook with 30 kept sessions, of which 0.07 seconds is starting Node.
- **Token figures** are character counts of the real output divided by 4: 22 lines and 1,786 characters for 15 sessions with ordinary titles, 2,159 with every title at the 60-character cap; the skill's expansion was 685 characters in the Windows check, with a short plugin path.

Not verified:

- Claude Code versions other than 2.1.295 on this machine. The `e2e` workflow installs the newest `@anthropic-ai/claude-code` on Linux and macOS on every push and every Monday, so a release that changes the cleanup fails there. On its first run, with 2.1.300, six of the seven checks then in it passed on both systems; the seventh, the skill's expansion, showed that 2.1.300 on Linux and macOS runs the skill's command itself where 2.1.295 on Windows hands the model an instruction to run it, and the check now accepts both.
- Organisation-managed settings (`managed-settings.json`, policy settings): not read. Claude Code's code skips the desktop exemption when policy sets the period; I did not run that.
- That the skill's `allowed-tools` line approves the `list` command without a prompt in a live session (it covers `list` only, so that `delete` and `keep` still ask you). A prompt could not be exercised without a model, and `-p` with an explicit `--permission-mode` returned nothing for a slash command.
- That the `/resume` picker orders sessions like `claude --continue` does (by the file's modification time); only `--continue` was checked.
- `/session-tidy:list` in a live conversation with a model: the expansion was checked, the model's reply was not.
- What the Claude Desktop app does when a session it started is moved to the trash: the cleanup's rules for such sessions were checked, the app's own session list was not, and it may still show an entry that `restore` has to bring back.
- The `usage-data/` files per session and the cleanup of orphaned worktrees, which Claude Code's code names and I did not run.

## Files

| Path | What it is |
| --- | --- |
| `bin/claude-session-tidy.mjs` | The command |
| `src/cli.mjs`, `src/render.mjs` | Option parsing, the commands, exit codes; the text, markdown and JSON reports |
| `src/config.mjs`, `src/sessions.mjs`, `src/transcript.mjs`, `src/overview.mjs` | Where Claude Code keeps things and the retention setting; finding sessions and what belongs to them; reading a transcript; the facts a row needs |
| `src/sweep.mjs` | When the cleanup removes a session, the Claude Desktop exemption, when a touch is needed |
| `src/trash.mjs`, `src/keep.mjs`, `src/tidy.mjs`, `src/errorlog.mjs` | The trash, delete and restore; the keep list, touching and refresh; empty, orphaned and old sessions; the hook's error log |
| `src/install.mjs`, `src/jsonedit.mjs` | `init` and `uninstall`; the editor that changes a JSON file by its text |
| `src/util.mjs`, `src/version.mjs` | Shared helpers; the version |
| `skills/list/SKILL.md` | `/session-tidy:list`, the user-only skill |
| `hooks/hooks.json` | The plugin's silent `SessionStart` hook |
| `.claude-plugin/plugin.json` | The plugin manifest |
| `test/` | `npm test`: unit tests on synthetic config folders, and the `e2e-*.test.mjs` checks against the real Claude Code (they skip without `E2E_CLAUDE`) |
| `.github/workflows/` | `test.yml` (Linux, macOS, Windows; Node 20, 22, 24, and 18 on Linux) and `e2e.yml` (the real binary, Linux and macOS, weekly) |

## Contributing

Issues and pull requests are welcome: start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [good first issues](https://github.com/nrzz/claude-session-tidy/issues?q=is%3Aopen+label%3A%22good+first+issue%22). Questions go to [Discussions](https://github.com/nrzz/claude-session-tidy/discussions); security reports go through [SECURITY.md](SECURITY.md).

## Part of the Claude Code toolkit

Small, dependency-free tools that make Claude Code cheaper, safer and easier to share, all in the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit):

- [claude-code-handover](https://github.com/nrzz/claude-code-handover): short sessions with a handover file every new session loads by itself
- [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync): share sessions, notes and team context with coworkers
- [claude-code-glow](https://github.com/nrzz/claude-code-glow): themes for the whole interface, a status line and a live HUD
- [claude-code-guardrails](https://github.com/nrzz/claude-code-guardrails): safety presets that stop risky commands and edits
- [claude-code-notify](https://github.com/nrzz/claude-code-notify): a ping when Claude needs you or finishes
- [claude-cost-guard](https://github.com/nrzz/claude-cost-guard): daily and weekly token budgets with zero-token warnings
- [claude-md-doctor](https://github.com/nrzz/claude-md-doctor): what your CLAUDE.md costs every session, and how to slim it
- [claude-code-starter-kits](https://github.com/nrzz/claude-code-starter-kits): a lean, safe .claude/ for your stack in one command
- [claude-session-replay](https://github.com/nrzz/claude-session-replay): search past sessions and export one as an HTML replay
- [claude-chat-ferry](https://github.com/nrzz/claude-chat-ferry): continue a Cursor or Antigravity chat in Claude Code, or hand a session to them
- [claude-permission-doctor](https://github.com/nrzz/claude-permission-doctor): why a permission prompt appeared, dead rules, rules from your history
- [claude-session-tidy](https://github.com/nrzz/claude-session-tidy): list, delete, keep and restore your sessions before the 30-day sweep
- [claude-hook-bench](https://github.com/nrzz/claude-hook-bench): run every hook with the JSON Claude Code sends, and see what each one does

Set up any of them, or all of them, from one page: `npx -y github:nrzz/claude-code-toolkit` opens it with the recommended tools switched on.

If one of them saves you tokens, a star on its repository helps other people find it, and following [@nrzz](https://github.com/nrzz) on GitHub shows you new tools and releases.

## License

MIT
