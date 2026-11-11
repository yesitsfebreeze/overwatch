---
name: plan
description: Plan and finish work under overwatch's tasks and guards. Turn the user's request into tasks and guards (yes/no questions, a shell check where one decides), work until every task is done and every guard upheld, then run /simplify on the change, preceded by /code-review when the change is large. Use when the user asks for work, types "/overwatch:plan", or a stop was refused by overwatch.
---

The user wrote: **$ARGUMENTS** (when nothing follows, use their last message).

Everything goes through the plan tools (`mcp__overwatch__task_add`, `guard_add`, `task_progress`, `task_complete`, `guard_check`, `plan_show`, …): one tool per change.

## Before the work starts

1. **Tasks**: one `task_add {titles:[…]}` call with a short title per step.
2. **Guards**: one per thing the request must deliver, 2 to 6 in all:
   - `guard_add {question:"Do the tests pass with bun test?", check:"bun test"}`
   - `guard_add {question:"Does README.md list every plugin in exactly one tier?", files:["README.md"]}`
   - One yes/no question about evidence: a command result, a file's content, the final message.
     Taste words ("clean", "readable", "good") are refused unless a `check` decides them.
   - `check` when a command decides it: exit 0 upholds it, and it re-runs at every stop, so a regression reopens it.
   - No `check`: Jev judges it from the recorded turn (needs `TYPESAFE_API_KEY`; without it such guards do not hold the stop).

File edits are refused until the plan has both tasks and guards. A question or chat that changes nothing needs neither.

## While working

`task_start {task_id}`, `task_progress {task_id, progress}` (0-100) and `task_complete {task_id}` as steps finish. New work from a follow-up: new tasks and guards.

## Finishing

Every stop is refused while a task is open, a guard is not upheld, or 10+ lines changed and
`/simplify` has not run on the change since (a whole-file write or a replace_all always
counts as 10+). A large change (50+ changed lines) needs
`/code-review` before `/simplify`. Invoke them with the Skill tool once tasks and guards are
clear; edits they make count as part of that pass.

- Need the user's input: ask with AskUserQuestion, then continue.
- A guard that cannot be met: say so and why. Only the user drops a guard (`guard_drop {guard_id:"<id>"}`). Run `guard_check` after a fix to confirm a guard holds before stopping.
- Never reword or drop a guard to get past a refusal.
- A refused edit or stop is recorded. Caught three times in 30 days, it becomes a lesson line in every later session.
