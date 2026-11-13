---
name: loadout
description: Show which Claude Code plugins are active per layer (global base, each account, project, local) as one condensed table. Use when the user asks what is loaded, what plugins are on, or types /loadout.
---


Call `mcp__overwatch__loadout` (no input), or run `${CLAUDE_PLUGIN_ROOT}/bin/overwatch loadout`. Print the table verbatim in a code block, nothing else; a trailing `global not installed:` line is part of it.

To read it, if asked:

- Columns: `global` (BASE in `~/.claude/setup-plugins.sh`), one per account under `~/.claude/` (root is `default`, `*` marks this session's account), then `project` and `local` from `./.claude/`.
- Rows: widest coverage first.
- Cells: `x` enabled in that layer, `/` inherited from global, `*` global and also listed explicitly, `.` off.
