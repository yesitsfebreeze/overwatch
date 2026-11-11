# overwatch

Context and tuning for Claude Code in one plugin. It replaces five plugins: componion, followline,
steward, loadout and skill-hygiene (goodesign's `hygiene` skill was a second copy of the same skill).

| part | was | what it does |
|---|---|---|
| compaction | componion | minifies every tool result, folds old history into append-only indexes (Jev grades each call), reads any folded message back with `mcp__overwatch__decompress` / `mcp__overwatch__search_context` |
| followline | followline | one line above the prompt: a mood face, then one gauge per slot that plugins publish through `$.followline.put` |
| steward | steward | tool-surface ledger, learned triggers, frozen verification checks, mistakes ledger (`/steward`) |
| loadout | loadout | one table of the active plugins per layer: global, account, project, local (`/loadout`) |
| hygiene | skill-hygiene | rates the skills in a repository's `skills/` folder, writes LEDGER.md, syncs one GitHub issue per finding (`/hygiene`) |

## Needs

- `bun` and `TYPESAFE_API_KEY` (in the shell profile, never in a settings file) for compaction.
- `python3` for steward, loadout and hygiene.
- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` for the hooks module (compaction and followline).

## Layout

- `hooks/overwatch.ts` is the plugin's one hooks module. It registers `followline.ts`, then
  `componion.ts`, so `$.followline.put` exists before anything publishes.
- `hooks/steward.json` holds steward's command hooks (SessionStart index, Stop tally).
- `skills/` holds `steward`, `loadout` and `hygiene`. `bin/` and `data/` hold steward's script and seed.

## Settings

`slots` (followline) sets the gauges and their order. The default is `componion,tasksitter,kern`.
The compaction settings (`toolResultMaxChars`, `keepRecentTokens`, `compactEveryTokens`, …) keep
componion's names and defaults. Compaction state still lives in `~/.claude/componion/`, so folds
from earlier sessions stay readable.

## Check

```sh
claude plugin validate .
claude plugin test .                       # compaction and followline
python3 tests/test_scan.py                 # steward
python3 skills/hygiene/hygiene.py --selftest
```

Codex support from the old plugins (`install/codex`, `.codex-plugin`) is not carried over yet.
