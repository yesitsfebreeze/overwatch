---
title: Plan
category: Meta
status: index
tags: [meta, plan]
---

# Plan

A delivery order computed from the spec notes in `01 Specs`, not a schedule. Every unfinished spec is a unit. A unit's **wave** is one more than the latest wave among the unfinished units it depends on; units in one wave have no ordering dependency between them. Overwatch computes the plan (`vault_plan`, or `overwatch vault plan`) and writes [[Plan Tasks]] and `Plan Data.json`, which the **Plan View** plugin renders: x is effort in friction units, overlapping bars are parallel work. [[Dashboard]] is the Dataview overview of the same notes: completion and friction by area, ready units, claims and held units.

Effort per unit: each linked issue and open question 2, `proposed` 3, `partial` 2, `target` or `deferred` 1, more than one proposal 1, at least 1. `prio` only changes the mark.

## Spec frontmatter

| Field | Values | Effect |
| --- | --- | --- |
| `status` | `target`, `proposed`, `partial`, `implemented`, `deferred`, `open-question` | The unit's state; `unit_record` sets `implemented` or `partial`. |
| `category` | `documentation`, `behavior`, `protocol`, `build`, `acceptance` | Kind of change. |
| `depends` | `["Other Unit"]` | Predecessors by note name. |
| `checks` | `["bun test"]` | Shell commands; `unit_load` turns each into a guard. |
| `paths` | `[src/a.ts]` | The unit's scope; two units of one wave sharing a path clash. |
| `prio` | `highest` … `lowest` | Priority mark. |
| `plan` | `skip` | Leaves the note out of the plan. |
| `blocked` | reason | Holds the unit. |
| `proof` | written by `unit_record` | Commit, guard outcomes and limitations. |
| `owner`, `since` | written by `unit_claim` / `unit_load {owner}` | Who holds the unit and when; a claim older than 15 minutes, or one with no `since`, is stale. |
| `evidence` | written by `unit_record` | The run id in `.overwatch/evidence/<unit>.json`; `unit_verify` compares it with HEAD. |

## Working a unit

1. `vault_plan` lists the waves; a unit marked `[start now]` is ready.
2. `unit_load {unit, owner}` adds the unit's open `## Plan` items as session tasks, its `checks` as guards, and claims it. `unit_next` picks the first unit that can start now.
3. Work, commit, then `unit_record {summary, limitations}`: it ticks the finished Plan items, writes the proof line, the evidence run and the Status section, and regenerates the plan. `unit_verify` reads the run back.

Cycles, missing prerequisites and prerequisites left out of the plan hold a unit instead of guessing an order.

## Related

- [[Home]]
- [[Dashboard]]
- [[Plan Tasks]]
- [[PRDs]]
