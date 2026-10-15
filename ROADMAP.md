# Roadmap

What could come next. None of it is promised; all of it is open to contributors. Comment on an issue or start a [discussion](https://github.com/nrzz/claude-session-tidy/discussions) before a large change.

- `list --due <days>`: only the sessions Claude Code's cleanup will remove within that many days, the list you want before you decide what to keep.
- `tidy --leftovers`: the folders the cleanup leaves behind when it removes a session (`file-history/<id>/`, `session-env/<id>/`, `uploads/<id>/`, `tasks/<id>/`). They are never removed by age, so they grow forever; this would move them to the trash like any session.
- Read the organisation's managed settings (`managed-settings.json`) for `cleanupPeriodDays`; only the user's, the project's and its local settings files are read today.
