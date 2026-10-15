# Contributing to claude-session-tidy

Thanks for helping. claude-session-tidy is a CLI and a Claude Code plugin with one user-only skill and a silent hook, part of the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit). The bar for a change is the bar the code already meets: it works on Windows, macOS and Linux, it is tested, it never deletes anything without a way back, and it never wastes anyone's tokens.

## Start here

- **Good first issues:** [the issues labelled good first issue](https://github.com/nrzz/claude-session-tidy/issues?q=is%3Aopen+label%3A%22good+first+issue%22), and the ideas in [ROADMAP.md](ROADMAP.md).
- **Questions and ideas:** [Discussions](https://github.com/nrzz/claude-session-tidy/discussions).
- **Bugs:** [open an issue](https://github.com/nrzz/claude-session-tidy/issues/new/choose) with the Claude Code version (`claude --version`), your OS, `node --version`, and the exact command and output. Never paste the text of a session.

## Set up

There is nothing to install: the project has no dependencies.

```bash
git clone https://github.com/nrzz/claude-session-tidy
cd claude-session-tidy
npm test
```

- `npm test` runs `node --test`. The checks that need the real Claude Code skip themselves; to run them, point `E2E_CLAUDE` at a binary: `E2E_CLAUDE=claude npm test`. They cost no tokens (see below).
- To try the program on made-up data, set `CLAUDE_CONFIG_DIR`, `HOME` and `USERPROFILE` to a temporary folder in the same command: `node bin/claude-session-tidy.mjs list --all`.

## Where things are

| Path | What it holds |
| --- | --- |
| `bin/claude-session-tidy.mjs` | the CLI |
| `src/` | one module per job: finding sessions and their files, the cleanup rules, the trash, the keep list, tidy, the settings.json editor, the reports |
| `skills/list/`, `hooks/` | the plugin's one user-only skill and its silent SessionStart hook |
| `test/` | unit tests on synthetic config folders, the real-binary checks (`e2e-*.test.mjs`) and their helpers |

## House rules

1. **No dependencies.** Node built-ins only, Node 18 or newer, ES modules (`.mjs`). A pull request that adds a package to `dependencies` will not be merged.
2. **Every change comes with a test**, and `npm test` passes. CI runs the suite on Windows, macOS and Linux with Node 20, 22 and 24, and on Linux with Node 18; a change that only works on one of them is not done.
3. **Nothing is deleted without a trash.** Sessions move to `session-tidy/trash/` and `restore` brings them back exactly; only `empty-trash --yes` deletes for good. Every command that writes has `--dry-run`.
4. **Token cost is a feature.** The CLI runs outside Claude; the skill is user-only and its report is capped. If your change puts anything new in front of Claude, say how many tokens in the pull request and update the README's "What it costs in tokens".
5. **Never touch real user data in tests.** Use a temporary folder and point `CLAUDE_CONFIG_DIR`, `HOME` and `USERPROFILE` at it. Tests never read `~/.claude/projects`; build synthetic transcripts instead (`test/synthetic.mjs`). The real-binary checks use a scrubbed environment and a fake server on 127.0.0.1, so they spend no tokens.
6. **Settings files are the user's.** If your change writes one: change only your own entry (as a text edit, so nothing else in the file moves), leave a file that is not valid JSON alone, and back up a user-level file before writing it.
7. **Keep the README honest.** Its "What was verified, and how" section says what was checked and what was not. If your change affects either, update it in the same pull request. Numbers in it come from runs, not from guesses.

## Pull requests

- One logical change per pull request, with its test. Commit messages in the imperative mood ("Add --due to list").
- Fill in the pull request template; CI must be green on every job.
- Signed commits are welcome but not required.
- Plain, specific writing in docs, messages and comments.

## Releases (maintainers)

Bump the version in `package.json`, `src/version.mjs` and `.claude-plugin/plugin.json` (`npm test` fails until every copy agrees), add a section to [CHANGELOG.md](CHANGELOG.md), tag `vX.Y.Z` and publish a GitHub release with the changelog section as its notes.

## Conduct and security

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue.
