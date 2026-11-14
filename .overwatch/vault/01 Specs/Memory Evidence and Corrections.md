---
title: Memory Evidence and Corrections
category: behavior
status: target
proposals: []
issues: []
updated: 2026-11-14
tags: [spec]
depends: [Memory Identity and Store]
checks: [bun test ./memory/records.test.ts, bun test ./hooks/vault.test.ts ./hooks/prd.test.ts]
paths: [memory/records.ts, memory/records.test.ts, hooks/vault.ts, hooks/vault.test.ts, hooks/prd.ts, hooks/prd.test.ts, hooks/surface.ts]
---

# Memory Evidence and Corrections

## Summary

Make Overwatch's existing verified outcomes and explicit decisions searchable without an extra model call. Preserve proof authority and support traceable corrections. A retrieval record never duplicates the authoritative task or guard state.

## Rules

-

## Plan

- [ ] Emit source-linked records from successful unit_record and prd_collect outcomes using the existing summary, limitations, run ID, commit and check results; keep incomplete and failed work labeled accurately.
- [ ] Implement explicit note, decision and correction operations with real author/session/project attribution, source identity and idempotent writes.
- [ ] Preserve append-only evidence and explicit corrects or supersedes links; a new inference cannot overwrite an explicit instruction or a verified fact without its own evidence.
- [ ] Reference existing mistakes, incident lessons and tool triggers through their current owners; avoid maintaining a second plan, guard ledger or procedural-lesson authority.
- [ ] Test duplicate closeout, changed commits, partial outcomes, storage failure and correction history; prove an old success record cannot uphold a current guard.

## Status

What exists today, with the ledger unit that owns the rest.

## Open questions

-

## Related

- [[Home]]

## Sources

-
