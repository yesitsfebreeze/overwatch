#!/usr/bin/env python3
"""hygiene.py - rate, review and cross-check every skill under skills/.

    python3 skills/hygiene/hygiene.py [repo]           # write <repo>/LEDGER.md; repo defaults to cwd, then this repo
    python3 skills/hygiene/hygiene.py [repo] --issues  # also sync GitHub issues of <repo> (needs gh)
    python3 skills/hygiene/hygiene.py --selftest

Stdlib only. Usage counts come from local Claude Code transcripts when present
(~/.claude/projects, override with HYGIENE_TRANSCRIPTS); on CI they are absent.
"""
import datetime
import difflib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

_arg = next((a for a in sys.argv[1:] if not a.startswith("--")), None)
ROOT = Path(_arg).resolve() if _arg else (Path.cwd() if (Path.cwd() / "skills").is_dir() else Path(__file__).resolve().parents[2])
SKILLS = ROOT / "skills"
WEIGHT = {"high": 25, "medium": 10, "low": 5}
DUP_JACCARD = 0.35        # shared trigger vocabulary
DUP_RATIO = 0.60          # difflib ratio over the two descriptions
MAX_LINES = 500           # Anthropic's own ceiling for a SKILL.md
STOP = set("a an the and or of to in on for is it its this that with when use used using "
           "skill skills before after every any all one which what how who into from by as at "
           "be are was not no if then than so do does load read say says".split())


def fm(text):
    """Frontmatter as a dict; lists ([a, b] or - a) flattened. No YAML dependency."""
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.S)
    if not m:
        return {}, text
    meta, key, block = {}, None, None
    for line in m.group(1).splitlines():
        kv = re.match(r"^([\w-]+):\s*(.*)$", line)
        if kv:
            key, val = kv.group(1), kv.group(2).strip()
            block = val if val in (">", "|", ">-", "|-") else None
            if block:
                val = ""
            elif val.startswith("[") and val.endswith("]"):
                val = [v.strip().strip("'\"") for v in val[1:-1].split(",") if v.strip()]
            meta[key] = val
        elif key and block and line.startswith(" "):
            meta[key] = (meta[key] + (" " if block[0] == ">" else "\n") + line.strip()).strip()
        elif key and line.strip().startswith("- "):
            meta[key] = (meta[key] if isinstance(meta[key], list) else []) + [line.strip()[2:].strip("'\"")]
    return meta, m.group(2)


def vocab(desc):
    return {w for w in re.findall(r"[a-z][a-z0-9-]{2,}", desc.lower()) if w not in STOP}


def usage_counts():
    base = Path(os.environ.get("HYGIENE_TRANSCRIPTS", Path.home() / ".claude" / "projects"))
    counts, pat = {}, re.compile(r'"name":"Skill","input":\{"skill":"([^"]+)"')
    for f in base.rglob("*.jsonl") if base.is_dir() else []:
        try:
            for hit in pat.findall(f.read_text(errors="ignore")):
                counts[hit.split(":")[-1]] = counts.get(hit.split(":")[-1], 0) + 1
        except OSError:
            pass
    return counts


def scan(skills_dir=SKILLS):
    names = sorted(p.name for p in skills_dir.iterdir() if p.is_dir() and not p.name.startswith("."))
    skills, findings = {}, []

    def flag(skill, rule, sev, detail):
        findings.append({"skill": skill, "rule": rule, "severity": sev, "detail": detail})

    for name in names:
        d = skills_dir / name
        files = [p for p in d.rglob("*") if p.is_file() and not p.name.startswith(".")]
        s = {"name": name, "files": len(files), "words": sum(len(p.read_text(errors="ignore").split()) for p in files),
             "description": "", "requires": [], "internal": [], "external": [], "lines": 0}
        skills[name] = s
        md = d / "SKILL.md"
        if not md.exists():
            flag(name, "missing-skill-md", "high", "directory has no SKILL.md; the skill cannot load")
            continue
        text = md.read_text(errors="ignore")
        meta, body = fm(text)
        s["lines"] = text.count("\n") + 1
        s["description"] = str(meta.get("description", "")).strip()
        req = meta.get("requires", [])
        s["requires"] = req if isinstance(req, list) else [req]

        if meta.get("name") != name:
            flag(name, "name-mismatch", "high", f"frontmatter name is {meta.get('name')!r}, directory is {name!r}")
        desc = s["description"]
        if not desc:
            flag(name, "description-missing", "high", "no description; Claude has nothing to route on")
        elif len(desc) < 80:
            flag(name, "description-short", "medium", f"{len(desc)} chars; say what it does and when to reach for it")
        elif len(desc) > 1024:
            flag(name, "description-long", "medium", f"{len(desc)} chars; over the 1024 limit, the tail is cut")
        if desc and not re.search(r'"[^"]+"|\b(when(ever)?|wenn|use (this skill )?for|nutze|triggers?|keywords?)\b', desc, re.I):
            flag(name, "no-triggers", "medium", "description names no trigger phrases; routing is guesswork")
        if s["lines"] > MAX_LINES:
            flag(name, "oversize", "low", f"SKILL.md is {s['lines']} lines; split rarely-read parts into companions")

        # dependencies: requires:, prose "requires the X skill", another repo skill named in the body,
        # and path references into a directory that is not this skill
        deps = set(s["requires"])
        deps |= {a or b for a, b in re.findall(r"[Rr]equires (?:the )?(?:`([a-z][a-z0-9-]+)`|([a-z][a-z0-9-]+) skill)", body)}
        deps |= set(re.findall(r"`/([a-z][a-z0-9-]+)`", body))
        deps |= {m for m in re.findall(r"(?:skills/)?\b([a-z][a-z0-9-]+)/[\w./-]+\.md", body) if m in names}
        for other in names:  # a bare word is not a dependency; `other` is
            if other != name and f"`{other}`" in body:
                deps.add(other)
        deps.discard(name)
        for dep in sorted(deps):
            kind = "internal" if dep in names else "external"
            s[kind].append(dep)
            flag(name, f"dependency-{kind}", "medium" if kind == "internal" else "high",
                 f"depends on {dep!r} ({kind}); an interchangeable skill carries its own weight")

        # references to companion files that do not exist
        for ref in set(re.findall(r"`@?([\w./-]+\.md)`|@([\w./-]+\.md)", body)):
            ref = (ref[0] or ref[1]).removeprefix("skills/")
            if ref == "LEDGER.md":
                continue  # the file this script writes; absent until the first run
            if "/" in ref and ref.split("/")[0] in deps:
                continue  # path into another skill, already a dependency finding
            if not (d / ref).exists() and not (skills_dir.parent / ref).exists():
                flag(name, "dead-reference", "high", f"SKILL.md points at {ref!r} which does not exist")
        for p in files:
            rel = p.relative_to(d).as_posix()
            if rel != "SKILL.md" and rel not in text and p.name not in text:
                flag(name, "orphan-file", "low", f"{rel!r} is never referenced from SKILL.md")

    # duplicates: pairwise on description vocabulary and on the text itself
    have = [n for n in names if skills[n]["description"]]
    for i, a in enumerate(have):
        for b in have[i + 1:]:
            va, vb = vocab(skills[a]["description"]), vocab(skills[b]["description"])
            jac = len(va & vb) / len(va | vb) if va | vb else 0
            ratio = difflib.SequenceMatcher(None, skills[a]["description"], skills[b]["description"]).ratio()
            if jac >= DUP_JACCARD or ratio >= DUP_RATIO:  # near-identical text is an issue; shared vocabulary is a pointer for review
                flag(a, "duplicate", "medium" if ratio >= DUP_RATIO else "low",
                     f"overlaps with {b!r} (vocabulary {jac:.2f}, text {ratio:.2f}); merge or sharpen both descriptions")

    for s in skills.values():
        s["score"] = max(0, 100 - sum(WEIGHT[f["severity"]] for f in findings if f["skill"] == s["name"]))
    return skills, findings


def why(desc):
    first = re.split(r"(?<=[.!?])\s", desc.strip(), maxsplit=1)[0] if desc else "-"
    return (first[:110] + "...") if len(first) > 113 else first


def ledger(skills, findings, usage):
    order = sorted(skills.values(), key=lambda s: (-s["score"], -usage.get(s["name"], 0), s["name"]))
    out = [f"# Skill ledger", "",
           f"Generated {datetime.date.today()} by the hygiene skill. "
           f"{len(skills)} skills, {len(findings)} findings. Score starts at 100; "
           f"high finding -{WEIGHT['high']}, medium -{WEIGHT['medium']}, low -{WEIGHT['low']}. "
           "`used` is Skill-tool invocations found in local transcripts (blank on CI).", "",
           "## Ranking", "", "| # | skill | score | used | why it exists | files | words | depends on |", "|---|---|---|---|---|---|---|---|"]
    for i, s in enumerate(order, 1):
        deps = ", ".join(s["internal"] + [f"{d} (ext)" for d in s["external"]]) or "-"
        used = usage.get(s["name"], 0) if usage else ""
        out.append(f"| {i} | {s['name']} | {s['score']} | {used} | {why(s['description'])} | {s['files']} | {s['words']} | {deps} |")
    dups = [f for f in findings if f["rule"] == "duplicate"]
    out += ["", "## Duplicates", ""]
    out += ["| skill | overlaps with |", "|---|---|"] + [f"| {f['skill']} | {f['detail']} |" for f in dups] if dups else ["none"]
    deps = [f for f in findings if f["rule"].startswith("dependency-")]
    out += ["", "## Dependencies", ""]
    out += ["| skill | kind | detail |", "|---|---|---|"] + [f"| {f['skill']} | {f['rule'][11:]} | {f['detail']} |" for f in deps] if deps else ["none - every skill stands alone"]
    out += ["", "## Findings", ""]
    if findings:
        out += ["| skill | rule | severity | detail |", "|---|---|---|---|"]
        out += [f"| {f['skill']} | {f['rule']} | {f['severity']} | {f['detail']} |"
                for f in sorted(findings, key=lambda f: (list(WEIGHT).index(f["severity"]), f["skill"]))]
    else:
        out.append("none")
    return "\n".join(out) + "\n"


def title(f):
    return f"[hygiene] {f['skill']}: {f['rule']}" + (f" ({f['detail'].split(chr(39))[1]})" if f["rule"] in ("duplicate", "dead-reference", "orphan-file") or f["rule"].startswith("dependency") else "")


def gh(*args):
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True, cwd=ROOT).stdout


def sync_issues(findings):
    """One open issue per medium/high finding, titled stably so reruns do not duplicate; close what healed."""
    subprocess.run(["gh", "label", "create", "hygiene", "--force", "-c", "C5DEF5", "-d", "opened by the hygiene skill"], capture_output=True, cwd=ROOT)
    open_issues = {i["title"]: i["number"] for i in json.loads(gh("issue", "list", "--label", "hygiene", "--state", "open", "--limit", "500", "--json", "number,title"))}
    wanted = {title(f): f for f in findings if f["severity"] != "low"}
    for t, f in wanted.items():
        if t not in open_issues:
            body = (f"**Skill:** `{f['skill']}`\n**Rule:** `{f['rule']}` ({f['severity']})\n\n{f['detail']}\n\n"
                    f"Opened by the hygiene skill; see `LEDGER.md`. It closes on its own once the finding is gone.")
            gh("issue", "create", "--title", t, "--label", "hygiene", "--body", body)
            print("opened ", t)
    for t, n in open_issues.items():
        if t not in wanted:
            gh("issue", "close", str(n), "-c", "No longer reported by the hygiene run.")
            print("closed ", t)


def selftest():
    with tempfile.TemporaryDirectory() as tmp:
        sk = Path(tmp) / "skills"
        (sk / "alpha").mkdir(parents=True)
        (sk / "beta").mkdir()
        (sk / "empty").mkdir()
        (sk / "alpha" / "SKILL.md").write_text('---\nname: alpha\ndescription: >\n  Review Vue components for style and conventions.\n  Use for "vue review", "check my component".\nrequires: [beta]\n---\nRequires the omega skill. See `missing.md`, `LEDGER.md`, `/gamma` and `skills/beta/SKILL.md`. Path docs/x.md is not a skill.\n')
        (sk / "alpha" / "extra.md").write_text("orphan")
        (sk / "beta" / "SKILL.md").write_text('---\nname: wrong\ndescription: Review Vue components for conventions, naming and style. Use for "vue review", "lint my vue".\n---\nbody\n')
        skills, findings = scan(sk)
        rules = {(f["skill"], f["rule"]) for f in findings}
        for want in [("empty", "missing-skill-md"), ("beta", "name-mismatch"), ("alpha", "dependency-internal"),
                     ("alpha", "dependency-external"), ("alpha", "dead-reference"), ("alpha", "orphan-file"), ("alpha", "duplicate")]:
            assert want in rules, (want, rules)
        assert not any("LEDGER.md" in f["detail"] for f in findings), findings
        assert skills["alpha"]["internal"] == ["beta"] and skills["alpha"]["external"] == ["gamma", "omega"], skills["alpha"]
        assert skills["alpha"]["description"].startswith("Review Vue") and "\n" not in skills["alpha"]["description"]
        assert skills["empty"]["score"] == 75 and skills["beta"]["score"] == 75 and skills["alpha"]["score"] == 0, {n: s["score"] for n, s in skills.items()}
        assert "| alpha |" in ledger(skills, findings, {})
    print("selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit()
    if not SKILLS.is_dir():
        sys.exit(f"no skills/ directory under {ROOT}")
    skills, findings = scan()
    usage = usage_counts()
    (ROOT / "LEDGER.md").write_text(ledger(skills, findings, usage))
    print(f"{len(skills)} skills, {len(findings)} findings -> LEDGER.md")
    if "--issues" in sys.argv:
        sync_issues(findings)
