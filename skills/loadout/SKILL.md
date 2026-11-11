---
name: loadout
description: Show which Claude Code plugins are active per layer (global base, each account, project, local) as one condensed table. Use when the user asks what is loaded, what plugins are on, or types /loadout.
---

Call `mcp__overwatch__loadout` (no input). Without the tool, run:

```
${CLAUDE_PLUGIN_ROOT}/bin/overwatch loadout
```

Print the table verbatim in a code block. Columns left to right: `global`
(BASE in `~/.claude/setup-plugins.sh`, which it renders to
`~/.claude/managed-settings.json`), one column per account under
`~/.claude/` (root is `default`, `*` marks the account this session runs
under), then `project` and `local` from `./.claude/`. Rows sort widest
coverage first, so the shared base is on top and one-offs at the bottom.

Cells: `x` enabled in that layer, `/` inherited from global (active whether or
not the layer lists it), `*` global and also listed explicitly, `.` off.

The table may end with one `global not installed:` line when the installed
managed file under `/Library` differs from BASE. Print it as is.
Nothing else.
