# Native memory and intent for Overwatch

Status: implementation plan. No memory replacement, migration, or removal has been performed.
Date: 2026-11-14.
Owner outcome: replace claude-mem and work through Overwatch for project awareness, learning, recall, preferences, and useful suggestions.
Canonical execution records: .overwatch/vault/02 PRDs/Native Memory and Intent.md and its linked units.

## Goal and completion

Overwatch owns the entire useful loop: capture attributable experience and human intent, retain durable records, retrieve relevant evidence, supply applicable rules, and suggest useful next work. The installed result must operate with claude-mem stopped. The final cutover includes historical import, real multi-session proof, configuration cleanup, and a verified rollback path.

A database import alone is insufficient. Claude-mem's ordinary memory observer and its separate goals/preferences/progress analysis supply different behavior. The replacement covers both.

## Current baseline and constraints

The target is D:/dev/overwatch. Inspection found HEAD 5c6dddd98d5283a494f5d582121a6e1cc8c20f2e, no live spec vault, and existing edits to the wave planner, vault code/tests, reference, and seed vault. Those edits belong to existing work and must be preserved. Refresh this baseline, git status, instructions and live claims before implementation.

Overwatch already supplies plans, guards, claims, PRDs, unit evidence, procedural lessons and exact native context archives. Its current portable host events lack complete human prompt/session data and post-tool outcomes. Automatic capture cannot be claimed for a host merely because it can call MCP tools.

Follow WORK.md: policy logic takes Io; native hooks do not import Bun/Node. Keep working data under the selected Overwatch workspace's .overwatch directory. A stable project registry provides explicit project scopes and aliases within the owning store; do not silently add a home-wide database, scan unrelated directories, or replicate authoritative state between stores. If wider installation routing is required, document one explicit storage owner and project registration contract before wiring hosts.

## Shared record contract

The first unit owns and freezes the contract needed by parallel units:

- Project: stable ID, canonical repository identity, registered checkout roots and historical name aliases. Branch, worktree and commit describe a checkout or event, not a new repository identity.
- Session and source: actual host/platform, session ID, event ID, timestamp, author class, capture workspace and affected project IDs. Preserve unknown fields as unknown; do not synthesize attribution from directory basenames.
- Evidence: original prompt/tool/transcript reference or retained source text, content hash, file/commit references, failure state, privacy filtering and explicit truncation metadata.
- Knowledge: typed fact, discovery, decision, summary, goal, request or working rule, plus source references and authority.
- Authority: direct user instruction, verified outcome, observed historical claim or model inference. Stored success is historical evidence, never a fresh guard result.
- Change: corrects/supersedes relations, effective scope, accepted/dismissed/superseded state and preserved prior evidence.
- Delivery: unique event/import identity, transactionally committed processing receipt, schema version and uncertain external-call state.

Keep model confidence separate from authority. Repetition may affect relevance, but cannot promote an inference into a direct instruction.

## Native architecture

Use Bun's built-in SQLite behind a small machine-side adapter reached through Io. Define transactional writes, unique event keys and atomic record-plus-processing commits. Do not reuse unlocked JSON read-modify-write ledgers for reliable capture. Verify the installed SQLite full-text capability rather than assuming it.

One owning subsystem under memory/ contains project identity, storage contracts, evidence records, capture, retrieval, extraction, intent/rules, import and suggestions. Public registration belongs to the integration unit. Existing tasks, guard state, vault notes, incident lessons and proof receipts retain their current owners.

Capture selected originals before live compaction reduces them. Apply private-content filtering before both persistence and inference. Persist acknowledged events; keep inference outside the coding tool's latency path. Exclude memory retrieval results, injected context, observer output and repeated reminders from recapture. Human preference extraction must not treat assistant-written launch prompts as user instructions.

Use structured work directly: unit_record and prd_collect already know the outcome, limitations, commit and check receipts. These records need no summarizing model. A provider-enabled worker may interpret useful unstructured new evidence in bounded batches. It must use an explicitly suitable provider, expose cost, preserve uncertain failures and avoid automatic repeated billable requests after ambiguous delivery.

## How learning and suggestions work

Learning means maintaining sourced, correctable records. It does not require training model weights or an entity graph.

Human intent has three forms: ongoing goals, finishable requests and working rules. Direct user instructions take effect under their actual scope without a redundant approval round. Inferred preferences remain candidates until adopted. Quote validation checks human-source text; corrections and dismissals persist through later extraction and rephrasing.

Recall combines project identity, current request, active unit, file references, applicable rules and useful history. Return a compact index first, chronological neighbors where useful, and exact selected details on demand. Enforce complete serialized budgets and disclose omissions through retrieval. Use the existing overall prompt/output budget; new memory is a reserved part of it, not another unbounded block. The implementation must document and test its concrete limits before integration.

Text and structured-field search are the initial implementation. A fixed recall set must include paraphrases as well as exact terms. If semantic recall is needed to satisfy those cases, implement an Overwatch-owned semantic index before claiming parity; do not keep claude-mem as a hidden dependency.

Suggestions read current goals, requests, vault readiness, dependencies, claims and check evidence. Rank deterministic signals first. A suggestion carries the action, supporting goal, source IDs, priority reason, blockers and uncertainty. Historical memories and model-generated progress assessments cannot complete work or bypass checks. Suggestions never silently add tasks or take claims. Refresh on changed relevant evidence or explicit request; unchanged inputs should not cause another model call.

## Dependency plan

| Wave | Units | Completion boundary |
| --- | --- | --- |
| 1 | Memory Identity and Store | Stable contracts, identity and transactional storage |
| 2 | Memory Evidence and Corrections; Memory Retrieval and Recall; Memory History Import | Three independent implementation scopes |
| 3 | Memory Human and Tool Capture | Attributed durable event capture through actual hosts |
| 4 | Memory Bounded Learning | Validated, budgeted observation extraction |
| 5 | Memory Intent and Working Rules | Goals, requests, rules and durable user decisions |
| 6 | Memory Evidence Based Suggestions | Recommendations tied to current goals and evidence |
| 7 | Memory Public Integration | One usable Overwatch tool/context path |
| 8 | Memory Cutover | Real migration, installed proof, retirement and rollback |

The native vault computes the actual wave plan from depends; this table explains it. Only Memory Identity and Store is initially ready. Units in wave 2 own disjoint files. Register tools and wire shared prompt surfaces in the integration unit rather than in every parallel worker. Central capture changes have one owner. Refresh path claims before taking any unit, especially existing dirty vault/planner files.

Every unit has five test-sized Plan items, path ownership and prospective closure commands. New memory test paths are deliverables to create, not tests that exist or pass today. Add focused regressions derived from behavior. Use the existing required repository gates for the combined result, and report unavailable installed-host or provider checks as unknown rather than passed.

## Migration scope

Inventory the actual installed schema and auxiliary ledgers before writing an importer mapping. Read a consistent export/backup; never mutate the only source copy. Preserve source IDs under a source-database + entity-kind + old-ID namespace.

Cover sessions, observations, summaries, human prompts, available raw tool I/O and their privacy/truncation markers. Also account for:

- Current and historical owner-goals lists.
- Focus areas, memberships, kept/dismissed/merged decisions and ordering.
- Rules, their scopes and supporting quotes, suggestions, approvals, owner wording, corrections and dismissals.
- Work-view story preferences and request/grouping/progress ledgers, including review basis.
- Other working-state lists and unresolved requests.
- Knowledge-corpus definitions and referenced media or a documented readable preservation path.
- Existing rule-file instruction imports and actual host/MCP/gateway registration.

Imported historical completion claims do not create fresh Overwatch proof. Preserve working lists as source records, then reconcile deliberately with the existing vault instead of manufacturing a second plan.

Existing source observation IDs 75 and 196 are candidate recall fixtures if present in the inventoried installation; retain their namespaced identities rather than hard-coding their meaning into production behavior. The actual source may differ from the endpoint inspected earlier.

## Retirement proof

With claude-mem stopped, a fresh actual host session must retrieve an old decision, a later correction, an active rule and an unresolved request with their original sources. Record a new human instruction and a technical finding, restart, and retrieve them again with the correct project and author.

Verify parallel delivery and restart behavior, bounded prompt/inference usage, suggestions respecting current dependencies/claims, and continued operation of existing guard and compaction behavior. Compare source inventory counts/content and repeat the import to prove idempotence.

Only after those checks remove the inventoried claude-mem capture hooks, MCP mappings, observer startup and obsolete rule-file imports. Verify the authenticated Tailscale Overwatch route and unrelated services. Keep data/configuration backups and record rollback and migration receipts. Planning this work does not disable the existing installation.

## Source evidence

Upstream source was reviewed at claude-mem 0c488b54e761d7f6f4091b3a6e1958712f13b19d (v15.18.3). These explain the observed mechanisms, not a requirement to copy its runtime:

- [Project identity](https://github.com/thedotmack/claude-mem/blob/0c488b54e761d7f6f4091b3a6e1958712f13b19d/src/utils/project-name.ts)
- [Observer instructions](https://github.com/thedotmack/claude-mem/blob/0c488b54e761d7f6f4091b3a6e1958712f13b19d/plugin/modes/code.json)
- [Context selection](https://github.com/thedotmack/claude-mem/blob/0c488b54e761d7f6f4091b3a6e1958712f13b19d/src/services/context/ObservationCompiler.ts)
- [Owner goals](https://github.com/thedotmack/claude-mem/blob/0c488b54e761d7f6f4091b3a6e1958712f13b19d/plugin/skills/owner-goals/SKILL.md)
- [Rule authority](https://github.com/thedotmack/claude-mem/blob/0c488b54e761d7f6f4091b3a6e1958712f13b19d/src/services/work-view/my-rules.mjs)
- [Suggestion and review pipeline](https://github.com/thedotmack/claude-mem/blob/0c488b54e761d7f6f4091b3a6e1958712f13b19d/src/services/work-view/refresh-task.ts)
- [Bun SQLite](https://bun.com/docs/runtime/sqlite)

Local contracts: WORK.md, hooks/io.ts, hooks/overwatch.ts, hooks/compaction.ts, hooks/vault.ts, hooks/prd.ts, host/core.ts, docs/REFERENCE.md and docs/HOSTS.md. Re-read the implementation and installed configuration when each unit starts.
