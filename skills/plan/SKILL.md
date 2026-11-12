---
name: plan
description: Plan and finish work under overwatch's tasks and guards. Turn the user's request into tasks and guards (yes/no questions, a shell check where one decides), work until every task is done and every guard upheld, then run /simplify on the change, preceded by /code-review when the change is large. Use when the user asks for work, types "/overwatch:plan", or a stop was refused by overwatch.
---

The user wrote: **$ARGUMENTS** (when nothing follows, use their last message).

Everything goes through the plan tools (`mcp__overwatch__task_add`, `guard_add`, `task_progress`, `task_complete`, `guard_check`, `plan_show`, …).

## Before the work starts

File edits are refused until the plan has both. A question or chat that changes nothing needs neither.

When the project has a spec vault (`.overwatch/vault`), work that belongs to a unit starts from it: `vault_plan` shows the units ready now, `unit_load {unit}` brings one unit's Plan items in as tasks and its `checks` as guards, and `unit_record {summary, limitations}` closes it after the commit. New durable work becomes a unit with `unit_new`.

1. **Tasks**: one `task_add {titles:[…]}` call, a short title per step.
2. **Guards**: one per thing the request must deliver, 2 to 6 in all. Each is one yes/no question about evidence: a command result, a file's content, the final message. Taste words ("clean", "readable", "good") are refused unless a `check` decides them.
   - With a `check`, when a command decides it: `guard_add {question:"Do the tests pass with bun test?", check:"bun test"}`. Exit 0 upholds it; it re-runs at every stop.
   - Without: `guard_add {question:"Does README.md list every plugin in exactly one tier?", files:["README.md"]}`. Jev judges it (needs `TYPESAFE_API_KEY`; without it such guards do not hold the stop).

## While working

`task_start {task_id}`, `task_progress {task_id, progress}` (0-100), `task_complete {task_id}`. A follow-up brings new tasks and guards.

## Finishing

Every stop is refused while a task is open, a guard is not upheld, or 10+ lines changed without `/simplify` since (a whole-file write or replace_all counts as 10+). 50+ changed lines need `/code-review` before `/simplify`. Invoke them with the Skill tool once tasks and guards are clear.

- Need the user's input: AskUserQuestion, then continue.
- A guard that cannot be met: say so and why. Only the user drops a guard (`guard_drop {guard_id}`). Never reword or drop one to get past a refusal.
- After a fix, `guard_check` confirms a guard holds.
