# overwatch

Catches a coding agent misbehaving, records it, and makes the next session better.

```
/plugin install overwatch --marketplace yesitsfebreeze/overwatch
```

Any other agent: point it at [install.txt](install.txt).

## How it works

| step | what happens |
|---|---|
| catch | Refused: an edit before the plan has tasks and guards, a stop with work open, a call that does not fit a tool's schema. Noticed: a turn's failed tool calls. |
| record | One entry per catch in `.overwatch/incidents.json`: counts per day for 30 days, the newest 40 entries. `mistake` adds a lesson by hand. |
| improve | A kind caught 3 times in 30 days puts its one-line lesson into every later session's prompt, beside the newest 5 mistakes and the learned tool triggers. It drops out as its days leave the window. |

## Parts

| part | does |
|---|---|
| plan | tasks and yes/no guards; edits wait for a plan, stops wait for done tasks, upheld guards and the review pass |
| incidents | the catch ledger |
| compaction | minifies tool results, folds old history into indexes, reads it back with `decompress` / `search_context` |
| followline | one line above the prompt: a mood face, then one gauge per slot (`$.followline.put`) |
| surface | tool-usage ledger, learned triggers, frozen checks, mistakes (`/overwatch`) |
| loadout | active plugins per layer (`/loadout`) |
| gardener | notices a nearly full disk, deletes only proven leftovers (`/gardener`) |
| hygiene | rates a repo's `skills/`, writes LEDGER.md, one GitHub issue per finding (`/hygiene`) |

Replaces tasksitter, componion, followline, steward, loadout, disk-gardener and skill-hygiene.

## Tools

Each is `mcp__overwatch__<name>`. A refusal says what to do next.

| tool | takes | does |
|---|---|---|
| `task_add` | `titles[]` | adds every task, or none |
| `task_start` | `task_id` | marks the task being worked |
| `task_progress` | `task_id`, `progress` 0–100 | sets the bar |
| `task_complete` | `task_id` | finishes a task |
| `task_replace` | `task_id`, `title` | retires the old task for a new one |
| `task_remove` | `task_id` | drops a task |
| `guard_add` | `question`, `check?`, `files?` | adds a guard |
| `guard_check` | `guard_id?` | runs the checks now, records the outcome |
| `guard_drop` | `guard_id` | removes a guard, on the user's word only |
| `plan_show` | | tasks, guards with last outcome, review state |
| `plan_clear` | | empties the plan |
| `decompress` | `id` | reads back a cut or folded message |
| `search_context` | `query` | searches every cut or folded message this session |
| `scan` | | discovers and freezes this repo's test/lint/build commands |
| `checks` | | frozen checks plus mistakes: run before saying "done" |
| `mistake` | `text` | records a lesson for every later session here |
| `status` | | git state, checks, catch counts, memory hogs |
| `report` | | tool usage, verdicts, triggers, newest catches |
| `rate` | `name`, `verdict`, `reason`, `trigger?` | rates the tool the "Evaluation due" question named |
| `loadout` | | active plugins per layer as one table |
| `hygiene_ledger` | `repo?` | lints and ranks a repo's skills, writes LEDGER.md |
| `disk` | `scope?`, `min_mib?` | surveys what can go; deletes nothing |
| `disk_clean` | `paths[]`, `apply?` | deletes surveyed leftovers, each judged again; dry run without `apply` |

## Tasks and guards

- **Plan first.** Every prompt reminds the model to add tasks and one guard per deliverable: a yes/no question, decided by a shell `check` (exit 0 = upheld) or, without one, judged by Jev. `Write`, `Edit`, `MultiEdit`, `NotebookEdit` and git-fs `write`/`edit` are refused until both exist. Questions and chat need no plan.
- **Stop.** Refused while a task is open, a guard is not upheld, or the review pass is due: 10+ changed lines without `/simplify`, 50+ without `/code-review` before it. A whole-file write or replace_all counts as 10+. Edits during the pass do not reopen it; new work does, sized by the lines changed since each skill last ran.
- **No loops.** Three refusals with nothing changed, or eight since the user last spoke, let the stop through. Background work or a cron pauses the check.
- **Judge.** Needs `TYPESAFE_API_KEY`. Without it only guards with a `check` hold the stop.
- **Limits.** Only the edit tools are gated; writes through Bash or kern `fs` are not seen. `plan_clear`, `guard_drop` and `task_remove` are open to the model: "only the user drops a guard" is not enforced. Checks run from the session's start directory.

## Disk gardener

- **Watch.** One `df` at most every 5 minutes. From `diskFullPercent` (default 88, 0 = off) the agent is asked once per crossing to free space, this project first.
- **Proof.** `node_modules` needs its `package.json`, `target` its `CACHEDIR.TAG` or manifest, `.venv` its `pyvenv.cfg`; `dist`, `build`, `out`, `coverage` only where git ignores the folder and tracks nothing in it.
- **Classes.** Leftover: an idle temp entry, or output of a project whose last commit is 30 days old. Rebuildable: proven output of a live project. In use: changed in the last 2 hours, or a process works there. Unverified: everything else. Only the first two are deleted.
- **Deleting.** `disk_clean` judges each path again, refuses links and open files, then runs `rm -rf --`. Caches go only through their owner's command.
- **Limits.** Needs `find`, `du`, `df`, `git`, `lsof`: no Windows. Without `lsof` only the 2-hour rule protects a folder in use.

## State

Plain files in `.overwatch/` in the working directory; the agent asks once to gitignore it.

| file | what |
|---|---|
| `incidents.json` | the incident ledger |
| `surface.json` | tool and binary counts, verdicts, triggers |
| `checks.json`, `mistakes.md` | frozen checks, recorded mistakes |
| `disk.json` | last survey per scope, deletions, the user's `keep` and `owners` lists |
| `plan.json` | tasks and guards outside Claude Code (which keeps them per session) |
| `context/<session>/` | originals of cut and folded messages |
| `status/<session>.json` | compaction's status, read by kern's turn deck |

Outside it: search-guard's `<XDG_STATE_HOME>/overwatch/guard.log` (read by `status`) and the shared Jev dataset `~/.jev/log/`.

## Needs and settings

- `bun`: compaction and `bin/overwatch`.
- `TYPESAFE_API_KEY` in the shell profile, never in a settings file: compaction and judged guards.
- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`: the hooks module.
- `slots`: followline gauges and their order, default `componion,plan,kern`.
- Compaction: `toolResultMaxChars`, `keepRecentTokens`, `compactEveryTokens`, ….

## Layout

| path | role |
|---|---|
| `hooks/overwatch.ts` | the one hooks module: hooks the shared events once and calls each part. No part imports another's hooks |
| `hooks/catalog.ts` | declares every tool |
| `hooks/commands.ts`, `plan-hooks.ts`, `compaction.ts`, `followline.ts` | one file per part, registering only its own hooks |
| `hooks/plan.ts` | the plan's pure logic, run by `plan-hooks.ts` in Claude Code and `host/core.ts` elsewhere |
| `hooks/io.ts` | the one door to the machine: logic takes an `Io` (`$` in a hook, node in `bin/node-io.ts`) |
| `bin/overwatch` | every command from a terminal, plus `overwatch mcp` and `overwatch hook <host> <event>` |
| `skills/`, `data/` | the six skills; the surface seed |

Hot reload: with `claude --plugin-dir <this folder>` a saved change reloads the module and re-declares the tools; an installed copy is never watched. Each tool description ends in its schema hash, every tool result carries `overwatch tools v<version>`, and a call that does not fit the current schema is refused with it.

## Check

```sh
claude plugin validate .
claude plugin test .           # every part
bin/overwatch hygiene --selftest
bun test ./host/host.check.ts  # the core other agents run
claude --plugin-dir . -p hi --debug-file ow.log; grep "did not load" ow.log
```

## Other agents

Plan and command tools run from `host/core.ts`. No compaction, followline, tool-surface block or review pass; judged guards do not hold the stop; plan state is per project.

| agent | how | tools | reminder | edit gate | stop hold |
|---|---|---|---|---|---|
| Codex CLI | `.codex-plugin`, `adapters/codex` | MCP | every prompt | `apply_patch`, Edit, Write | Stop |
| pi | `package.json` "pi", `adapters/pi` | native | every run | edit, write | agent_before_settle |
| opencode 2.x | `adapters/opencode` | native | every request | permission `edit` | re-prompt on session.idle |
| Hermes Agent | `adapters/hermes` + MCP | MCP | every LLM call | write_file, patch | pre_verify (edit turns only) |
| Gemini CLI | `adapters/gemini` extension | MCP | every prompt | write_file, replace | AfterAgent |
| Copilot CLI | `.github/plugin`, `adapters/copilot` | MCP | session start only | edit, create | agentStop |
| Cursor | `.cursor-plugin`, `adapters/cursor` | MCP | session start only | Write | stop followup |
| Factory Droid | `adapters/droid` hooks + MCP | MCP | every prompt | Create, Edit, ApplyPatch | Stop |
