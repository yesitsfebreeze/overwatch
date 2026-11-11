---
name: overwatch
description: What overwatch recorded and a repo's verification checks. Use when asking what the agent was caught doing or which tools get used here ("overwatch report"), rating the tool the tool-surface block asked about, before declaring a change done ("what should I run?"), to record a mistake worth not repeating, or when the machine feels loaded.
argument-hint: "[status | scan | checks | mistake <text> | report | index | rate ...]"
---

# Overwatch: catches, tool surface and checks

Call the tools directly: each `mcp__overwatch__<action>` runs in-process from
the session's directory and returns its text. The same commands run from a
terminal as `"${CLAUDE_PLUGIN_ROOT}/bin/overwatch" <action>` (bun). Invoked as `/overwatch:overwatch <args>`: call the tool for the action
(none → `status`) and report what it returns.

| need | tool |
|---|---|
| rate the tool the tool-surface block asked about | `rate {name, verdict, reason, trigger?}` |
| what was caught in the last 30 days, what gets used on this machine, verdicts, triggers | `report` |
| the tool-surface block, on demand | script only: `overwatch index` |
| freeze this repo's test/lint/build commands | `scan` |
| the checklist to run before saying a change is done | `checks` |
| record a mistake so later checklists carry it | `mistake {text}` |
| git state, frozen checks, catch counts, guard blocks, memory hogs | `status` |

State: `.claude/overwatch/{checks.json,mistakes.md}` per repo,
`$XDG_STATE_HOME/overwatch/{surface.json,incidents.json}` per machine. Plain files — read or edit
them directly when that is shorter.

## Catches — what the agent was caught doing

- **Recording is automatic.** A refused edit (no plan yet), a refused stop (work open), a
  stop let through after repeated refusals, a call that did not fit a tool's schema and a
  turn with failed tool calls each add one entry: kind, project, what was open.
- **A habit becomes a lesson.** A kind caught 3 times in 30 days adds its one-line lesson,
  with the count, to every later session's prompt. Stop doing it and the line drops out as
  the days leave the window. There is nothing to rate and nothing to clear.
- **`mistake` is the manual half**: a lesson the counts cannot know. The newest five of a
  repo ride the prompt beside the habits.

## Tool surface — the measured half

The harness withholds schema from deferred tools, and that policy is static:
`rare` confirms itself, because a tool never reached is a tool never observed.
The ledger closes the loop.

- **Counting is automatic.** Each main-thread tool call is counted as it runs,
  in memory, and folded into the ledger once per turn.
- **Bash calls are counted twice**: once as `Bash`, once as `sh:<binary>` — the
  command the call actually ran. A routing table that says "use `rg`, not
  `grep`" is unfalsifiable until the binaries are counted, because the tool
  name is always just `Bash`.
- **The prompt carries what was learned**, limited to the tools this session
  has and the binaries on PATH: the learned trigger lines, the most-fired tools, any deferred tool that fired 3+ times (reach for it early
  instead of rediscovering it), and one cold tool to rate.
- **Rating is the only manual step, and it is one call.** `useful` means the
  tool should have been reached in this session and was not — so `--trigger` is
  required there and is the whole payoff: that line ships into every later
  session's block. `situational` means it was correct to sit idle. `dead` means
  nothing needs it. Verdicts go stale after 30 days and the tool comes back up
  for rating.
- **Judge against the work actually done here.** A session that gave no basis
  to judge the drawn tool → say exactly that as the reason. Do not guess, and
  do not invent a trigger to make a verdict look decisive.
- A verdict cannot un-defer a tool here — the harness owns that. What it buys
  is the trigger line.
- Never-fired names live in `data/surface-seed.txt` in the plugin. A `dead`
  verdict is the signal to drop a line from it.

## Checks and mistakes

- **Before claiming done**, `checks` prints the frozen checks *and* the mistakes
  ledger. Run them; quote the failing line if one fails.
- **`scan` is a discovery pass, not law.** It reads `package.json` scripts,
  `Cargo.toml`, `go.mod`, `Makefile`, `justfile`, `pyproject.toml`; a justfile
  recipe wrapping `cargo test` supersedes the raw command. Wrong guess → edit
  `checks.json`, it is three lines of JSON.
- **`mistake` is for the ones that cost time twice**, with the why: "ran the
  whole suite while a peer held the cargo lock — use the built test binary".
  Not for typos.
- **`status` flags language servers over 500MB** so an orphaned `rust-analyzer`
  that outlived its editor gets killed before it eats swap.

The search guard that blocks unbounded `grep -r` and `find /` is its own plugin now,
`search-guard`; `status` still counts its blocks from `$XDG_STATE_HOME/overwatch/guard.log`.
