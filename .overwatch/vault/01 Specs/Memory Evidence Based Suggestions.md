---
title: Memory Evidence Based Suggestions
category: behavior
status: target
proposals: []
issues: []
updated: 2026-11-14
tags: [spec]
depends: [Memory Retrieval and Recall, Memory Intent and Working Rules, Memory Evidence and Corrections]
checks: [bun test ./memory/suggestions.test.ts]
paths: [memory/suggestions.ts, memory/suggestions.test.ts]
---

# Memory Evidence Based Suggestions

## Summary

Recommend useful next work using current goals, available vault units, dependencies, claims, failures and relevant experience. Each recommendation explains its source and uncertainty; inferred progress never completes authoritative work.

## Rules

-

## Plan

- [ ] Build candidates from explicit goals, unresolved requests, current failed checks, regressions and available prerequisite units by reading the current vault, claim and evidence owners.
- [ ] Rank deterministic signals first: current user priority, readiness, blocker impact, relevance and recency; use bounded inference only where interpreting evidence requires it.
- [ ] Return each suggestion with action, supporting goal/request, source IDs, priority reason, current blockers and uncertainty; distinguish historical claims from current proof.
- [ ] Persist accept, dismiss and correction feedback without automatically adding tasks, taking claims, changing PRD status or upholding guards; revive a dismissed suggestion only with material new evidence made visible.
- [ ] Test claimed or completed work, unmet dependencies, stale success versus current failure, missing evidence and feedback; unchanged inputs must make no new model call or duplicate suggestion.

## Status

What exists today, with the ledger unit that owns the rest.

## Open questions

-

## Related

- [[Home]]

## Sources

-
