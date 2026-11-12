# overwatch

Catches a coding agent misbehaving, records it, and makes the next session better.

A coding agent with a supervisor: every edit needs a plan, every stop needs
evidence, and every catch becomes a lesson.

```
/plugin install overwatch --marketplace yesitsfebreeze/overwatch
```

Any other agent: [docs/HOSTS.md](docs/HOSTS.md). One core, adapters for Codex CLI,
pi, opencode, Hermes Agent, Gemini CLI, Copilot CLI, Cursor and Factory Droid.

## What it enforces

| rule | effect |
|---|---|
| Plan first | Write/Edit are refused until the session has tasks and one yes/no guard per deliverable. |
| Evidence before done | Stop is refused while a task is open or a guard is unupheld. 10+ changed lines need `/simplify`; 50+ need `/code-review` first. |
| Feedback | Every catch lands in `.overwatch/incidents.json`; a kind caught 3 times in 30 days puts its lesson into later prompts. |
| No loops | Three refusals with nothing changed, or eight since the user spoke, let the stop through. |

## A session

1. Ask for a change. The agent adds tasks and guards.
2. It works, updating progress and running the guards' shell checks.
3. Before stopping it runs `/simplify`, and `/code-review` for a large change.
4. Stop is allowed only when the plan and the evidence agree.

## Guards

A guard is one yes/no question about the finished work. Give it a shell `check`
where a command decides it: exit 0 = upheld. Without one, a model judges from the
last turn and the listed files.

```
guard_add {question:"Do the tests pass?", check:"bun test", tier:"unit"}
guard_add {question:"Does README list every plugin?", files:["README.md"]}
```

Tiers (`fast`, `unit`, `milestone`) let `guard_check` run one weight at a time.

## Durable work

- **Spec vault** — `.overwatch/vault`, an Obsidian vault git tracks. One note per
  unit: checks, paths, dependencies, a test-sized Plan checklist. `unit_load`
  turns a ready unit into tasks and guards; `unit_record` closes it with proof and
  an evidence run.
- **PRDs** — outcomes above units. Acceptance boxes, dependencies and checks; an
  independent review gates collection at 90+. `prd_collect` refuses until every
  box, unit, review and check passes at HEAD.
- **Claims** — owner plus `since`, a 15-minute stale window and path-clash refusal,
  so parallel sessions do not overlap.

## Other parts

| part | does |
|---|---|
| compaction | minifies tool results, folds old history into indexes, reads back with `decompress` / `search_context` |
| followline | one line above the prompt: mood face plus one gauge per slot |
| surface | tool-usage ledger, learned triggers, frozen checks, mistakes (`/overwatch`) |
| launch | slow commands in the background, logs in `.overwatch/launch/` |
| gardener | frees a nearly full disk (`/gardener`) |
| hygiene | rates a repo's `skills/` and files one issue per finding (`/hygiene`) |
| loadout | active plugins per layer (`/loadout`) |
| changelog | one CHANGELOG.md section per version, history from git |

Every tool is `mcp__overwatch__<name>`; a refusal says what to do next, and
`plan_show` shows tasks and guards. Full tool signatures and part internals:
[docs/REFERENCE.md](docs/REFERENCE.md).

## State

Plain files in `.overwatch/` beside the project: incidents, plan, frozen checks,
mistakes, vault, evidence, folded context. The agent asks once to gitignore it.

## Needs

- `bun`
- `TYPESAFE_API_KEY` in the shell profile for compaction and judged guards;
  without it only guards with a `check` hold the stop
- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`

## Verify

```sh
claude plugin validate .
claude plugin test .           # every part
bin/overwatch hygiene --selftest
bun test ./host/host.check.ts  # the core other agents run
```

## More

- [docs/REFERENCE.md](docs/REFERENCE.md) — tools, tasks and guards, spec vault,
  PRDs, disk gardener, state files, settings, layout.
- [docs/HOSTS.md](docs/HOSTS.md) — every host, install steps, limits, updating.
- [install.txt](install.txt) — the canonical step-by-step for any agent.
- [CHANGELOG.md](CHANGELOG.md) — one section per version.
