---
name: gardener
description: Free disk space safely when the disk is nearly full. Surveys this project first, then the whole disk, deletes only proven leftovers (idle temp entries, build output and dependency folders that rebuild) and reports what keeps growing. Use when overwatch says the disk is nearly full, a build or write fails with "No space left on device" / ENOSPC, or the user says "/gardener", "disk gardener", "free disk space", "what is eating my disk".
allowed-tools: mcp__overwatch__disk, mcp__overwatch__disk_clean, Bash, Read, Write
---

# gardener

The tools measure and prove; you decide the order and stop as soon as there is
room again. Without the tools: `${CLAUDE_PLUGIN_ROOT}/bin/overwatch disk [disk]`
and `${CLAUDE_PLUGIN_ROOT}/bin/overwatch disk-clean [--apply] <path…>`.

overwatch reads the free space itself (one `df`, at most every 5 minutes, beside
a prompt or a tool result) and asks for this skill once when the project's disk
crosses the threshold (`diskFullPercent`, default 88). Nothing has to be armed.

## 1. This project first

`mcp__overwatch__disk` (scope `project`, seconds). Note the first line: percent
used and free space, the "before".

Delete the **Leftover** section: `mcp__overwatch__disk_clean {paths, apply: true}`
with the paths exactly as printed. Every path is judged again at that moment; a
refusal names its reason. Never work around a refusal with `rm`.

Still at or above the threshold: delete from **Rebuildable**, largest first,
only what the current task does not need in the next minutes (it costs the next
build or install). Stop once the disk is below the threshold.

## 2. Then the whole disk

Only when the project did not free enough: `mcp__overwatch__disk {scope: "disk"}`
(one to three minutes: home folder, temp folders, caches, app data). Same order:

1. **Leftover**, all of it.
2. **Caches**: run the owner's command the line names (`brew cleanup -s`,
   `uv cache prune`, …), largest first. A cache without a command is report-only.
3. **Rebuildable** in other projects, largest first, and only while still above
   the threshold.

## Hands off

- **In use**, **Kept**, **Unverified**, **Large files** and anything the survey
  did not list: report it, never delete it. Unverified means no proof: a
  `target` without its manifest, a temp checkout with uncommitted or unpushed
  work, a folder inside a tool's own home (`~/.tool/…`).
- Stop the dev server or build that owns a folder before deleting it.
- No `rm` of your own for anything the survey refused or did not list. Deletion
  is permanent, not a move to the Trash.

## 3. Report

Tell the user in a few lines: percent used and free space before and after,
what was deleted (count and size), and from **Grew since** and **Large files**
the one or two things that grow without a bound, with who owns each and what
would bound it (retention, a gc flag, log rotation). Those are the user's
decisions; delete none of them. Then go on with the work that was interrupted.

## Settings

`.overwatch/disk.json` in the project holds the last survey per scope (so the
next one can say what grew), the deletions, and two lists the user may edit:

```json
{ "keep": ["/abs/path/of/a/project/never/to/touch"],
  "owners": { "Library/Caches/kache": "kache gc --max-age 2d" } }
```

`owners` maps a path under the home folder to the command that shrinks it. The
disk scope always keeps the project the session works in.
