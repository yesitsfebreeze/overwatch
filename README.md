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
| plan | tasks and yes/no guards, see below |
| compaction | minifies tool results, folds old history into indexes, reads it back with `decompress` / `search_context` |
| followline | one line above the prompt: a mood face, then one gauge per slot (`$.followline.put`) |
| surface | tool-usage ledger, learned triggers, frozen checks, mistakes (`/overwatch`) |
| loadout | active plugins per layer (`/loadout`) |
| gardener | frees a nearly full disk, see below (`/gardener`) |
| launch | runs builds and other slow commands in the background, logs in `.overwatch/launch/` |
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
| `vault_init` | | creates the spec vault `.overwatch/vault` (Obsidian, git-tracked); never overwrites |
| `vault_plan` | | wave plan from the spec notes; regenerates Plan Tasks.md and Plan Data.json |
| `unit_new` | `title`, `category`, `tasks[]`, `summary?`, `depends?`, `checks?`, `paths?` | adds a spec note |
| `unit_load` | `unit` | the unit's open Plan items become tasks, its `checks` guards |
| `unit_record` | `summary`, `limitations`, `partial?` | closes the loaded unit: tasks done, checks re-run, tree committed; writes proof to the note |
| `prd_scan` | | every PRD in `02 PRDs`: state, acceptance boxes, units, review gate, why it is held |
| `prd_next` | `limit?` | the PRDs ready now, most important first |
| `prd_brief` | `prd` | one PRD's contract, needs, units, review gate and next step |
| `prd_add` | `title`, `summary?`, `acceptance[]?`, `needs[]?`, `footprint[]?`, `checks[]?`, `parent?`, `priority?` | adds a PRD note |
| `prd_refine` | `prd`, `children[]`, `summary?` | splits an open PRD into child PRDs; the parent becomes refine |
| `prd_set` | `prd`, `state`, `reason?` | open, question, refine, specced (needs a unit), blocked (needs a reason), failed |
| `prd_review` | `prd`, `score`, `reviewer`, `findings?` | records a review round bound to the current contract digest |
| `prd_collect` | `prd`, `summary?` | verifies every gate, then writes done, proof and the Collection receipt |
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
| `launch` | `command`, `wait?` | runs a command in the background, returns its id at once; `wait` blocks instead |
| `launched` | `id?` | background runs: running, exit code or gone; with `id`, the log tail |

## Tasks and guards

- **Plan first.** Every prompt reminds the model to add tasks and one guard per deliverable: a yes/no question, decided by a shell `check` (exit 0 = upheld) or, without one, judged by Jev. The edit tools (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, git-fs `write`/`edit`) are refused until both exist.
- **Stop.** Refused while a task is open, a guard is not upheld, or the review pass is due: 10+ changed lines without `/simplify`, 50+ without `/code-review` before it. A whole-file write or replace_all counts as 10+. Edits during the pass do not reopen it; new work does, sized by the lines changed since each skill last ran.
- **No loops.** Three refusals with nothing changed, or eight since the user last spoke, let the stop through. Background work or a cron pauses the check.
- **Limits.** Writes through Bash or kern `fs` are not seen. `plan_clear`, `guard_drop` and `task_remove` are open to the model: "only the user drops a guard" is not enforced. Checks run from the session's start directory.

## Spec vault

- **Units outlive the session.** `.overwatch/vault` is an Obsidian vault git tracks (ignore `.overwatch/*` and re-include `!.overwatch/vault/`). One note per unit under `01 Specs`: frontmatter `status`, `category`, `depends`, `checks`, `paths`, `prio`; a `## Plan` checklist of test-sized items. `00 Meta/Plan.md` documents the fields.
- **Plan.** A unit's wave is one more than its latest unfinished prerequisite's. Cycles, missing or excluded prerequisites, `blocked`, `deferred` and claims (`owner`) hold a unit. The Plan View plugin (shipped in the vault) renders `Plan Data.json`: effort on x, overlap is parallel work.
- **Closeout.** `unit_record` refuses while unit tasks are open, a unit check fails or the tree outside `.overwatch/` is dirty; the proof line names the commit and each guard's outcome.
- **Limits.** Dependencies are explicit `depends` only (the workflow kit also inferred them). Claims are read, not taken: two sessions can load the same unit.

## PRDs

- **Outcomes above units.** `.overwatch/vault/02 PRDs` holds one note per planned outcome: acceptance boxes, `needs` (other PRDs), `footprint`, `checks`, and a `## Specs` section of wiki links to the units that implement it. `00 Meta/PRD Template.md` is the scaffold; `prd_add` writes it.
- **Order.** Only `open` and `specced` can start; `question`, `refine`, `blocked` and `failed` are always held with their reason. `prd_next` lists the startable PRDs whose needs are resolved and that no one has claimed; `prd_scan` says why each other one is held. `prd_brief` reads one PRD whole without touching the vault by hand.
- **Refine.** `prd_refine` splits an open PRD into child PRDs one level down; the parent turns `refine` and stays the index.
- **Review gate.** An independent reviewer scores the contract 0–100 and `prd_review` records the round. The round is bound to a digest of the acceptance text, the PRD's own `checks` and every linked unit's Plan items and checks, so a later edit makes it stale; ticking a box or an item does not. 90 passes. Five rounds per PRD, then the allowance is spent and a PRD still below 90 is set `failed`.
- **Collect.** `prd_collect` refuses until needs are resolved (done, or refined with every child done), every acceptance box is ticked, every linked unit is `implemented` with its Plan items ticked, the last review round is fresh and ≥90, the tree outside `.overwatch/` is clean and every `checks` command exits 0 at HEAD. It then writes `status: done`, the proof line and the Collection receipt. It never marks work done on a worker's exit alone.
- **Limits.** No worker dispatch (`run`/`status`/`stop`), lanes or named-test `pass:` blocks from pearde; checks are whole-command exit codes. Claims are read, not taken.

## Disk gardener

- **Watch.** One `df` at most every 5 minutes. From `diskFullPercent` (default 88, 0 = off) the agent is asked once per crossing to free space.
- **Proof.** `node_modules` needs its `package.json`, `target` its `CACHEDIR.TAG` or manifest, `.venv` its `pyvenv.cfg`; `dist`, `build`, `out`, `coverage` only where git ignores the folder and tracks nothing in it.
- **Classes.** Leftover: an idle temp entry, or output of a project whose last commit is 30 days old. Rebuildable: proven output of a live project. In use: changed in the last 2 hours, or a process works there. Unverified: everything else. Only the first two are deleted.
- **Deleting.** `disk_clean` refuses links and open files, then runs `rm -rf --`. Caches go only through their owner's command.
- **Limits.** Needs `find`, `du`, `df`, `git`, `lsof`: no Windows. Without `lsof` only the 2-hour rule protects a folder in use.

## State

Plain files in `.overwatch/` in the working directory, beside `incidents.json`; the agent asks once to gitignore it.

| file | what |
|---|---|
| `surface.json` | tool and binary counts, verdicts, triggers |
| `checks.json`, `mistakes.md` | frozen checks, recorded mistakes |
| `disk.json` | last survey per scope, deletions, the user's `keep` and `owners` lists |
| `plan.json` | tasks and guards outside Claude Code |
| `context/<session>/` | originals of cut and folded messages |
| `status/<session>.json` | compaction's status, read by kern's turn deck |

Outside it: search-guard's `<XDG_STATE_HOME>/overwatch/guard.log` (read by `status`) and the shared Jev dataset `~/.jev/log/`.

## Needs and settings

- `bun`: compaction and `bin/overwatch`.
- `TYPESAFE_API_KEY` in the shell profile, never in a settings file: compaction and judged guards. Without it only guards with a `check` hold the stop.
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
