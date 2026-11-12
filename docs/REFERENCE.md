# overwatch reference

Long-form detail behind the [README](../README.md). Per-host install steps live in [HOSTS.md](HOSTS.md).

## Catches

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
| changelog | one CHANGELOG.md section per version: current version from package.json, history from git (`changelog <what changed>`) |

## Tools

Each is `mcp__overwatch__<name>` in Claude Code, `overwatch_<name>` in pi and opencode, and the short `<name>` in every other host. A refusal says what to do next.

### Plan

| tool | takes | does |
|---|---|---|
| `task_add` | `titles[]` | adds every task, or none |
| `task_start` | `task_id` | marks the task being worked |
| `task_progress` | `task_id`, `progress` 0–100 | sets the bar |
| `task_complete` | `task_id` | finishes a task |
| `task_replace` | `task_id`, `title` | retires the old task for a new one |
| `task_remove` | `task_id` | drops a task |
| `guard_add` | `question`, `check?`, `files?`, `tier?`, `timeout_ms?` | adds a guard; tier is `fast`, `unit` or `milestone` |
| `guard_check` | `guard_id?`, `tier?`, `timeout_ms?` | runs the checks now, all or one tier, records the outcome |
| `guard_drop` | `guard_id` | removes a guard, on the user's word only |
| `plan_show` | `id?`, `offset?`, `limit?` | exact pages of all tasks, completed history, guards with evidence, and review state |
| `plan_clear` | | empties the plan |
| `changelog` | `what_changed?`, `version?`, `backfill?`, `file?`, `date?`, `lts?` | adds a bullet under the current version; `backfill` groups every commit by the version it saw; no arguments reports current, LTS and each version |

Routine reminders show counts and up to three open task and guard previews; completed titles and check commands stay in `plan_show`. Its response is `{id, offset, text, next_offset, total_chars}`. Append `text` unchanged and request the next page with the returned `id` and `offset: next_offset` until `next_offset` is `null`. Offsets count UTF-16 code units. The default limit is 6000 characters; escaped JSON pages remain below 7800 characters. A changed content revision refuses continuation: restart at offset 0 without `id`. Pages may split a command, so assemble the complete text before using it.

### Spec vault

| tool | takes | does |
|---|---|---|
| `vault_init` | | creates the spec vault `.overwatch/vault` (Obsidian, git-tracked); never overwrites |
| `vault_plan` | | wave plan from the spec notes; regenerates Plan Tasks.md and Plan Data.json |
| `unit_new` | `title`, `category`, `tasks[]`, `summary?`, `depends?`, `checks?`, `paths?` | adds a spec note |
| `unit_load` | `unit`, `owner?` | the unit's open Plan items become tasks, its `checks` guards; `owner` claims it |
| `unit_record` | `summary`, `limitations`, `partial?` | closes the loaded unit: tasks done, checks re-run, tree committed; writes proof and an evidence run |
| `unit_claim` | `unit`, `owner`, `takeover?` | claims a unit; a 15-minute-old claim, or one with no `since`, is stale and needs `takeover` |
| `unit_release` | `unit`, `owner` | releases the claim; only its owner may |
| `unit_next` | `owner` | loads and claims the first unit that can start now |
| `unit_verify` | `unit?`, `rerun?` | compares a recorded run with HEAD; `rerun` re-runs its checks |
| `vault_status` | | progress, claims, ready units, clashes, warnings |

### PRDs

| tool | takes | does |
|---|---|---|
| `prd_scan` | | every PRD in `02 PRDs`: state, acceptance boxes, units, review gate, why it is held |
| `prd_next` | `limit?` | the PRDs ready now, most important first |
| `prd_brief` | `prd` | one PRD's contract, needs, units, review gate and next step |
| `prd_add` | `title`, `summary?`, `acceptance[]?`, `needs[]?`, `footprint[]?`, `checks[]?`, `parent?`, `priority?` | adds a PRD note |
| `prd_refine` | `prd`, `children[]`, `summary?` | splits an open PRD into child PRDs; the parent becomes refine |
| `prd_set` | `prd`, `state`, `reason?` | open, question, refine, specced (needs a unit), blocked (needs a reason), failed |
| `prd_review` | `prd`, `score`, `reviewer`, `findings?` | records a review round bound to the current contract digest |
| `prd_collect` | `prd`, `summary?` | verifies every gate, then writes done, proof and the Collection receipt |

### Context and surface

| tool | takes | does |
|---|---|---|
| `decompress` | `id`, optional `offset`, `limit` | reads an exact bounded page; concatenate `text` and follow `next_offset` until null |
| `search_context` | `query` | searches every cut or folded message this session |
| `scan` | | discovers and freezes this repo's test/lint/build commands |
| `checks` | `tier?` | frozen checks plus mistakes: run before saying "done" |
| `mistake` | `text` | records a distinct lesson for bounded recent reminders |
| `mistakes` | `offset?`, `limit?`, `id?` | exact pages of the full original mistake history |
| `status` | | git state, checks, catch counts, memory hogs |
| `report` | | tool usage, verdicts, triggers, newest catches |
| `rate` | `name`, `verdict`, `reason`, `trigger?` | rates the tool the "Evaluation due" question named |
| `loadout` | | active plugins per layer as one table |
| `hygiene_ledger` | `repo?` | lints and ranks a repo's skills, writes LEDGER.md |

### Machine

| tool | takes | does |
|---|---|---|
| `disk` | `scope?`, `min_mib?` | surveys what can go; deletes nothing |
| `disk_clean` | `paths[]`, `apply?` | deletes surveyed leftovers, each judged again; dry run without `apply` |
| `launch` | `command`, `wait?` | runs a command in the background, returns its id at once; `wait` blocks instead |
| `launched` | `id?` | background runs: running, exit code or gone; with `id`, the log tail |

## Tasks and guards

- **Plan first.** Every prompt reminds the model to add tasks and at least one guard: a yes/no question, decided by a shell `check` (exit 0 = upheld) or, without one, judged by Jev. The edit tools (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, git-fs `write`/`edit`) are refused until both exist.
- **Stop.** On Claude Code, refused while a task is open, a guard is not upheld, or the review pass is due: 10+ changed lines without `/simplify`, 50+ without `/code-review` before it. Counts use actual net file differences, including whole-file writes and replace_all. Failed calls without changes add nothing; unmeasurable changes conservatively require both passes. Edits during the pass do not reopen it; new work does, sized by the lines changed since each skill last ran.
- **No loops.** Three refusals with nothing changed, or eight refused stops in one prompt (the ninth stop is let through). Background work or a cron pauses the check.
- **Limits.** Writes through Bash or kern `fs` are not seen. `plan_clear`, `guard_drop` and `task_remove` are open to the model: "only the user drops a guard" is not enforced. Checks run from the session's start directory.

## Spec vault

- **Units outlive the session.** `.overwatch/vault` is an Obsidian vault git tracks. One note per unit under `01 Specs`: frontmatter `status`, `category`, `depends`, `checks`, `paths`, `prio`; a `## Plan` checklist of test-sized items. `00 Meta/Plan.md` documents the fields.
- **Dashboard.** Dataview and Plan View ship enabled in the scaffold. `00 Meta/Dashboard.md` is a dataviewjs overview: completion tiles, completion and friction by area, highest friction, ready units, claims and held units, computed from the spec notes.
- **Plan.** A unit's wave is one more than its latest unfinished prerequisite's. Cycles, missing or excluded prerequisites, `blocked`, `deferred`, a claim (`owner`) and a note with every Plan item already ticked hold a unit, so `[start now]` means `unit_load` accepts it. The Plan View plugin (shipped in the vault) renders `Plan Data.json`: effort on x, overlap is parallel work. Two units that can start now clash when one path covers the other (`src/a` and `src/a/lex.ts`) or differs only in case; held units never clash.
- **Closeout.** `unit_record` refuses while unit tasks are open, a unit check fails or the tree is dirty outside `.overwatch/` (checked from the repository root, not the session's directory); the proof line names the commit and each check's outcome. The check commands are the ones `unit_load` kept from the note, so removing the plan's guards does not skip them. It also writes `.overwatch/evidence/<unit>.json`: run id, commit, status, summary, limitations and each guard's command, tier and output. `unit_verify` compares that run with HEAD and can re-run its checks without writing a new run.
- **Claims.** `unit_claim`, `unit_load {owner}` and `unit_next` write `owner` and `since` into the note; `unit_record` releases it. A live claim, a shared path or a waiting prerequisite refuses the claim; a claim older than 15 minutes, or one with no `since`, is stale and `takeover: true` takes it. `owner` is required and is not defaulted, so two sessions never share one identity.
- **Checks.** `scan` freezes commands with a tier (`fast`, `unit`, `milestone`); `checks --tier` and `guard_check --tier` run one weight at a time.
- **Plan items.** An item is matched to its task by its text with surrounding whitespace trimmed; two open items with the same text are refused, since one task cannot stand for both.
- **Limits.** Dependencies are explicit `depends` only. A claim has no separate heartbeat: `since` is written once, so a long run must renew it with `unit_claim` before 15 minutes.

## PRDs

- **Outcomes above units.** `.overwatch/vault/02 PRDs` holds one note per planned outcome: acceptance boxes, `needs` (other PRDs), `footprint`, `checks`, and a `## Specs` section of wiki links to the units that implement it. `00 Meta/PRD Template.md` is the scaffold; `prd_add` writes it.
- **Order.** Only `open` and `specced` can start; `question`, `refine`, `blocked` and `failed` are always held with their reason. `prd_next` lists the startable PRDs whose needs are resolved and that no one has claimed; `prd_scan` says why each other one is held. `prd_brief` reads one PRD whole without touching the vault by hand, and its `next:` line follows the hold when there is one. Every PRD write regenerates `Plan Data.json`, so the view never reads a stale snapshot.
- **Refine.** `prd_refine` splits an open PRD into child PRDs one level down; the parent turns `refine` and stays the index.
- **Review gate.** An independent reviewer scores the contract 0–100 and `prd_review` records the round. The round is bound to a digest of the acceptance text, the PRD's own `checks` and every linked unit's Plan items and checks, so a later edit makes it stale; ticking a box or an item does not. 90 passes. Five rounds per attempt, then the allowance is spent and a PRD still below 90 is set `failed`; `prd_set` it `open` again to start a fresh allowance.
- **Collect.** `prd_collect` refuses until needs are resolved (done, or refined with every child done), every acceptance box is ticked, every linked unit is `implemented` with its Plan items ticked, the last review round is fresh and ≥90, the tree outside `.overwatch/` is clean and every `checks` command exits 0 at HEAD. It then writes `status: done`, the proof line and the Collection receipt. It never marks work done on a worker's exit alone.
- **Limits.** No worker dispatch (`run`/`status`/`stop`), lanes or named-test `pass:` blocks; checks are whole-command exit codes. Claims are read, not taken.

## Disk gardener

- **Watch.** One `df` at most every 5 minutes. From `diskFullPercent` (default 88, 0 = off) the agent is asked once per crossing to free space.
- **Proof.** `node_modules` needs its `package.json`, `target` its `CACHEDIR.TAG` or manifest, `.venv` its `pyvenv.cfg`; `dist`, `build`, `out`, `coverage` only where git ignores the folder and tracks nothing in it.
- **Classes.** Leftover: an idle temp entry, or output of a project whose last commit is 30 days old. Rebuildable: proven output of a live project. In use: changed in the last 2 hours, or a process works there. Unverified: everything else. Only the first two are deleted.
- **Deleting.** `disk_clean` refuses links and open files, then runs `rm -rf --`. Caches go only through their owner's command.
- **Limits.** Needs `find`, `du`, `df`, `git`, `lsof`: no Windows. Without `lsof` only the 2-hour rule protects a folder in use.

## State

Plain files in `.overwatch/` in the working directory, beside `incidents.json`; the agent asks once to gitignore `.overwatch/*` while keeping `.overwatch/vault/` tracked.

| file | what |
|---|---|
| `surface.json` | tool and binary counts, verdicts, triggers |
| `checks.json`, `mistakes.md` | frozen checks, recorded mistakes |
| `disk.json` | last survey per scope, deletions, the user's `keep` and `owners` lists |
| `plan.json` | tasks and guards outside Claude Code |
| `evidence/<unit>.json` | the last `unit_record` run: commit, guards, outputs |
| `context/<session>/` | originals of cut and folded messages |
| `status/<session>.json` | compaction's status, read by kern's turn deck |

Outside it: search-guard's `<XDG_STATE_HOME>/overwatch/guard.log` (read by `status`) and the shared Jev dataset `~/.jev/log/`.

## Needs and settings

- `bun`: compaction and `bin/overwatch`.
- `TYPESAFE_API_KEY`: judged guards need it in the shell; compaction also reads the settings `env` map. Without it only guards with a `check` hold the stop.
- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`: the hooks module.
- `maxJudgeTokens`: maximum estimated tokens in one complete serialized guard judgment request, default 18,000. Oversized input is not sent; its guards remain unverified with instructions to narrow the evidence. Invalid nonpositive or nonfinite values use the default. File excerpts explicitly mark truncation.
- Automatic guard evaluation waits until all tasks are complete and stops before evaluating after eight refused stops. `guard_check` always runs the selected shell checks explicitly. Valid judgments reuse one identical serialized request within a user turn; changed evidence or a new user prompt requires a fresh judgment. Shell checks remain fresh while automatic verification is allowed.
- `slots`: followline gauges and their order, default `componion,plan,kern`.
- Compaction: `toolResultMaxChars`, `keepRecentTokens`, `compactEveryTokens`, ….

`liveResultMaxChars` bounds the complete serialized text output, including errors,
many text blocks, and Overwatch reports; the minimum is 512 characters. Outer
status, error flags and context are preserved. Exact file tools (Read, Edit,
Write, MultiEdit, NotebookEdit) and native media/document/file blocks are exempt.
Without a safe original id or a successful archive write, output stays unchanged.
`decompress` returns `{id, offset, text, next_offset, total_chars}`. Pages include
their JSON escaping and metadata in the bound. Offsets count JavaScript string
characters (UTF-16 code units); stored JSON and whitespace are returned exactly.

## Layout

| path | role |
|---|---|
| `hooks/overwatch.ts` | the one hooks module: hooks the shared events once and calls each part. No part imports another's hooks |
| `hooks/catalog.ts` | fingerprints every tool and refuses a stale call |
| `hooks/commands.ts`, `plan-hooks.ts`, `compaction.ts`, `followline.ts` | one file per part, registering only its own hooks |
| `hooks/plan.ts` | the plan's pure logic, run by `plan-hooks.ts` in Claude Code and `host/core.ts` elsewhere |
| `hooks/io.ts` | the one door to the machine: logic takes an `Io` (`$` in a hook, node in `bin/node-io.ts`) |
| `bin/overwatch` | every command from a terminal, plus `overwatch mcp` and `overwatch hook <host> <event>` |

Hot reload: with `claude --plugin-dir <this folder>` a saved change reloads the module and re-declares the tools; an installed copy is never watched. Each tool description ends in its schema hash. In Claude Code's catalog every non-refused result carries `overwatch tools v<version>`, and a call that does not fit the current schema is refused with it. MCP and the other hosts bypass that catalog.

## Check

```sh
claude plugin validate .
claude plugin test .           # every part
bin/overwatch hygiene --selftest
bun test ./host/host.check.ts  # the core other agents run
claude --plugin-dir . -p hi --debug-file ow.log; grep "did not load" ow.log
```

### Guard timeouts

Plan shell guards default to 60000 ms. Set `timeout_ms` on `guard_add`, or on `guard_check` to update all selected guards and retry. Values must be integers from 1 to 600000. A transport timeout stays unmet and pauses automatic retries; an explicit `guard_check` retries it. Ordinary failures and successful checks are still rerun at later stops to detect regressions. Natural exit code 124 is a failure, not proof of a transport timeout.

Refresh installed command-hook adapters to get their 660-second outer Stop budget (Gemini: 660000 ms). This exceeds the maximum guard budget with startup overhead. Vault closeout checks (`unit_record`, `unit_verify` reruns, `prd_collect`) remain fresh explicit checks with the default 60000 ms; they do not inherit plan-guard overrides.

### Learned trigger budget

Only active tools and binaries on PATH with a valid useful verdict from the last 30 days enter the learned-trigger section. At exactly 30 days a verdict expires; missing, invalid, future-dated, situational and dead verdicts do not qualify. The section contains at most eight whole lines within 2,048 characters, including headings and omission notices, ordered by newest verdict then tool name. Oversized or multiline triggers and entries beyond the budget remain in `.overwatch/surface.json`, with an explicit retrieval hint. Ratings away from useful suspend their stored trigger without deleting it. The native session caches its surface block, so ratings affect the next session and do not rewrite the current prompt prefix.

### Mistake history and checklist budgets

Routine prompts and checklists show at most five recent distinct whole mistake records, within a 2,048-character serialized section. The full lessons block stays within 4,096 characters; checklists stay within 8,000 serialized characters (normally 7,800, or the smaller native output setting). Frozen commands are included whole or explicitly omitted with a `.overwatch/checks.json` retrieval instruction. An empty tier does not print other tiers.

`mistake` normalizes new text to one line and does not append an exact whitespace-normalized duplicate, ignoring its generated date. Existing history is never deduplicated or rewritten by reading it. Legacy multiline records are omitted whole from routine reminders and remain exact in the paged reader. `mistakes` returns structured `{id, offset, text, next_offset, total_chars}` pages of the original markdown, with exact UTF-16 string offsets. Continue with the returned id and next_offset; a changed history requires restarting. Native pages fit the configured live-output cap before compaction, including 512-character caps. Portable tools and the CLI serialize at the boundary. Terminal usage: `overwatch mistakes [offset] [limit] [id]`.
