---
name: hygiene
description: Lint and rank the skills in one repository's skills/ folder: writes LEDGER.md (ranking, duplicates, dependencies, findings) and syncs one GitHub issue per finding. Use when the user asks to rate, review or clean up the skills in a repo, wants a skill ledger, asks which skills duplicate or depend on each other, or says "/hygiene". Not for writing a new skill, reviewing application code, or ranking installed plugins (that is gemify).
allowed-tools: Read, Glob, Grep, mcp__overwatch__hygiene_ledger, Bash(*/bin/overwatch *), Bash(gh *)
---

# hygiene

Goal: every skill in `skills/` carries its own weight and can be swapped without another noticing. The command measures; you judge, always.

## 1. Measure

`mcp__overwatch__hygiene_ledger {repo?}` writes the ledger and returns the summary. From the binary:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/overwatch hygiene [repo]            # writes <repo>/LEDGER.md
${CLAUDE_PLUGIN_ROOT}/bin/overwatch hygiene [repo] --issues   # also syncs GitHub issues (needs gh auth)
${CLAUDE_PLUGIN_ROOT}/bin/overwatch hygiene --selftest
```

`repo` is the folder that holds `skills/`: the current directory when it has one, else the overwatch plugin.

`LEDGER.md` has four tables: **Ranking** (score, local usage count, why it exists), **Duplicates**, **Dependencies** and **Findings** (high first). Score starts at 100; a high finding costs 25, medium 10, low 5. `used` counts Skill-tool invocations in local transcripts only.

| Rule | Severity | Meaning |
|---|---|---|
| `missing-skill-md` | high | folder without `SKILL.md` |
| `name-mismatch` | high | frontmatter `name` differs from the folder name |
| `description-missing` | high | nothing to route on |
| `dead-reference` | high | names a `.md` file that does not exist |
| `dependency-external` | high | requires a skill not in this repo |
| `dependency-internal` | medium | requires, slash-invokes or paths into another skill here |
| `description-short` | medium | under 80 characters |
| `description-long` | medium | over 1024 characters; the tail is cut |
| `no-triggers` | medium | no "when", no quoted phrase, no keyword list |
| `duplicate` | medium / low | near-identical text / much shared vocabulary: judge it |
| `oversize` | low | `SKILL.md` over 500 lines |
| `orphan-file` | low | a file `SKILL.md` never mentions |

A dependency needs evidence: `requires:` in frontmatter, "requires the X skill" in prose, a backticked `` `/x` `` or `` `x` `` naming a repo skill, or a path into another skill's folder. A bare word is not one.

## 2. Judge

1. **Why it exists.** The ranking column is the description's first sentence. If it does not say what the skill is for, fix the description.
2. **Is a duplicate real?** Two skills that would trigger on the same sentence are; two testing skills for two frameworks are not. Merge, sharpen both descriptions, or keep with one line saying why.
3. **Is a dependency justified?** The goal is none. Inline the needed part, cut the reference, or keep it and say why in the issue. "Pairs well with X" is not a dependency: write it that way.

Your own findings become issues by hand: title `[hygiene] <skill>: <what>`, label `hygiene`.

## 3. Issues

`--issues` opens one issue per medium or high finding, titled `[hygiene] <skill>: <rule>`, labelled `hygiene`. Titles are stable, so reruns never duplicate; a finding that disappears closes its issue. Low findings live in the ledger only. If the repo runs Prettier over markdown, add `LEDGER.md` to `.prettierignore`.

## Done means

- `LEDGER.md` regenerated and committed with the change that caused it
- every medium or high finding fixed or with an open issue
- every duplicate and dependency decided, in the issue or the skill's description
