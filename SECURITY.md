# Security policy

## Supported versions

Security fixes go into the latest release on `main`.

## Reporting a vulnerability

Please do not report a vulnerability in a public issue. Use GitHub's private reporting: [https://github.com/nrzz/claude-session-tidy/security/advisories/new](https://github.com/nrzz/claude-session-tidy/security/advisories/new), or the contact in the [nrzz security policy](https://github.com/nrzz/.github/blob/master/SECURITY.md). You can expect a first answer within 72 hours, and credit in the release notes if you want it.

## What this tool can and cannot protect

It reads and writes files under Claude Code's config folder (`$CLAUDE_CONFIG_DIR`, or `~/.claude`) and under the working directory of the project you name, and nowhere else. It uses no model, opens no network connection and has no telemetry.

- **Reads:** the session transcripts (`projects/<folder>/<id>.jsonl`) to count prompts, find the title and the last use; the folder and file names that belong to a session; `settings.json` and a project's `.claude/settings*.json` for `cleanupPeriodDays`.
- **Writes:** `session-tidy/` in the config folder (the keep list, the trash, an error log, and after `init` a copy of the program); a transcript's modification time when you keep a session; and, only for `init` and `uninstall`, one hook entry in `settings.json`, as a text edit after a backup (`settings.json.bak-session-tidy-<time>`). A `settings.json` that is not valid JSON is left alone.
- **Deletes:** nothing, except `empty-trash --yes`, which removes the trash for good. Everything else moves files inside the config folder and `restore` moves them back.
- **A tampered trash:** a manifest is trusted only for paths below the folders sessions live in (`projects`, `file-history`, `session-env`, `uploads`, `tasks`, `todos`, `debug`, `usage-data`); `restore` refuses a manifest with any other path, an absolute path or `..`.
- **What it cannot do:** keep a session safe from something other than Claude Code's cleanup, protect files from you, or hide a transcript's text from anyone who can read your config folder. Titles of your sessions are shown by `list`, and `/session-tidy:list` puts up to 15 of them (and nothing else from a transcript) in front of the model when you ask it to.
