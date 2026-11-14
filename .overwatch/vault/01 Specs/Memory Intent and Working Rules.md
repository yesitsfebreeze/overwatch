---
title: Memory Intent and Working Rules
category: behavior
status: target
proposals: []
issues: []
updated: 2026-11-14
tags: [spec]
depends: [Memory Bounded Learning]
checks: [bun test ./memory/intent.test.ts ./memory/rules.test.ts]
paths: [memory/intent.ts, memory/intent.test.ts, memory/rules.ts, memory/rules.test.ts]
---

# Memory Intent and Working Rules

## Summary

Maintain what the user wants and how work should be done, with explicit authority and correction history. Preserve direct instructions without an extra approval round; model-inferred preferences remain suggestions until adopted.

## Rules

-

## Plan

- [ ] Classify attributable human statements into ongoing goals, finishable requests and working rules, preserving source quotes, scope, dates and explicit-versus-inferred status; split compound statements without losing their source.
- [ ] Validate every supporting quote against retained human text; reject assistant or coordinator prompts, tool output and recalled summaries as evidence of user preference.
- [ ] Process only changed evidence, preserve prior interpretations and owner decisions, and connect corrections through supersession; never promote repetition or model confidence into explicit user authority.
- [ ] Support direct, suggested, accepted, dismissed and superseded rules under actual project, situation or general scopes; preserve accepted wording and ensure dismissals survive rephrasing and later extraction.
- [ ] Test scope isolation, new user corrections, fabricated quotes, duplicate processing and accepted or dismissed rule preservation; expose applicable rules to the shared recall interface without editing central prompt hooks here.

## Status

What exists today, with the ledger unit that owns the rest.

## Open questions

-

## Related

- [[Home]]

## Sources

-
