---
title: Memory Public Integration
category: protocol
status: target
proposals: []
issues: []
updated: 2026-11-14
tags: [spec]
depends: [Memory Retrieval and Recall, Memory History Import, Memory Human and Tool Capture, Memory Bounded Learning, Memory Intent and Working Rules, Memory Evidence Based Suggestions]
checks: [bun test ./memory/integration.test.ts, bun test ./host/host.check.ts, bun test]
paths: [memory/integration.test.ts, hooks/commands.ts, hooks/overwatch.ts, hooks/compaction.ts, host/core.ts, host/mcp.ts, bin/cli.ts, .claude-plugin/, .codex-plugin/, .cursor-plugin/, docs/REFERENCE.md, docs/HOSTS.md, install.txt, CHANGELOG.md]
---

# Memory Public Integration

## Summary

Expose one complete native memory path through Overwatch's tools, CLI and host adapters. Integrate startup and task recall with the existing prompt and compaction machinery, and document actual host capabilities.

## Rules

-

## Plan

- [ ] Register explicit recording, search, timeline, selected details, project identity, intent/rules feedback and suggestions through the existing tool catalog and portable dispatch; use one bounded contract across CLI and MCP.
- [ ] Wire one recall composition owner into startup and meaningful task changes, respecting existing total context limits, frozen-prefix reuse and compact-triggered SessionStart suppression.
- [ ] Connect the capture and extraction lifecycle without duplicate observers or injections; failure of optional memory must not disable existing edit gates, checks, task state or exact archive retrieval.
- [ ] Expose inventory, dry-run import, migration reports and health/accounting commands with safe defaults; update canonical behavior, host capability documentation, installation instructions and changelog for actual shipped behavior.
- [ ] Verify integrated public-tool contracts, malformed and denied calls, native hooks, portable hosts, restart and compaction behavior, provider-disabled operation and all relevant repository gates.

## Status

What exists today, with the ledger unit that owns the rest.

## Open questions

-

## Related

- [[Home]]

## Sources

-
