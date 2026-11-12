# overwatch

Catches a coding agent misbehaving, records it, and makes the next session better.

```
/plugin install overwatch --marketplace yesitsfebreeze/overwatch
```

Any other agent: [docs/HOSTS.md](docs/HOSTS.md) has the matrix and install steps.

## What it enforces

| rule | effect |
|---|---|
| Plan first | Write/Edit are refused until the plan has a task and a yes/no guard. |
| Evidence before done | Stop is refused while a task is open or a guard is unupheld. On Claude Code, 10+ changed lines need `/simplify`; 50+ need `/code-review` first. |
| Feedback | Every catch lands in `.overwatch/incidents.json`; a kind caught 3 times in 30 days puts its lesson into later prompts. |
| No loops | Three refusals with nothing changed, or eight refused stops in one prompt. |

The edit gate and stop hold apply only where the host runs hooks.

## Guards

A guard is one yes/no question about the finished work. Give it a shell `check`
where a command decides it: exit 0 = upheld. Without one, a model judges from the
last turn and the listed files.

```
guard_add {question:"Do the tests pass?", check:"bun test"}
guard_add {question:"Does README list every plugin?", files:["README.md"]}
```

## Durable work

- **Spec vault** — `.overwatch/vault`, an Obsidian vault git tracks. One note per
  unit: checks, paths, dependencies, a test-sized Plan checklist. `unit_load`
  turns a ready unit into tasks and guards; `unit_record` closes it with proof and
  an evidence run.
- **PRDs** — outcomes above units. Acceptance boxes, dependencies and checks; an
  independent review gates collection. `prd_collect` refuses until every
  box, unit, review and check passes at HEAD.
- **Claims** — owner plus `since` and a path-clash refusal, so parallel sessions
  do not overlap.

## Other parts

compaction, followline, surface, launch, gardener, hygiene, loadout and changelog — see [docs/REFERENCE.md](docs/REFERENCE.md#parts).

Every tool is `mcp__overwatch__<name>` in Claude Code; [docs/REFERENCE.md](docs/REFERENCE.md#tools) names it on each host. A refusal says what to do next, and `plan_show` shows tasks and guards.

## State

Plain files in `.overwatch/`; [docs/REFERENCE.md](docs/REFERENCE.md#state) lists
them and the gitignore rule that keeps the vault tracked.

## Needs

- `bun`
- `TYPESAFE_API_KEY` for judged guards and compaction ([details](docs/REFERENCE.md#needs-and-settings)).
- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`

## Verify

Proof commands live in [docs/REFERENCE.md](docs/REFERENCE.md#check).

## More

[install.txt](install.txt) is the canonical step-by-step for any agent;
[CHANGELOG.md](CHANGELOG.md) has one section per version.
