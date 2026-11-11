---
name: hygiene
description: Lint and rank the skills in one repository's skills/ folder: writes LEDGER.md (ranking, duplicates, dependencies, findings) and syncs one GitHub issue per finding. Use when the user asks to rate, review or clean up the skills in a repo, wants a skill ledger, asks which skills duplicate or depend on each other, or says "/hygiene". Not for writing a new skill, reviewing application code, or ranking installed plugins (that is gemify).
allowed-tools: Read, Glob, Grep, mcp__overwatch__hygiene_ledger, Bash(*/bin/overwatch *), Bash(gh *)
---

# hygiene

One job: every skill in `skills/` carries its own weight and can be swapped in
or out without another skill noticing. This skill measures that, writes the
ledger, and turns what is wrong into issues.

Two halves. The command measures; you judge. Never skip the second half — the
command points, it does not decide.

## 1. Measure

`mcp__overwatch__hygiene_ledger {repo?}` writes the ledger and returns the
summary. The issue sync and the self-test run from the overwatch binary:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/overwatch hygiene [repo]            # writes <repo>/LEDGER.md
${CLAUDE_PLUGIN_ROOT}/bin/overwatch hygiene [repo] --issues   # also syncs that repo's GitHub issues (needs gh auth)
${CLAUDE_PLUGIN_ROOT}/bin/overwatch hygiene --selftest        # its own check
```

`repo` is the folder that holds `skills/`. It defaults to the current
directory when that has a `skills/` folder, else to the overwatch plugin
itself. Run it from inside the repo to review, and the default is right.

`LEDGER.md` has four tables:

| Table        | What it answers                                                   |
| ------------ | ----------------------------------------------------------------- |
| Ranking      | best-performing first: score, local usage count, why it exists    |
| Duplicates   | pairs whose descriptions overlap in vocabulary or text            |
| Dependencies | skills that require, invoke or path into another skill           |
| Findings     | every rule that fired, high first — the raw material for issues   |

Score starts at 100. A high finding costs 25, medium 10, low 5. `used` counts
Skill-tool invocations in the local Claude transcripts under
`~/.claude/projects`; usage is a local signal only.

### The rules

| Rule                  | Severity | Meaning                                                              |
| --------------------- | -------- | -------------------------------------------------------------------- |
| `missing-skill-md`    | high     | folder without `SKILL.md`; the skill cannot load                     |
| `name-mismatch`       | high     | frontmatter `name` differs from the folder name                      |
| `description-missing` | high     | nothing for Claude to route on                                       |
| `dead-reference`      | high     | `SKILL.md` names a `.md` file that does not exist                    |
| `dependency-external` | high     | requires a skill that is not in this repo                            |
| `dependency-internal` | medium   | requires, slash-invokes or paths into another skill in this repo        |
| `description-short`   | medium   | under 80 characters                                                  |
| `description-long`    | medium   | over 1024 characters; the tail is cut                                |
| `no-triggers`         | medium   | description has no "when", no quoted phrase, no keyword list         |
| `duplicate`           | medium   | two descriptions are near-identical text                             |
| `duplicate`           | low      | two descriptions share much vocabulary — a pointer, judge it         |
| `oversize`            | low      | `SKILL.md` over 500 lines                                            |
| `orphan-file`         | low      | a file in the folder that `SKILL.md` never mentions                  |

Dependency detection is deliberately strict about evidence: `requires:` in
frontmatter, "requires the X skill" or "requires `X`" in prose, a backticked
`` `/x` `` invocation, a backticked `` `x` `` naming a repo skill, or a path
into another skill's folder. A bare word is not a dependency.

## 2. Judge

Read `LEDGER.md`, then decide these three things — they are what the command
cannot:

1. **Why it exists.** The ranking column is the first sentence of the
   description. If that sentence does not say what the skill is for, the
   description is the bug, not the column.
2. **Is a duplicate real?** Two testing skills for two frameworks share
   vocabulary and are not duplicates. Two skills that would trigger on the
   same sentence are. Decide: merge, sharpen both descriptions, or keep with
   one line saying why.
3. **Is a dependency justified?** The goal is none. For each one decide:
   inline the part that is needed, cut the reference, or keep it and say why
   in the issue. "Pairs well with X" without needing X is not a dependency —
   write it that way.

Judgement findings the command did not raise become issues by hand, titled
`[hygiene] <skill>: <what>` and labelled `hygiene`, so the next run treats
them like its own.

## 3. Issues

`--issues` opens one issue per medium or high finding, titled
`[hygiene] <skill>: <rule>`, labelled `hygiene`. Titles are stable, so reruns
never duplicate; a finding that disappears closes its issue with a comment.
Low findings live in the ledger only.

## Local only

Hygiene runs here, from overwatch: `/hygiene`, `mcp__overwatch__hygiene_ledger`
or `bin/overwatch hygiene <repo>`. No workflow is shipped and no other
repository is fetched. If the repo runs Prettier over markdown, add `LEDGER.md`
to its `.prettierignore`: the ledger is generated, not formatted.

## Done means

- `LEDGER.md` regenerated and committed with the change that caused it
- every medium or high finding is either fixed or has an open issue
- every duplicate and dependency in the ledger has a decision, in the issue
  or in the skill's own description
