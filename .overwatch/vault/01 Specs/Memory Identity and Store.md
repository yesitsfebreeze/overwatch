---
title: Memory Identity and Store
category: behavior
status: target
proposals: []
issues: []
updated: 2026-11-14
tags: [spec]
checks: [bun test ./memory/store.test.ts ./memory/projects.test.ts, bun test ./host/host.check.ts]
paths: [memory/types.ts, memory/store.ts, memory/store.test.ts, memory/projects.ts, memory/projects.test.ts, bin/memory-store.ts, hooks/io.ts, bin/node-io.ts]
---

# Memory Identity and Store

## Summary

Define the shared memory contract and create one native transactional store through Io. Keep working state under the selected Overwatch workspace's .overwatch directory, with explicit registered project scopes; do not introduce an implicit home-wide database or scan. This unit fixes interfaces before parallel work. See docs/native-memory-plan.md.

## Rules

-

## Plan

- [ ] Define versioned record contracts for projects and aliases, sessions, human prompts, source events, observations, summaries, intent, rules, feedback, processing receipts and namespaced import IDs; distinguish authority, workspace, affected project, revision and supersession.
- [ ] Resolve project identity from canonical repository identity and explicit root aliases; preserve worktree and branch context separately, reject same-basename collisions, and expose unresolved or unavailable identity instead of guessing.
- [ ] Implement SQLite transactions, unique source-event keys, record-plus-processing commits and versioned migrations behind a Bun-side Io adapter; keep Bun and Node imports out of native hook logic and preserve workspace-local state ownership.
- [ ] Provide bounded structured requests and failures for the store, explicit project registration and scoped reads; check SQLite full-text capability on the actual target before depending on it.
- [ ] Add meaningful tests for process reopen, concurrent writers, duplicate events, rollback, renamed roots, worktrees, project isolation and all shared record shapes, then document the stable interfaces for downstream units.

## Status

What exists today, with the ledger unit that owns the rest.

## Open questions

-

## Related

- [[Home]]

## Sources

-
