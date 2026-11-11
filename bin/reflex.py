"""reflex — the measured half of the tool surface, ported from pi core.

The harness withholds schema from deferred tools; that policy is static. This
ledger is the feedback loop it is missing:

  tally   every tool fire in a finished turn is counted, from the transcript,
          so "rare" can no longer confirm itself. No per-call hook.
  index   what actually gets used here, plus the learned trigger lines from
          past `useful` verdicts — injected once at session start.
  rate    one cold tool is drawn per session and rated: `useful` (should have
          been reached and was not — the verdict carries the missing trigger),
          `situational` (correct to sit idle), `dead` (nothing needs it).

Unlike pi, a verdict cannot un-defer a tool here — the harness owns that. What
a `useful` verdict buys is its trigger line, shipped into every later session.

State is machine-local (usage habits span repos):
<XDG_STATE_HOME>/steward/surface.json — same home as guard.log.
"""
import json
import os
import re
import random
from datetime import date, datetime, timezone
from pathlib import Path

PROMOTE_AT = 3            # a "rare" tool that fires this often is mislabelled
VERDICT_TTL_DAYS = 30     # a verdict this old is stale: the surface moved
VERDICTS = ("useful", "situational", "dead")
TOP_N = 8


def state_path():
    root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
    return root / "steward" / "surface.json"


def load():
    try:
        raw = json.loads(state_path().read_text())
    except (OSError, json.JSONDecodeError, ValueError):
        raw = {}
    return {
        "counts": raw.get("counts", {}),
        "verdicts": raw.get("verdicts", {}),
        "triggers": raw.get("triggers", {}),
        "cursors": raw.get("cursors", {}),
        "drawn": raw.get("drawn"),
    }


def save(st):
    try:
        state_path().parent.mkdir(parents=True, exist_ok=True)
        state_path().write_text(json.dumps(st, indent=2, sort_keys=True) + "\n")
    except OSError:
        pass  # counting is best-effort; never break a session over it


def seed_names(plugin_root):
    try:
        lines = (Path(plugin_root) / "data/surface-seed.txt").read_text().splitlines()
    except OSError:
        return []
    return [l.strip() for l in lines if l.strip() and not l.startswith("#")]


SKIP_WORDS = {"cd", "export", "env", "sudo", "time", "nohup", "source", "."}


def shell_binary(tool_input):
    """The command a Bash call actually ran, counted as `sh:<binary>`.

    A routing table that says "use rg, not grep" is unfalsifiable until the
    binaries themselves are counted — the tool name is always just `Bash`.
    """
    command = tool_input.get("command")
    if not isinstance(command, str):
        return None
    for segment in re.split(r"&&|\|\||;|\||\n", command):
        for word in segment.strip().split():
            if "=" in word or word.startswith(("-", "(", "{", "#")):
                continue
            if word in SKIP_WORDS:  # `cd /tmp && rg foo` is an rg call
                break
            return "sh:" + Path(word).name
    return None


def tally(payload):
    """Fold a finished turn's tool fires into the ledger, from its transcript.

    A cursor per session means each transcript line is counted once, however
    many times Stop fires.
    """
    path = payload.get("transcript_path")
    session = payload.get("session_id") or "unknown"
    if not path or not Path(path).exists():
        return "reflex: no transcript"
    st = load()
    start = st["cursors"].get(session, 0)
    seen = 0
    fired = {}
    with open(path) as fh:
        for i, line in enumerate(fh):
            seen = i + 1
            if i < start:
                continue
            try:
                entry = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            content = entry.get("message", {}).get("content")
            if not isinstance(content, list):
                continue
            for block in content:
                if not (isinstance(block, dict) and block.get("type") == "tool_use"):
                    continue
                name = block.get("name")
                if not name:
                    continue
                fired[name] = fired.get(name, 0) + 1
                binary = shell_binary(block.get("input") or {})
                if binary:
                    fired[binary] = fired.get(binary, 0) + 1
    for name, n in fired.items():
        st["counts"][name] = st["counts"].get(name, 0) + n
    st["cursors"][session] = seen
    if len(st["cursors"]) > 20:  # ponytail: keep the last 20 sessions, drop the rest
        for old in list(st["cursors"])[:-20]:
            del st["cursors"][old]
    save(st)
    return f"reflex: counted {sum(fired.values())} fire(s) across {len(fired)} tool(s)"


def _fresh(verdict):
    try:
        at = datetime.fromisoformat(verdict["at"]).date()
    except (KeyError, ValueError):
        return False
    return (date.today() - at).days < VERDICT_TTL_DAYS


def draw(st, names):
    """The cold half of the table, one per session. An unreached tool is an
    unobserved tool — its row sits at "no signal yet" unless something points
    at it, and a new name has no count so it sorts coldest by construction."""
    eligible = [n for n in names if not (n in st["verdicts"] and _fresh(st["verdicts"][n]))]
    if not eligible:
        return None
    scored = sorted(eligible, key=lambda n: st["counts"].get(n, 0))
    cold = scored[: max(1, len(scored) // 2)]
    pick = random.choice(cold)
    return {"name": pick, "uses": st["counts"].get(pick, 0)}


def index(plugin_root, redraw=True):
    """The block injected at session start: evidence, triggers, one question."""
    st = load()
    names = sorted(set(seed_names(plugin_root)) | set(st["counts"]))
    if redraw:
        st["drawn"] = draw(st, names)
        save(st)
    out = []

    triggers = [t for t in st["triggers"].values() if t]
    if triggers:
        out += ["## Learned triggers — situations that earned a tool", *[f"- {t}" for t in sorted(triggers)]]

    counts = st["counts"]
    hot = sorted(((n, c) for n, c in counts.items() if not n.startswith("sh:")),
                 key=lambda kv: -kv[1])[:TOP_N]
    if hot:
        out.append("## Used most on this machine: " + " · ".join(f"{n} {c}" for n, c in hot))
    shells = sorted(((n[3:], c) for n, c in counts.items() if n.startswith("sh:")),
                    key=lambda kv: -kv[1])[:TOP_N]
    if shells:
        out.append("## Shell binaries reached for: " + " · ".join(f"{n} {c}" for n, c in shells))

    # Only where kern is present (it fired at least once): shell searching that dwarfs it is the habit to break.
    kern = sum(c for n, c in counts.items() if "kern" in n)
    shell_search = sum(counts.get(f"sh:{b}", 0) for b in ("grep", "rg", "cat", "sed", "find", "head"))
    if kern and shell_search >= 10 and shell_search > 3 * kern:
        out.append(f"## Search through kern first: shell search {shell_search} vs kern {kern}. "
                   "Project state goes to kern_fs grep / kern_memory search; a built-in only for what "
                   "kern cannot reach, and say why.")

    used_rare = [f"{n} ({st['counts'][n]})" for n in seed_names(plugin_root)
                 if st["counts"].get(n, 0) >= PROMOTE_AT]
    if used_rare:
        out.append("## Deferred but earning its place — load it early, do not rediscover it: "
                   + ", ".join(used_rare))

    due = st.get("drawn")
    if due:
        out += [
            f"## Evaluation due: `{due['name']}` — {due['uses']} recorded uses",
            "Judge it against the work actually done in this session, before the session ends:",
            f"`steward rate {due['name']} useful|situational|dead \"<one line why>\" "
            "[--trigger \"<situation that should have fired it>\"]`. "
            "`useful` means it should have been reached and was not — then --trigger is required. "
            "No basis to judge it here → say that as the reason.",
        ]

    if not out:
        return ""
    return "\n".join(["# Tool surface (steward)", *out])


def rate(name, verdict, reason, trigger=None):
    if verdict not in VERDICTS:
        return f"reflex: verdict must be one of {' | '.join(VERDICTS)}"
    if verdict == "useful" and not (trigger or "").strip():
        return ("reflex: a `useful` verdict needs --trigger — the situation line that should have "
                "fired it, e.g. 'unfamiliar repo, need the big picture: graft map'")
    st = load()
    st["verdicts"][name] = {"verdict": verdict, "reason": reason,
                            "at": datetime.now(timezone.utc).date().isoformat()}
    if verdict == "useful":
        st["triggers"][name] = trigger.strip()
    if verdict == "dead":
        st["triggers"].pop(name, None)
    if (st.get("drawn") or {}).get("name") == name:
        st["drawn"] = None
    save(st)
    tail = {"useful": "trigger recorded — it ships in the surface block from the next session",
            "dead": "candidate for removal from the seed list",
            "situational": "correct to sit idle"}[verdict]
    return f"reflex: {name} rated {verdict} — {tail}"


def report(plugin_root):
    st = load()
    lines = []
    counts = sorted(st["counts"].items(), key=lambda kv: -kv[1])
    counts = [kv for kv in counts if not kv[0].startswith("sh:")] + \
             [kv for kv in counts if kv[0].startswith("sh:")]
    lines.append(f"tools fired: {len(counts)}, total fires: {sum(st['counts'].values())}")
    lines += [f"  {n}: {c}" for n, c in counts[:15]]
    never = [n for n in seed_names(plugin_root) if n not in st["counts"]]
    if never:
        lines.append("never fired: " + ", ".join(never))
    if st["verdicts"]:
        lines.append("verdicts:")
        lines += [f"  {n}: {v['verdict']} ({v['at']}) {v['reason']}"
                  for n, v in sorted(st["verdicts"].items(), key=lambda kv: kv[1]["at"], reverse=True)[:8]]
    if st["triggers"]:
        lines.append("triggers:")
        lines += [f"  {t}" for t in st["triggers"].values()]
    return "\n".join(lines)
