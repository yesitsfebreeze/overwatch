#!/usr/bin/env python3
"""Print which plugins are active per layer: global | each account | project | local.
Global = managed-settings.json (rendered from WANT in ~/.claude/setup-plugins.sh). Accounts = ~/.claude/<name>/settings.json
(root = default). Project/local = ./.claude/settings*.json. '*' marks the current account.
Cells: x enabled here, / inherited from global, * global and also enabled here, . off."""
import json, os
from pathlib import Path

ROOT = Path.home() / ".claude"
CUR = Path(os.environ.get("CLAUDE_CONFIG_DIR", ROOT)).resolve()

def enabled(p):
    try:
        return {k for k, v in json.load(open(p)).get("enabledPlugins", {}).items() if v}
    except (OSError, ValueError):
        return set()

INSTALLED = Path("/Library/Application Support/ClaudeCode/managed-settings.json")  # what Claude Code applies
cols = [("global", enabled(ROOT / "managed-settings.json"))]  # rendered from WANT by setup-plugins.sh
accounts = [ROOT] + sorted(d for d in ROOT.iterdir() if d.is_dir() and (d / "settings.json").exists())
for d in accounts:
    name = "default" if d == ROOT else d.name
    cols.append((name + ("*" if d.resolve() == CUR else ""), enabled(d / "settings.json")))
cols.append(("project", enabled(Path(".claude/settings.json"))))
cols.append(("local", enabled(Path(".claude/settings.local.json"))))

allp = set().union(*(s for _, s in cols))
def cell(p, s, is_global):
    if is_global: return "x" if p in s else "."
    if p in glob: return "*" if p in s else "/"  # inherited from global; * = also explicit
    return "x" if p in s else "."
glob = cols[0][1]
sig = lambda p: "".join(cell(p, s, i == 0) for i, (_, s) in enumerate(cols))
rows = sorted(allp, key=lambda p: (sig(p).count("."), sig(p), p))  # widest first
w = max((len(p) for p in allp), default=6)
print(f"{'plugin':{w}}  " + " ".join(f"{n:>8}" for n, _ in cols))
for p in rows:
    print(f"{p:{w}}  " + " ".join(f"{c:>8}" for c in sig(p)))
want, glob = glob, enabled(INSTALLED)
if want != glob:
    print(f"global not installed: {len(want - glob)} to add, {len(glob - want)} to drop. Run the sudo line from: sh ~/.claude/setup-plugins.sh")
