---
title: Cross Project Synchronization
category: protocol
status: target
proposals: []
issues: []
updated: 2026-11-14
tags: [spec]
checks: [bun test, bun test ./hooks/sync.check.ts ./bin/sync-transaction.check.ts ./bin/sync-runtime.check.ts ./host/sync.check.ts, bun test ./host/host.check.ts, bun bin/cli.ts hygiene --selftest, claude plugin validate ., claude plugin test .]
paths: [hooks/sync.ts, hooks/sync.check.ts, bin/sync-transaction.ts, bin/sync-transaction.check.ts, data/sync-manifest.json, data/shared/OVERWATCH.md, hooks/commands.ts, bin/cli.ts, host/core.ts, host/mcp.ts, hooks/overwatch.ts, host/sync.check.ts, docs/REFERENCE.md, CHANGELOG.md, install.txt, bin/sync-runtime.ts, bin/sync-runtime.check.ts, package.json, .claude-plugin/plugin.json, .codex-plugin/plugin.json, .cursor-plugin/plugin.json, hooks/commands.test.ts, .github/plugin/plugin.json]
owner: codex@7c1c7266
since: 2026-11-14T13:32:48.419Z
---

# Cross Project Synchronization

## Summary

Keep every project on a verified central Overwatch Git commit through one shared synchronization core. Track installed commit, migration/vault/workflow versions, capabilities and extensions; migrate only explicitly owned infrastructure using recoverable transactions, preserve custom files and active claims, and share sync check/migrate/verify across MCP, CLI and initialization.

## Rules

- Source Git commits, migration versions, installed files and loaded runtime provenance are distinct evidence.
- Only explicitly owned, unchanged infrastructure may migrate; preserve custom files, keys, plans, guards and claims.
- Keep one shared runtime; update only through a clean, claimed-safe fast-forward.
- Recover interrupted transactions using recorded before/after evidence; refuse unknown writes and live locks.
- Configure machine-local authority once and use the same core from MCP, CLI and startup.

## Plan

- [ ] Reconcile the central and running committed Overwatch revisions without changing active work.
- [ ] Implement explicit ownership, version provenance and safe incremental migration transactions.
- [ ] Expose the same synchronization operations through MCP, CLI and initialization events.
- [ ] Verify fresh, stale, skipped-version, customized, dirty, interrupted, concurrent, repeated and offline cases.
- [ ] Publish the verified shared commit and validate compatibility and preserved customizations in every reachable project.

## Status

What exists today, with the ledger unit that owns the rest.

## Open questions

-

## Related

- [[Home]]

## Sources

-

## Integration hold (2026-11-14)

Synchronization-specific native checks pass 52 tests / 406 assertions against unchanged source fingerprints (run mwgiw0e4, exit 0). Portable Bun passes 145 with 19 hook-engine cases skipped; Claude plugin tests pass 164. Hygiene and plugin validation pass. The required host gate fails identically in unchanged installed commit3ee8a59 because the Windows background launch AND-list retains its pipe (1139ms versus800ms); Integration Discovery and Recovery owns that repair. No timing assertion was weakened.

Native suites use .check.ts to remain outside the hook sandbox. This note records the correct explicit ./ command paths. The already-loaded session retains earlier .test.ts guard commands; the current API cannot amend them without clearing protected evidence, so they remain visible and unit_record is not claimed.

Shared rollout must reconcile the active Integration Discovery and Recovery and Project Chat Runtime work first. A separate coordination unit is recorded in the central D-drive vault. No project receipts, global authority pointer, plugin cache, shared runtime, or live process has been changed by this work.
