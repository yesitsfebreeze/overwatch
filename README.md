# overwatch

overwatch catches a coding agent misbehaving, records it, and makes the next session better.
One plugin, one language (TypeScript), one binary (`bin/overwatch`), one core for every agent.

```
/plugin install overwatch --marketplace yesitsfebreeze/overwatch
```

## Catch, record, improve

| step | what happens | where |
|---|---|---|
| catch | a file edit before the plan has tasks and guards is refused; a stop with a task open, a guard failing or the review pass due is refused; a call that does not fit a tool's schema is refused; a turn's failed tool calls are noticed | `plan-hooks.ts`, `catalog.ts`, `compaction.ts`, `host/core.ts` |
| record | every catch is one entry in the incident ledger: kind and what was open. Counts per day for 30 days, the newest 40 entries. `mistake` adds a lesson by hand | `incidents.ts`, `.overwatch/incidents.json`, `.overwatch/mistakes.md` |
| improve | a kind caught 3 times in 30 days is a habit: its one-line lesson rides every later session's system prompt with the count, beside the newest 5 recorded mistakes and the learned tool triggers. A habit that stops drops out by itself as its days leave the window | `learned` in `surface.ts`, added by `commands.ts` |

`status` shows the counts in one line, `report` the counts and the newest catches. Other agents
record through the same core and get the lessons at session start.

## State

Everything overwatch writes sits in `.overwatch/` in the working directory (the project root
for other agents), nothing in the home folder:

| file | what |
|---|---|
| `incidents.json` | the incident ledger |
| `surface.json` | tool and shell-binary counts, verdicts, learned triggers |
| `checks.json`, `mistakes.md` | the frozen checks and the recorded mistakes |
| `plan.json` | tasks and guards, for agents other than Claude Code (which keeps them per session) |
| `context/<session>/` | originals of cut and folded messages, read back by `decompress` |

In a git repository that does not ignore `.overwatch/`, the agent is asked once per session to
add it to `.gitignore` (`io.ts`, `ignoreHint`; decided by `git check-ignore`). Plain files: read,
edit or delete them freely.

Two files of other plugins stay where those plugins look: kern's turn deck reads compaction's
status from `~/.claude/componion/status/<session>.json`, and `status` counts search-guard's
blocks from `<XDG_STATE_HOME>/overwatch/guard.log`. The Jev dataset (`~/.jev/log/`) is shared too.

## Parts

It replaces six plugins. Their names remain only where something outside reads them: kern's
status file, the `componion` gauge id and the Jev dataset's client name.

| part | was | what it does |
|---|---|---|
| plan | tasksitter | the request becomes tasks and yes/no guards; edits wait for a plan, every stop is refused until tasks are done, guards hold and the change went through `/simplify` (and `/code-review` when large) |
| incidents | new | the ledger above: every catch recorded, repeated habits fed back into the prompt |
| compaction | componion | minifies every tool result, folds old history into append-only indexes (Jev grades each call), reads any folded message back with `mcp__overwatch__decompress` / `mcp__overwatch__search_context` |
| followline | followline | one line above the prompt: a mood face, then one gauge per slot that plugins publish through `$.followline.put` |
| surface | steward | tool-surface ledger, learned triggers, frozen verification checks, mistakes ledger (`/overwatch`) |
| loadout | loadout | one table of the active plugins per layer: global, account, project, local (`/loadout`) |
| hygiene | skill-hygiene | rates the skills in a repository's `skills/` folder, writes LEDGER.md, syncs one GitHub issue per finding (`/hygiene`) |

## Tools

Each part's work is its own tool, `mcp__overwatch__<name>`, called directly rather than through a
skill and Bash. The skills stay for the judgement around them.

| tool | takes | does |
|---|---|---|
| `decompress` | `id` | reads back a cut or folded message by its id |
| `search_context` | `query` | searches every cut or folded message this session |
| `checks` | | frozen checks plus recorded mistakes, before saying a change is done |
| `scan` | | discovers and freezes this repo's test/lint/build commands |
| `status` | | git state, frozen checks, catches of the last 30 days, guard blocks, language servers over 500MB |
| `report` | | tool and binary usage, verdicts, learned triggers, catches with the newest entries |
| `rate` | `name`, `verdict`, `reason`, `trigger?` | rates the tool the "Evaluation due" question named; `useful` needs `trigger` |
| `mistake` | `text` | records a mistake for every later session in this directory and every checklist |
| `loadout` | | active plugins per layer as one table |
| `hygiene_ledger` | `repo?` | lints and ranks a repo's skills, writes LEDGER.md |

Every tool runs in-process (`hooks/commands.ts` calls the same functions `bin/overwatch` does);
a refusal (a `useful` rating without a trigger) is an error result.

### Hot reload and tool versions

Loaded from a watched folder, a saved change goes live in the running session: the engine
reloads the hooks module and runs `session.start` again, which re-declares every tool
(`hooks/catalog.ts`). An installed plugin, a directory marketplace's included, runs from a
copy and is never watched; for live changes start the session with the folder instead:

```sh
claude --plugin-dir ~/dev/claude-plugins/essentials/overwatch   # or CLAUDE_CODE_PLUGIN_DIRS
```

Every tool goes through one catalog, so no agent keeps calling a schema that changed under it:

- each tool's spec has a fingerprint and the catalog a version, both content hashes; a tool's
  description ends in its fingerprint (`(v1a2b3c4d)`);
- a reload that changes the catalog leaves one notice naming the tools changed, added and
  removed; it rides the next prompt or the next overwatch tool result, whichever comes first;
- every overwatch tool result carries `overwatch tools v<version>` as context beside it (the
  result itself is untouched: `decompress` answers text to be read back exactly);
- a call whose input does not fit the current schema (missing or unknown argument, wrong type,
  value outside the enum) is refused with the current schema before any part runs.

## Tasks and guards

The plan part (once tasksitter, itself merged from taskview and orly). Its tools are
`mcp__overwatch__<name>` like every other part's. What the agent reads is signed `[overwatch]`.

### How it behaves

- **Plan first.** Every prompt reminds the model to break work into tasks and
  to add one guard per deliverable: a yes/no question about the finished
  work, decided by a shell `check` (exit 0 = upheld) where one can, otherwise
  judged by Jev from the recorded turn. `Write`, `Edit`, `MultiEdit`,
  `NotebookEdit` and the git-fs `write`/`edit` tools are refused while the plan
  has no tasks or no guards. Questions and chat need no plan.
- **The view.** The plan draws nothing itself. It publishes one gauge,
  `tasks`, through followline (`$.followline.put`): overall progress, done
  count, upheld guards and the active task; red while a guard fails, green once
  everything holds. Its slot id is `plan`.
- **The stop.** Every stop runs the guard checks and the judge, then is
  refused (the turn continues) while any of these holds:
  1. a task is open;
  2. a guard is not upheld (the reason quotes the check's output tail);
  3. 10+ lines changed (`SMALL_CHANGE_LINES`; a whole-file write or a replace_all counts
     as 10+) and `/simplify` has not run since, or the change is large
     (`LARGE_CHANGE_LINES`, 50 changed lines summed over the edit-tool calls)
     and `/code-review` has not run since either (typed or through the Skill
     tool; `/review` counts as `/code-review`).
     Asked only once tasks and guards are clear, so the review sees finished
     work. Edits made during that pass do not reopen it; a task action that
     starts new work does.
- **No loops.** Three refusals with nothing changed, or eight refusals since
  the user last spoke, let the stop through with a toast (recorded as `gave up with work
  open`; a refused stop as `stop with work open`). Background work or a
  scheduled cron pauses the check. Everything fails open: a missing judge key
  or an unreachable judge never holds the stop.

### The tools

One flat tool per change, each `mcp__overwatch__<name>`. There's no `action` switch: the
model picks the tool by its name and description, and every schema names its own required
fields. Each tool owns its logic: a pure `run(plan, input)` beside its schema in `PLAN_TOOLS`,
except `guard_check` and `plan_show`, which run checks or read state through named handlers.

| tool | takes | does |
|---|---|---|
| `task_add` | `titles[]` | adds every task at 0%, or none when one title is empty |
| `task_progress` | `task_id`, `progress` 0–100 | sets the bar, `done` at 100 |
| `task_start` | `task_id` | marks the task being worked (▶ on the gauge) |
| `task_complete` | `task_id` | finishes a task |
| `task_replace` | `task_id`, `title` | retires the old task for a new one |
| `task_remove` | `task_id` | drops a task that no longer belongs |
| `guard_add` | `question`, `check?`, `files?` | adds a guard |
| `guard_drop` | `guard_id` | removes a guard, on the user's word only |
| `guard_check` | `guard_id?` | runs the guards' checks now and records the outcome |
| `plan_show` | | tasks, guards with their questions and last outcome, the review state |
| `plan_clear` | | empties the plan |

Refusals say what to do next (`no task #9; plan_show lists the task numbers`).

### Judge

Guards without a `check` are judged by Jev (TypeSafe) with the last turn
(request, tool calls, results, final message) and the files they name. Set
`TYPESAFE_API_KEY` in the environment Claude Code starts with. Without it only
guards with a `check` hold the stop; a toast says so once.

### Limits

- Only the edit tools (Write, Edit, MultiEdit, NotebookEdit, git-fs write/edit)
  are gated and mark the change for review. Writes through Bash or kern `fs`
  are not seen.
- `plan_clear`, `guard_drop` and `task_remove` are open to the model; "only the user drops a
  guard" is an instruction, not enforced.
- Guard checks run from the directory the session started in.

## Needs

- `bun` and `TYPESAFE_API_KEY` (in the shell profile, never in a settings file) for compaction.
- `TYPESAFE_API_KEY` also lets Jev judge guards that have no `check`.
- `bun` for `bin/overwatch` (the terminal and the skills' fallback).
- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` for the hooks module (compaction and followline).

## Layout

- `hooks/overwatch.ts` is the plugin's one hooks module and the only place parts meet. The
  engine takes one unmatched hook per event from a plugin (checked when the module loads), so
  the four events several parts share are hooked there, once, and call each part's handler:
  `tool.call` (count for the surface ledger, then minify), `turn.complete` (flush the counts,
  then fold when it pays), `prompt.submit` (reload notice, rating question, plan reminder) and
  `session.start` (declare the catalog, set up the plan). No part imports another part's hooks.
- Each part is one file that registers only its own matched hooks: `followline.ts`,
  `compaction.ts`, `commands.ts` (the command tools, the session block, call counting),
  `plan-hooks.ts`. `catalog.ts` holds the tool catalog every tool is declared through.
  `$` is only handed to function declarations, and `$.env.get` takes literal names (`io.ts`
  lists the ones read).
- `hooks/io.ts` is the one door to the machine: the logic (`surface.ts`, `incidents.ts`,
  `loadout.ts`, `hygiene.ts`) takes an `Io`, which is `$` in a hook and node in `bin/node-io.ts`.
- `hooks/plan.ts` is the plan's pure logic (tools, reminder, gate, stop verdict, check helpers);
  `plan-hooks.ts` runs it in Claude Code's engine, `host/core.ts` in every other agent.
- `hooks/incidents.ts` is the incident ledger: `incident($, kind, detail)` from a hook,
  `note(io, kind, detail)` from the core.
- `bin/overwatch` (bun) runs every command from a terminal: `status`, `scan`, `checks`,
  `mistake`, `report`, `index`, `rate`, `loadout`, `hygiene`. `data/` holds the surface seed.
- The session block (tool surface plus lessons) is added by `commands.ts` through `prompt.compose`,
  built once per session from the tools the session has, so a removed plugin's tools never show
  and the prompt cache stays warm.
- `skills/` holds `overwatch`, `plan`, `loadout`, `hygiene` and `verification-before-completion`.

## Settings

`slots` (followline) sets the gauges and their order. The default is `componion,plan,kern` (`componion` is the context gauge kern publishes).
The compaction settings (`toolResultMaxChars`, `keepRecentTokens`, `compactEveryTokens`, …) keep
their old names and defaults.

## Check

```sh
claude plugin validate .
claude plugin test .          # every part: compaction, followline, surface, incidents, tools, versions, tasks, hygiene
bin/overwatch hygiene --selftest
claude --plugin-dir . -p hi --debug-file ow.log; grep "did not load" ow.log   # the engine's load rules
```

## Other agents

The plan part (tasks, guards, edit gate, stop hold) and the command tools run in every major agent
from one core, `host/core.ts`, which reuses `hooks/plan.ts` (the pure plan logic split out of
`plan-hooks.ts`) and `hooks/commands.ts`. State is `.overwatch/plan.json` in the project root. Install for any agent: point it at [install.txt](install.txt).

| agent | how | tools | reminder | edit gate | stop hold |
|---|---|---|---|---|---|
| Claude Code | hooks module (this plugin) | native | full rules once, then one line per prompt | yes | yes, plus /simplify and /code-review |
| Codex CLI | `.codex-plugin`, `adapters/codex` | MCP | every prompt | `apply_patch`, Edit, Write | Stop |
| pi | `package.json` "pi", `adapters/pi` | native | every run | edit, write | agent_before_settle |
| opencode 2.x | `adapters/opencode` | native | every request | permission `edit` | re-prompt on session.idle |
| Hermes Agent | `adapters/hermes` + MCP | MCP | every LLM call | write_file, patch | pre_verify (edit turns only) |
| Gemini CLI | `adapters/gemini` extension | MCP | every prompt | write_file, replace | AfterAgent |
| Copilot CLI | `.github/plugin`, `adapters/copilot` | MCP | session start only | edit, create | agentStop |
| Cursor | `.cursor-plugin`, `adapters/cursor` | MCP | session start only | Write | stop followup |
| Factory Droid | `adapters/droid` hooks + MCP | MCP | every prompt | Create, Edit, ApplyPatch | Stop |

- `overwatch mcp` is the stdio MCP server; `overwatch hook <host> <event>` the command hook
  (`host/hooks.ts` maps each host's payload and answer shape).
- Outside Claude Code there is no compaction, followline, tool-surface block or review pass, and
  judged guards (no `check`) do not hold the stop. Plan state is per project, not per session.
  Catches are recorded the same way; the lessons ride the session start.
- Check: `bun test ./host/host.check.ts`.
