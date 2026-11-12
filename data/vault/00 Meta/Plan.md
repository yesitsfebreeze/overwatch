---
title: Plan
category: Meta
status: index
tags: [meta, plan]
---

# Plan

A delivery order computed from the spec notes in `01 Specs`, not a schedule. Every unfinished spec is a unit. A unit's **wave** is one more than the latest wave among the unfinished units it depends on; units in one wave have no ordering dependency between them. Overwatch computes the plan (`vault_plan`, or `overwatch vault plan`) and writes [[Plan Tasks]] and `Plan Data.json`, which the **Plan View** plugin renders: x is effort in friction units, overlapping bars are parallel work.

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

## Working a unit

1. `vault_plan` lists the waves; a unit marked `[start now]` is ready.
2. `unit_load {unit}` adds the unit's open `## Plan` items as session tasks and its `checks` as guards.
3. Work, commit, then `unit_record {summary, limitations}`: it ticks the finished Plan items, writes the proof line and the Status section, and regenerates the plan.

Cycles, missing prerequisites and prerequisites left out of the plan hold a unit instead of guessing an order.

## Related

- [[Home]]
- [[Plan Tasks]]
- [[PRDs]]
