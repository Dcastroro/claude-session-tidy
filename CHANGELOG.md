# Changelog

All notable changes to claude-session-tidy are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-15

- First release: `list` (every session with its size including subagent, tool-result and file-history files, last activity, prompts, title, whether it is kept, and the day Claude Code's cleanup removes it, with the `cleanupPeriodDays` that applied), `delete` and `restore` through a trash with a manifest, `keep`, `unkeep` and `refresh` to hold sessions past the cleanup, `tidy` for empty, orphaned and old sessions, `empty-trash`, `init` and `uninstall` for a silent SessionStart hook (settings.json edited as text after a backup, byte for byte back after uninstall), `--json` everywhere, `--dry-run` wherever something is written.
- A plugin `session-tidy` with one user-only skill, `/session-tidy:list`, and the same hook.
- Checked against Claude Code 2.1.295: the cleanup goes by a file's modification time and not the timestamps inside it; it skips sessions started by Claude Desktop; it takes a session's folder along but leaves `file-history/`, `session-env/`, `uploads/` and `tasks/` behind; a touched session survives it; a deleted session cannot be resumed and a restored one resumes with its whole history. The checks run against the real binary in CI (`E2E_CLAUDE`), weekly.

[1.0.0]: https://github.com/nrzz/claude-session-tidy/releases/tag/v1.0.0
