---
name: work
description: Run one iteration of the project goal loop. Reads WORK.md at the repo root (creating it from an analysis of the repo if absent) and does one outcome under overwatch's tasks and guards. Use for "/overwatch:work"; run endlessly with `/loop /overwatch:work`.
---

One iteration. The caller repeats it: `/loop /overwatch:work`.

User input: **$ARGUMENTS** (empty: pick work yourself).

1. `WORK.md` missing at the repo root: analyze the repo (layout, build and test commands, conventions, existing docs) and write it with sections What this is, Layout, Verify, Rules, Work loop, Stop conditions. Never overwrite an existing one.
2. Read `WORK.md` and follow its Work loop for exactly one outcome. `$ARGUMENTS` set: that is the outcome.
3. Nothing worth doing: say so in one line, make no edits, end the turn. Needs the user or a guard cannot be met: say so and why; never reword or drop guards.
