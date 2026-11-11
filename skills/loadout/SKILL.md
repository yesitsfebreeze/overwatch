---
name: loadout
description: Show which Claude Code plugins are active per layer (global base, each account, project, local) as one condensed table. Use when the user asks what is loaded, what plugins are on, or types /loadout.
---

Run:

```
python3 ${CLAUDE_PLUGIN_ROOT}/skills/loadout/loadout.py
```

Print the table verbatim in a code block. Columns left to right: `global`
(WANT in `~/.claude/setup-plugins.sh`, rendered to
`~/.claude/managed-settings.json`), one column per account under
`~/.claude/` (root is `default`, `*` marks the account this session runs
under), then `project` and `local` from `./.claude/`. Rows sort widest
coverage first, so the shared base is on top and one-offs at the bottom.

Cells: `x` enabled in that layer, `/` inherited from global (active whether or
not the layer lists it), `*` global and also listed explicitly, `.` off.

The script may append one `global not installed:` line when the installed
managed file under `/Library` differs from the rendered WANT. Print it as is.
Nothing else.
