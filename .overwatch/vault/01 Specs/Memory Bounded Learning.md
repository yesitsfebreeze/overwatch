---
title: Memory Bounded Learning
category: behavior
status: target
proposals: []
issues: []
updated: 2026-11-14
tags: [spec]
depends: [Memory Human and Tool Capture, Memory Evidence and Corrections]
checks: [bun test ./memory/extract.test.ts ./memory/worker.test.ts, bun test ./hooks/usage.test.ts]
paths: [memory/extract.ts, memory/extract.test.ts, memory/worker.test.ts, bin/memory-worker.ts, hooks/usage.ts, hooks/usage.test.ts]
---

# Memory Bounded Learning

## Summary

Add an optional Overwatch-owned extraction worker for discoveries and session summaries. Structured Overwatch evidence bypasses inference; ambiguous provider failures never trigger uncontrolled billable replay.

## Rules

-

## Plan

- [ ] Implement a versioned extraction contract for durable facts, decisions, discoveries, session summaries and current next steps, with source-event IDs and validated quotations or evidence references.
- [ ] Select only useful new unprocessed evidence and batch it at meaningful boundaries; bypass model calls for already structured proof and explicit notes, exclude recursive memory, and avoid one observer call per routine tool event.
- [ ] Require an explicitly configured suitable provider; verify its structured-output capability rather than assuming the guard judge can summarize, and enforce input, output, request and scheduling budgets.
- [ ] Track actual extraction calls, estimated input and provider-reported usage separately from compaction and guard calls; deduplicate committed results and retain uncertain delivery state without automatic repeated paid calls.
- [ ] Test invalid output, invented evidence, missing provider, exhaustion, interruption and restart; record a separate real-provider smoke run when configured, and never label fixture coverage as live-provider verification.

## Status

What exists today, with the ledger unit that owns the rest.

## Open questions

-

## Related

- [[Home]]

## Sources

-
