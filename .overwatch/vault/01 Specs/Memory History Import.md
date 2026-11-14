---
title: Memory History Import
category: behavior
status: target
proposals: []
issues: []
updated: 2026-11-14
tags: [spec]
depends: [Memory Identity and Store]
checks: [bun test ./memory/import.test.ts]
paths: [memory/import.ts, memory/import.test.ts, memory/fixtures/]
---

# Memory History Import

## Summary

Build a repeatable importer into the shared record contract. Inspect the installed claude-mem schema and auxiliary data, preserve original relationships and user decisions, and leave the source installation usable. The real cutover belongs to Memory Cutover.

## Rules

-

## Plan

- [ ] Inventory the installed version, database schema, auxiliary work-view ledgers, work-state lists, knowledge corpora, media references and rule-file imports; create a consistent backup and dry-run report with counts, mappings and unsupported items.
- [ ] Import sessions, observations, summaries, human prompts and available tool I/O with source-database, entity-kind and old-ID namespaces; preserve dates, platform, working directory, authority, revision, source links and redaction or truncation metadata.
- [ ] Preserve owner-goals history, focus areas, requests and conversation links, reviews and review basis, suggested and accepted rules, scopes, user wording, dismissals, merges, replacements and corrections; retain corpus definitions and unresolved work state without creating duplicate authoritative tasks.
- [ ] Resolve legacy project labels through explicit aliases; keep unresolved mappings visible and distinguish records about Overwatch filed under language from actual repository identity.
- [ ] Test restartable and idempotent import, content hashes, counts and foreign-source links against versioned synthetic fixtures; keep source data immutable and prepare known-answer recall fixtures from the real inventory.

## Status

What exists today, with the ledger unit that owns the rest.

## Open questions

-

## Related

- [[Home]]

## Sources

-
