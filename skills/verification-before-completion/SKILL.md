---
name: verification-before-completion
description: Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims; evidence before assertions always
metadata:
  openrig:
    vendored_from: "Obra Superpowers (https://github.com/obra/superpowers)"
    vendoring_pattern: modify-the-file
    last_upstream_check: "2026-05-13 (diff against plugin source pulled 2026-05-11 = identical)"
---

# Verification Before Completion

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you have not run the verification command in this message, you cannot claim it passes. Claiming a result without checking it is dishonesty, not efficiency.

The rule serves shipping; it does not outrank it. It governs every claim or implication, in any wording, that a verifiable result holds ("tests pass", "build succeeds", "bug fixed"): before committing, opening a PR, completing a task, moving to the next one or delegating. Scale the check to the stakes: a one-line copy tweak needs no test-suite ceremony. Do not keep re-proving instead of shipping.

## The gate

1. IDENTIFY the command that proves the claim.
2. RUN it in full, fresh.
3. READ the full output, exit code, failure count.
4. VERIFY: does the output confirm the claim? No: state the actual status with evidence. Yes: state the claim with evidence.

## What each claim requires

| Claim | Requires | Not sufficient |
|---|---|---|
| Tests pass | test output: 0 failures | a previous run, "should pass" |
| Linter clean | linter output: 0 errors | partial check |
| Build succeeds | build command: exit 0 | linter passing |
| Bug fixed | the original symptom tested | code changed |
| Regression test works | red-green: passes, fails with the fix reverted, passes restored | passes once |
| Agent completed | VCS diff verified | the agent's "success" |
| Requirements met | the plan re-read line by line, gaps reported | tests passing |

## Red flags: stop

- "should", "probably", "seems to", "I'm confident": confidence is not evidence.
- A specific result stated as proven before the check ran in this message.
- About to commit, push or open a PR without verification.
- Trusting an agent's success report, or a partial check.
- "Just this once", or tired and wanting the work over.

## When the check itself lies

A check can exit clean and prove nothing.

- **Assert on content, never shape or count.** If failure and success look the same at a glance, the check proves nothing (`[1 lines]` and `No matches found` both read as "a match" to a line count).
- **Compare the returned value to the value you passed**, never to a description of it.
- **Find the untested axis.** What do all your tests share (a healthy manifest, a default option, the happy path)? That is the dimension you never tested.
- **A syntax check proves parseability only.** A clean `node --check`, lint or parse says nothing about boot and runtime.
- **A hang reports nothing.** Race a bare `await` against a timer so failure has a shape.
- **Never take inventory through a truncating display.** Count with `grep -c` / `grep -o`, never `cut`, `head` or a pager. Then re-audit with a different method. Empty or short output is a claim about your command until proven a second way.
