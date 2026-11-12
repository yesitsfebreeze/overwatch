---
name: prd
description: Plan durable outcomes as PRDs in the spec vault and collect them against evidence. A PRD note holds acceptance boxes, needs, footprint and checks; its linked units do the work; a review round of at least 90 gates collection. Use when the user asks what to work on next, wants a plan of record, asks to split big work, review a plan, or finish a PRD ("what's ready", "prd", "collect the PRD", "review the plan").
---

Everything goes through the PRD tools (`mcp__overwatch__prd_scan`, `prd_next`, `prd_brief`, `prd_add`, `prd_refine`, `prd_set`, `prd_review`, `prd_collect`). The notes live in `.overwatch/vault/02 PRDs`, the units in `01 Specs`, both Obsidian and git-tracked.

## Choosing work

1. `prd_next` lists what can start now: open or specced, every need done, not claimed.
2. `prd_brief {prd}` reads one PRD whole: acceptance boxes, needs, linked units with open Plan items, footprint, the review gate and the next step.
3. A unit's work loads with `unit_load {unit}`; a new PRD comes from `prd_add`, a split from `prd_refine`.

## The flow

- **open → specced.** Write the units that implement the PRD in `01 Specs` and link them under its `## Specs` section; then `prd_set {prd, state:"specced"}`. Refuses without a linked unit.
- **Review.** An independent reviewer scores the contract 0-100; `prd_review {prd, score, reviewer, findings?}` records the round. The round is bound to a digest of the acceptance text, the PRD's `checks` and every linked unit's Plan items and checks: editing them makes it stale, ticking boxes does not. 90 passes. Five rounds per attempt; miss the gate on the fifth and the PRD is set `failed`; `prd_set {prd, state:"open"}` starts a fresh attempt with a new allowance.
- **Collect.** `prd_collect {prd}` refuses until needs are resolved (done, or refined with every child done), every acceptance box is ticked, every linked unit is implemented with its Plan items ticked, the last review round is fresh and at least 90, the tree outside `.overwatch/` is clean and every `checks` command exits 0 at HEAD. It then writes `status: done`, the proof line and the Collection receipt; nothing is written before every gate holds.
- **blocked / failed.** `prd_set` needs a reason for blocked; clear it with any other state.

Never invent a review score or a reviewer, and never tick an acceptance box the work did not observe. A guard or gate that cannot be met is reported to the user, not bypassed.
