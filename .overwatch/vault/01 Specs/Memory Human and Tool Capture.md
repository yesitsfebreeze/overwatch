---
title: Memory Human and Tool Capture
category: protocol
status: target
proposals: []
issues: []
updated: 2026-11-14
tags: [spec]
depends: [Memory Identity and Store, Memory Evidence and Corrections]
checks: [bun test ./memory/capture.test.ts, bun test ./host/host.check.ts]
paths: [memory/capture.ts, memory/capture.test.ts, hooks/overwatch.ts, hooks/compaction.ts, host/core.ts, host/hooks.ts, host/host.check.ts, adapters/]
---

# Memory Human and Tool Capture

## Summary

Capture attributable human requests and useful original work events before output reduction. Extend the portable host contract only where actual hosts supply the needed information, and preserve bounded hook latency and one capture owner.

## Rules

-

## Plan

- [ ] Extend normalized host events with real session and event IDs, human prompt text or recoverable transcript references, timestamps and source classification; add post-tool results where supported and explicitly mark missing capabilities.
- [ ] Capture selected original tool outcomes before compactToolCall projects them, with workspace and affected-project identities, successful versus failed actions, and source references.
- [ ] Apply privacy exclusions and redaction before storage and inference; omit retrieval responses, injected memory, observer output, repeated reminders and agent-authored coordinator prompts from human preference evidence.
- [ ] Persist accepted events and processing state transactionally before acknowledging capture; keep slow inference outside hooks, bound queue growth, measure capture and storage-adapter latency at representative volume before choosing per-event process calls or one native worker, and expose capture failures without blocking the original coding tool.
- [ ] Verify parallel sessions, replay and reordering, interruption, restart recovery, redaction and actual native/portable event envelopes; document which MCP-only hosts support explicit memory but not automatic capture.

## Status

What exists today, with the ledger unit that owns the rest.

## Open questions

-

## Related

- [[Home]]

## Sources

-
