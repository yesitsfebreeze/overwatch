# WORK.md

How to work in this repository. `/overwatch:work` reads this file every iteration.

## What this is

Overwatch: core plus per-host adapters (Claude Code, Codex, pi, opencode, Hermes, Gemini CLI, Copilot CLI, Cursor, Factory Droid). Holds every agent stop until tasks are done and guards upheld. Runtime is `bun`, TypeScript, ESM.

## Layout

- `hooks/overwatch.ts`: the one hooks module. Calls each part; parts never import each other's hooks.
- `hooks/*.ts`: one file per part (`plan`, `prd`, `vault`, `compaction`, `followline`, `surface`, `gardener`, `hygiene`, `launch`, `usage`, `review`, `wave`, ...). Tests sit beside them as `*.test.ts` or `*.check.ts`.
- `hooks/io.ts`: the one door to the machine. Logic takes an `Io`; do not call fs or shell directly from logic.
- `host/`: portable core (`core.ts`, `hooks.ts`, `mcp.ts`) other hosts run. `adapters/<host>/`: thin per-host glue.
- `bin/overwatch`: CLI, `overwatch mcp`, `overwatch hook <host> <event>`.
- `skills/`: plugin skills (`plan`, `prd`, `overwatch`, `work`, ...). `jev/`: judge client. `bench/`: replay benchmark. `types/`: shared types.
- `docs/REFERENCE.md`: canonical behavior spec. `docs/HOSTS.md`: host matrix. `install.txt`: install steps. `CHANGELOG.md`: one section per version.
- `data/vault/`: seed spec vault. A project's live vault is `.overwatch/vault`.

## Verify

Run the smallest proof that covers the change; run all before declaring done.

```sh
bun test                        # unit tests
bun test ./host/host.check.ts   # core other hosts run
bin/overwatch hygiene --selftest
claude plugin validate .
claude plugin test .
```

A change to a tool schema or hook behavior also needs `docs/REFERENCE.md` updated and a `CHANGELOG.md` entry.

## Rules

- Trace behavior before editing. Fix root cause at the owning layer. No speculative features, no config for fixed values.
- Every non-trivial branch gets a test that fails if it breaks.
- Plain files in `.overwatch/` are state; never hand-edit them. Use the tools.
- Never skip hooks, never drop or reword a guard to pass a stop. A guard that cannot be met goes to the user.
- Never fake progress: no mocks, hardcoded success, or disabled checks.
- Commit only on clean evidence. Message style: imperative, one line, matches `git log`.
- Unrelated dirty files in `git status` belong to someone else: do not revert or commit them.

## Work loop (one iteration)

Pick one outcome, finish it, stop. The caller loops (`/loop /overwatch:work`).

1. **Orient.** `git status`, `plan_show`. Open tasks or unmet guards exist: finish those first.
2. **Pick.** Spec vault present: `prd_next`, then `prd_brief {prd}`; an open unit: `unit_load {unit}`. Otherwise take the highest-value item in this order: failing tests or checks, open TODOs in `CHANGELOG.md` or `docs`, entries from `mistakes`, simplification or dead code, missing tests for non-trivial logic. Nothing found: go to step 7.
3. **Plan.** `task_add` plus 2 to 6 `guard_add` (shell `check` where a command decides).
4. **Build.** Smallest correct change, per Rules. `task_progress`, `task_complete`.
5. **Prove.** Run the Verify commands that apply; `guard_check`. Review passes when due: `/code-review` at 50+ changed lines, `/simplify` at 10+.
6. **Close.** Unit: `unit_record`. PRD complete: `prd_collect`. Commit. One line of result: what changed, proof, next candidate.
7. **Idle.** Nothing worth doing: say so in one line and end the turn without edits. Do not invent work.

## Stop conditions

End the iteration (not the loop) on: a decision only the user can make (use AskUserQuestion), a guard that cannot be met (say why), or a destructive step ahead (confirm first).
