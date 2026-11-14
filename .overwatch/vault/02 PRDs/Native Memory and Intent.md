---
title: Native Memory and Intent
status: specced
priority: 90
parent:
needs: []
footprint: [memory/, hooks/, host/, adapters/, bin/, docs/, install.txt, CHANGELOG.md]
checks: [bun test, bun test ./host/host.check.ts, bun bin/overwatch hygiene --selftest, claude plugin validate ., claude plugin test .]
created: 2026-11-14
updated: 2026-11-14
---

# Native Memory and Intent

## Summary

Replace claude-mem with Overwatch-owned project memory, learning, relevant recall, and explainable suggestions. Preserve existing history and user decisions, keep vault plans and executable evidence authoritative, and retire claude-mem only after an installed multi-session proof. The implementation contract and sources are in docs/native-memory-plan.md.

## Acceptance

- [ ] With claude-mem stopped, a fresh Overwatch session recalls an existing decision, its later correction, an active working rule, and an unresolved request with resolvable original sources.
- [ ] A new attributed human instruction and a useful technical finding survive restart and are recalled in a later relevant session; agent-written prompts and retrieved memory never become human preference evidence.
- [ ] Stable project IDs distinguish same-named repositories, survive renamed checkouts and worktrees, and distinguish the session workspace from each record's affected project; cross-project retrieval is explicit.
- [ ] Concurrent sessions, duplicate delivery, interrupted writes and interrupted processing preserve committed evidence without duplicate observations or silently lost acknowledged events.
- [ ] Direct instructions, verified outcomes, historical claims, inferred preferences, accepted rules, dismissals and superseded claims remain distinguishable; current instructions and current proof govern behavior.
- [ ] Suggestions cite the goal and current evidence behind them, respect dependencies and live claims, and never mark tasks complete or uphold guards from remembered or inferred success.
- [ ] The actual installed claude-mem database and auxiliary ledgers are inventoried and migrated repeatably, including goals, rules, user decisions, grouped requests, working state and corpus definitions or a documented readable preservation path.
- [ ] Recall and public tool responses obey complete serialized budgets; inference runs only on useful new evidence with explicit provider configuration, bounded requests and separate usage accounting.
- [ ] Every actually used host has documented, verified capture/recall support; MCP-only clients remain correctly described where automatic event capture is unavailable.
- [ ] After backup and rollback verification, only Overwatch owns capture, retrieval, rule injection and suggestions through the installed hosts and published Tailscale workspace; unrelated services remain available.
- [ ] Existing plans, guards, claims, exact compaction recovery and repository verification gates continue to work in the combined installed result.

## Specs

- [[Memory Identity and Store]]
- [[Memory Evidence and Corrections]]
- [[Memory Retrieval and Recall]]
- [[Memory History Import]]
- [[Memory Human and Tool Capture]]
- [[Memory Bounded Learning]]
- [[Memory Intent and Working Rules]]
- [[Memory Evidence Based Suggestions]]
- [[Memory Public Integration]]
- [[Memory Cutover]]

## Review

<!-- prd_review appends one line per round: - round 1 · 92/100 · digest … · date · reviewer.
     The digest covers this PRD's acceptance text and checks plus every linked unit's Plan items
     and checks, so editing any of them makes the round stale. 90/100 within 5 rounds. -->
- round 1 · 96/100 · digest 988af768aff7484d · 2026-11-14 · /root/overwatch_architecture
  - finding: Reviewed the saved PRD, design document, all ten linked units and three refinements. No blocking findings. Covers native memory, project identity, human intent/rules and evidence-based suggestions; preserves authoritative state and workspace-local storage; requires live-session proof before retirement. Direct-instruction recall, capture latency measurement and installed cutover receipts are explicit. Implementation and live acceptance remain prospective.

## Status

Implementation is planned, not delivered. Ten target units contain fifty open Plan items. The design and source evidence are in docs/native-memory-plan.md. Current claude-mem remains installed until Memory Cutover proves the replacement.

## Collection

<!-- prd_collect writes the receipt here: commit, review round, units, checks. -->
