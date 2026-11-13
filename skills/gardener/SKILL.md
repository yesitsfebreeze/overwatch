---
name: gardener
description: Free disk space safely when the disk is nearly full. Surveys this project first, then the whole disk, deletes only proven leftovers (idle temp entries, build output and dependency folders that rebuild) and reports what keeps growing. Use when overwatch says the disk is nearly full, a build or write fails with "No space left on device" / ENOSPC, or the user says "/gardener", "disk gardener", "free disk space", "what is eating my disk".
allowed-tools: mcp__overwatch__disk, mcp__overwatch__disk_clean, Bash, Read, Write
---

# gardener

Stop as soon as the disk is below the threshold (`diskFullPercent`, default 88). Without the tools: `${CLAUDE_PLUGIN_ROOT}/bin/overwatch disk [disk]` and `${CLAUDE_PLUGIN_ROOT}/bin/overwatch disk-clean [--apply] <path…>`.

## 1. This project first

1. `mcp__overwatch__disk` (scope `project`, seconds). Note percent used and free space: the "before".
2. Delete **Leftover**: `mcp__overwatch__disk_clean {paths, apply: true}`, paths exactly as printed. A refusal names its reason.
3. Still at or above the threshold: delete from **Rebuildable**, largest first, only what the current task does not need in the next minutes.

## 2. Then the whole disk

Only when the project did not free enough: `mcp__overwatch__disk {scope: "disk"}` (one to three minutes).

1. **Leftover**, all of it.
2. **Caches**: run the owner's command the line names (`brew cleanup -s`, `uv cache prune`, …), largest first. A cache without a command is report-only.
3. **Rebuildable** in other projects, largest first, only while still above the threshold.

## Hands off

- **In use**, **Kept**, **Unverified**, **Large files** and anything the survey did not list: report, never delete.
- Stop the dev server or build that owns a folder before deleting it.
- No `rm` of your own, never around a refusal. Deletion is permanent.

## 3. Report

Percent used and free space before and after, what was deleted (count and size), and from **Grew since** and **Large files** the one or two things that grow without a bound, with their owner and what would bound it (retention, a gc flag, log rotation). Those are the user's to decide. Then resume the interrupted work.

## Settings

`.overwatch/disk.json` holds the last survey per scope, the deletions, and two lists the user may edit:

```json
{ "keep": ["/abs/path/of/a/project/never/to/touch"],
  "owners": { "Library/Caches/kache": "kache gc --max-age 2d" } }
```

`owners` maps a path under the home folder to the command that shrinks it.
