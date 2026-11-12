---
name: overwatch
description: What overwatch recorded and a repo's verification checks. Use when asking what the agent was caught doing or which tools get used here ("overwatch report"), rating the tool the "Evaluation due" question named, before declaring a change done ("what should I run?"), to record a mistake worth not repeating, or when the machine feels loaded.
argument-hint: "[status | scan | checks | mistakes [offset] [limit] [id] | mistake <text> | report | index | rate ...]"
---

# Overwatch: catches, tool surface and checks

Call `mcp__overwatch__<action>` directly; from a terminal, `"${CLAUDE_PLUGIN_ROOT}/bin/overwatch" <action>`. Invoked as `/overwatch:overwatch <args>`: call the tool for the action (none → `status`) and report what it returns.

| need | tool |
|---|---|
| rate the tool the "Evaluation due" question named | `rate {name, verdict, reason, trigger?}` |
| catches of the last 30 days, tool usage, verdicts, triggers | `report` |
| the tool-surface block | script only: `overwatch index` |
| freeze this repo's test/lint/build commands | `scan` |
| the checklist before saying a change is done | `checks` |
| read full mistake history, one exact page at a time | `mistakes {offset?, limit?, id?}` |
| record a mistake so later checklists carry it | `mistake {text}` |
| git state, checks, catch counts, guard blocks, memory hogs | `status` |

State: plain files in `.overwatch/`; edit them directly when that is shorter.

## Catches

- **Recorded automatically**: a refused edit (no plan), a refused stop (work open), a stop let through after repeated refusals, a call that did not fit a tool's schema, a turn with failed tool calls.
- **A habit becomes a lesson.** A kind caught 3 times in 30 days adds its lesson and count to every later session's prompt, until its days leave the window.
- **`mistake`** is for what the counts cannot know. At most five recent distinct whole lessons fit within a 2,048-character serialized section; `mistakes` reads every original record, including older and duplicate entries.

## Tool surface

- **Counting is automatic.** A Bash call counts twice, as `Bash` and as `sh:<binary>`, so "use `rg`, not `grep`" can be checked.
- **The prompt carries** the learned triggers, the most-fired tools, any deferred tool that fired 3+ times, and one cold tool to rate.
- **Rating, one call.** `useful`: the tool should have been reached this session and was not; `trigger` is required. Active tools and binaries on PATH with a useful verdict younger than 30 days qualify for the next session: at most eight whole trigger lines within 2,048 characters, newest first. Oversized or additional entries stay in `.overwatch/surface.json`. `situational` and `dead` suspend a trigger without deleting its stored text. The prompt block stays fixed for the current session.
- **Judge against the work actually done here.** No basis to judge: say exactly that as the reason. Never guess, never invent a trigger.
- A verdict cannot un-defer a tool; it buys the trigger line. A `dead` verdict is the signal to drop the tool's line from `data/surface-seed.txt`.

## Checks and mistakes

- **Before claiming done**, run the complete commands `checks` prints; when it names omitted commands, retrieve `.overwatch/checks.json` before completion. Commands are never printed partly. Quote the failing line if one fails.
- **`scan` is a discovery pass, not law.** It reads `package.json` scripts, `Cargo.toml`, `go.mod`, `Makefile`, `justfile`, `pyproject.toml`. Wrong guess: edit `checks.json`.
- **`mistake` is for the ones that cost time twice**, with the why: "ran the whole suite while a peer held the cargo lock — use the built test binary". Not for typos.
- **`status` flags language servers over 500MB**, so an orphaned `rust-analyzer` gets killed before it eats swap.
