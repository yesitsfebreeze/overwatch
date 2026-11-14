---
title: Memory Retrieval and Recall
category: behavior
status: target
proposals: []
issues: []
updated: 2026-11-14
tags: [spec]
depends: [Memory Identity and Store]
checks: [bun test ./memory/search.test.ts ./memory/recall.test.ts]
paths: [memory/search.ts, memory/search.test.ts, memory/recall.ts, memory/recall.test.ts]
---

# Memory Retrieval and Recall

## Summary

Implement useful cross-session retrieval with compact indexes, chronological context and exact selected details. Rank for the current project, request, active unit and files within explicit output budgets. Text search is a first step; semantic parity must be evaluated honestly.

## Rules

-

## Plan

- [ ] Implement explicit project-scoped text and structured-field search with stable IDs, source pointers, currentness and deterministic ordering; require deliberate cross-project scope.
- [ ] Provide timeline neighborhoods and exact paginated selected details with revision-bound continuation and explicit missing, superseded or truncated evidence.
- [ ] Build bounded recall packets from project identity, request, active unit, file relevance, applicable direct instructions and accepted rules and recent useful evidence; fit the complete serialized result and expose omitted information through retrieval.
- [ ] Run a fixed recall set containing exact terms, paraphrases, stale-versus-corrected facts, unrelated projects and empty results; add an Overwatch-owned semantic index only if needed to meet agreed cases, without retaining claude-mem or claiming lexical search is semantic.
- [ ] Test large histories, stable ranking, project isolation, pagination reconstruction and budget enforcement; keep this unit free of central catalog and prompt-hook edits so it can run in parallel.

## Status

What exists today, with the ledger unit that owns the rest.

## Open questions

-

## Related

- [[Home]]

## Sources

-
