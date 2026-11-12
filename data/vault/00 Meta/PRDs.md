---
title: PRDs
category: Meta
status: index
tags: [meta, plan]
---

# PRDs

One note per planned outcome under `02 PRDs`, written by `prd_add` from `00 Meta/PRD Template.md`. A PRD says what must be observable before work is called done; the units in `01 Specs` do the work.

## Flow

1. **open.** `prd_add` writes the note. Add acceptance boxes: observable outcomes, each one checked by someone.
2. **specced.** Write the implementing units in `01 Specs` and link them in the PRD's `## Specs` section, one `[[Unit]]` per line. `prd_set {state:"specced"}` refuses without one.
3. **review.** An independent reviewer scores the contract 0-100; `prd_review` records the round. The digest binds the round to the acceptance text, the PRD's `checks` and every linked unit's Plan items and checks, so editing them makes it stale. 90 passes. Five rounds per PRD; a miss on the fifth sets the PRD `failed`.
4. **collect.** `prd_collect` verifies needs, boxes, units, the review round, a clean tree and every check at HEAD, then writes `status: done`, the proof line and the receipt.
5. **blocked / failed.** `prd_set` with a reason; any other state clears it.

## PRD frontmatter

| Field | Values | Effect |
| --- | --- | --- |
| `status` | `open`, `question`, `refine`, `specced`, `blocked`, `failed`, `done` | Where the outcome stands; `done` only from `prd_collect`. |
| `priority` | number, default 50 | Higher is worked first by `prd_next`. |
| `needs` | `["Other PRD"]` | Prerequisites; a PRD waits until every one is done. |
| `footprint` | `[src/a.ts]` | What it changes; read by `prd_brief`. |
| `checks` | `["bun test"]` | Commands `prd_collect` must find exit 0 at HEAD. |
| `parent` | PRD name | Set by `prd_refine` on each child. |
| `owner` | name | A claimed PRD waits; nothing in the vault takes claims. |
| `proof` | written by `prd_collect` | Commit, review round, checks. |
| `blocked` | reason | Set with `prd_set state:"blocked"`. |

## Specs section

```md
## Specs

- [[Parser Recovery]]
- [[Plan Tasks]]
```

Only the links count, not the list text: `prd_collect` needs each one present in `01 Specs`, `implemented`, with every Plan item ticked.

## Related

- [[Home]]
- [[Plan]]
