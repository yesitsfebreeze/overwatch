---
name: steward
description: Tool-surface ledger (reflex) and a repo's verification checks. Use when rating the tool the session-start block asked about, asking which tools get used here ("steward report"), before declaring a change done ("what should I run?"), to record a mistake worth not repeating, or when the machine feels loaded.
argument-hint: "[status | scan | plan | mistake <text> | report | index | rate ...]"
---

# Steward

One script: `python3 "${CLAUDE_PLUGIN_ROOT}/bin/steward" <action>`. Run it from
the repo root. Invoked as `/steward:steward <args>`: run the args as the action
(none → `status`) and report what it prints.

| need | call |
|---|---|
| rate the tool the session-start block asked about | `rate <name> <useful\|situational\|dead> "<reason>" [--trigger "<line>"]` |
| what gets used on this machine, verdicts, triggers | `report` |
| the session-start block, on demand | `index` |
| freeze this repo's test/lint/build commands | `scan` |
| the checklist to run before saying a change is done | `plan` |
| record a mistake so later plans carry it | `mistake <text>` |
| git state, frozen checks, guard blocks, memory hogs | `status` |

State: `.claude/steward/{checks.json,mistakes.md}` per repo,
`$XDG_STATE_HOME/steward/surface.json` per machine. Plain files — read or edit
them directly when that is shorter.

## reflex — the measured half of the tool surface

The harness withholds schema from deferred tools, and that policy is static:
`rare` confirms itself, because a tool never reached is a tool never observed.
The ledger closes the loop.

- **Counting is automatic.** A `Stop` hook reads the finished turn's transcript
  and folds its tool fires in. No per-call hook, no latency.
- **Bash calls are counted twice**: once as `Bash`, once as `sh:<binary>` — the
  command the call actually ran. A routing table that says "use `rg`, not
  `grep`" is unfalsifiable until the binaries are counted, because the tool
  name is always just `Bash`.
- **Session start injects what was learned**: the learned trigger lines, the
  most-fired tools, any deferred tool that fired 3+ times (reach for it early
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

## rigor — checks and mistakes

- **Before claiming done**, `plan` prints the frozen checks *and* the mistakes
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
`search-guard`; `status` still counts its blocks from `$XDG_STATE_HOME/steward/guard.log`.
