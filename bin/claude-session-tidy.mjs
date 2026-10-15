#!/usr/bin/env node
// claude-session-tidy: list, delete, keep and restore your Claude Code sessions.
// All the work lives in src/cli.mjs; run `claude-session-tidy --help` for the commands.
import { main } from "../src/cli.mjs";

// `claude-session-tidy list | head` closes the pipe early: that is not an error.
process.stdout.on("error", (e) => { if (e && e.code === "EPIPE") process.exit(0); throw e; });

process.exitCode = await main(process.argv.slice(2));
