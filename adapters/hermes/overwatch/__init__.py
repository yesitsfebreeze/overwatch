"""overwatch for Hermes Agent.

Hooks shell out to `overwatch hook claude <Event>` (the Claude Code hook shape): the same
core every host runs. The plan tools come from the overwatch MCP server
(`mcp_servers.overwatch` in ~/.hermes/config.yaml). Fails open: a missing binary or a bad
answer never blocks Hermes.

Limit: Hermes has no general stop hook; `pre_verify` fires only on turns that edited code,
so an open plan holds the end of those turns only.
"""
import json
import os
import shutil
import subprocess

_BIN = os.environ.get("OVERWATCH_BIN") or shutil.which("overwatch") or os.path.expanduser("~/.local/bin/overwatch")


def _hook(event, payload):
    try:
        r = subprocess.run([_BIN, "hook", "claude", event], input=json.dumps(payload), capture_output=True, text=True, timeout=90)
        return json.loads(r.stdout) if r.stdout.strip() else {}
    except Exception:
        return {}


def _cwd(kwargs):
    return kwargs.get("cwd") or os.getcwd()


def pre_llm_call(**kwargs):
    out = _hook("UserPromptSubmit", {"cwd": _cwd(kwargs)})
    ctx = out.get("hookSpecificOutput", {}).get("additionalContext")
    return {"context": ctx} if ctx else None


def pre_tool_call(tool_name="", args=None, **kwargs):
    out = _hook("PreToolUse", {"cwd": _cwd(kwargs), "tool_name": tool_name, "tool_input": args or {}})
    spec = out.get("hookSpecificOutput", {})
    if spec.get("permissionDecision") == "deny":
        return {"action": "block", "message": spec.get("permissionDecisionReason", "overwatch: plan first")}
    return None


def pre_verify(**kwargs):
    out = _hook("Stop", {"cwd": _cwd(kwargs)})
    if out.get("decision") == "block":
        return {"action": "continue", "message": out.get("reason", "")}
    return None


def register(ctx):
    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("pre_tool_call", pre_tool_call)
    ctx.register_hook("pre_verify", pre_verify)
