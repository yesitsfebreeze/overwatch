# Hosts

Claude Code runs `hooks/overwatch.ts` with `hooks/plan-hooks.ts`; every other host uses `host/core.ts`. Per-host config lives in `adapters/`. The canonical, step-by-step source is [install.txt](../install.txt); this page is the readable map.

## What every host gets

Every host gets the plan tools. Hosts that run hooks also get the plan reminder, the edit gate and the stop hold; an MCP-only host gets only the tools.

## Outside Claude Code

- No compaction, followline, tool-surface block or review pass; judged guards do not hold the stop. Plan state is per project (`.overwatch/plan.json`), not per session.

## Matrix

| agent | how | tools | reminder | edit gate | stop hold |
|---|---|---|---|---|---|
| Claude Code | native plugin | native | every prompt | `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, git-fs `write`/`edit` | Stop |
| Codex CLI | `.codex-plugin`, `adapters/codex` | MCP | every prompt | `apply_patch`, Edit, Write | Stop |
| pi | `package.json` "pi", `adapters/pi` | native | every run | edit, write | agent_before_settle |
| opencode 2.x | `adapters/opencode` | native | every request | permission `edit` | re-prompt on session.idle |
| Hermes Agent | `adapters/hermes` + MCP | MCP | every LLM call | write_file, patch | pre_verify (edit turns only) |
| Gemini CLI | `adapters/gemini` extension | MCP | every prompt | write_file, replace | AfterAgent |
| Copilot CLI | `.github/plugin`, `adapters/copilot` | MCP | session start only | edit, create | agentStop |
| Cursor | `.cursor-plugin`, `adapters/cursor` | MCP | session start only | Write | stop followup |
| Factory Droid | `adapters/droid` hooks + MCP | MCP | every prompt | Create, Edit, ApplyPatch | Stop |

## Requirements

- `git` and `bun` on `PATH`.
- A stable checkout, `$OW`, and `$OW/bin/overwatch` linked into `~/.local/bin` (every hook and MCP config calls `overwatch`).

```sh
OW="$HOME/dev/overwatch"        # or an existing checkout: the clone is skipped
test -d "$OW/.git" || git clone https://github.com/yesitsfebreeze/overwatch "$OW"
mkdir -p "$HOME/.local/bin"
ln -sf "$OW/bin/overwatch" "$HOME/.local/bin/overwatch"
overwatch help
echo '{}' | overwatch hook codex Stop; echo "exit $?"     # expect exit 0
cd "$OW" && bun test ./host/host.check.ts                 # expect 0 fail
```

## Claude Code

Native plugin: every part and tool.

```sh
claude plugin marketplace add "$OW"
claude plugin install overwatch@overwatch --scope user
```

Needs `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the environment Claude Code starts with. Live edits: `claude --plugin-dir "$OW"`.

VERIFY: `cd "$OW" && claude plugin validate . && claude plugin test .`

## OpenAI Codex CLI

```sh
codex plugin marketplace add "$OW"
codex plugin add overwatch@overwatch
```

The user must open `/hooks` in Codex and trust the four overwatch hooks (SessionStart, UserPromptSubmit, PreToolUse, Stop); you cannot approve them. Versions that still gate hooks need `[features] hooks = true` in `~/.codex/config.toml`; add it only if absent.

VERIFY: new session, ask "call overwatch plan_show"; it answers "No tasks, no guards."

## pi (earendil-works pi-coding-agent)

```sh
pi install "$OW"
```

Try without installing: `pi -e "$OW/adapters/pi/overwatch.ts"`

VERIFY: in a scratch git repo,

```sh
pi --no-session -p "Create hello.txt containing hi with the write tool."
```

The first write is refused until the plan exists; the run ends with the task done and `hello.txt` present.

## opencode (2.x, @opencode/plugin)

```sh
cd "$OW/adapters/opencode" && bun install
```

Add the directory to the `plugins` array (plural; local entries must be directories) in `~/.config/opencode/opencode.jsonc` (user) or `.opencode/opencode.json` (one project), keeping existing entries:

```json
"plugins": [ ..., "<absolute path of $OW>/adapters/opencode" ]
```

VERIFY: `opencode run "call overwatch_plan_show"` → "No tasks, no guards."

## Hermes Agent (NousResearch)

```sh
mkdir -p ~/.hermes/plugins
ln -sfn "$OW/adapters/hermes/overwatch" ~/.hermes/plugins/overwatch
hermes plugins enable overwatch
```

Merge into `~/.hermes/config.yaml` (keep existing servers):

```yaml
mcp_servers:
  overwatch:
    command: overwatch
    args: ["mcp"]
```

Limit: no general stop hook; `pre_verify` fires only on turns that edited code, so the stop hold covers those turns only.

VERIFY: `hermes plugins list` shows overwatch enabled; a new session can call `plan_show`.

## Google Gemini CLI

```sh
gemini extensions link "$OW/adapters/gemini"
```

Gemini asks for consent to the extension's hooks: the user confirms it.

VERIFY: `gemini extensions list` shows overwatch; `/mcp` lists the overwatch tools.

## GitHub Copilot CLI

```sh
copilot plugin install "$OW"
```

Limit: Copilot drops hook output on prompt submit, so the plan reminder rides `sessionStart` only. The repository folder must be trusted.

VERIFY: `copilot plugin list` shows overwatch; a session can call `plan_show`.

## Cursor (IDE and cursor-agent)

```sh
mkdir -p ~/.cursor/plugins/local
ln -sfn "$OW" ~/.cursor/plugins/local/overwatch
```

Then the user runs "Developer: Reload Window".

Limits: the reminder rides `sessionStart`; only Cursor's `Write` tool is gated; the stop hold is a `followup_message` (loop_limit 8). `cursor-agent` fires only part of the hooks.

VERIFY: Cursor Settings → Hooks and MCP list overwatch.

## Factory Droid

Droid reads `hooks/hooks.json`, which here is Claude Code's module, so install by config:

```sh
droid mcp add overwatch overwatch mcp
```

Merge every event of `$OW/adapters/droid/hooks.json` into `~/.factory/hooks.json` (append to existing event arrays; create the file if absent).

VERIFY: a new droid session can call `plan_show`; an Edit before `task_add` is refused.

## Anything else

MCP client: register a stdio server named `overwatch`, command `overwatch`, args `["mcp"]`, started in the project directory (or with `OVERWATCH_PROJECT` set to the project path). That gives the tools.

Command hooks in Claude Code's format (stdin JSON with `cwd` and `tool_name`; `hookSpecificOutput.additionalContext`; `permissionDecision: deny`; `decision: block` on stop): point them at `overwatch hook claude <Event>` for SessionStart, UserPromptSubmit, PreToolUse (file write/edit tools) and Stop.

Neither: MCP server only, and tell the user the edit gate and stop hold are not active on this host.

## Updating

```sh
OW="$(cd "$(dirname "$(readlink "$(command -v overwatch)")")/.." && pwd)"
git -C "$OW" fetch --quiet origin
git -C "$OW" log --oneline HEAD..@{u}
```

No output: current. Otherwise fast-forward only; local changes or a refused pull: stop and report, never stash, reset or force.

```sh
git -C "$OW" pull --ff-only
cd "$OW" && bun test ./host/host.check.ts
```

Hosts that run the checkout itself are done (the `overwatch` binary, pi, Hermes, Gemini, Cursor, Droid, Claude Code with `--plugin-dir`). Hosts that run a copy:

```sh
claude plugin marketplace update overwatch
claude plugin update overwatch@overwatch
```

Codex CLI, Copilot CLI and opencode: rerun the host's install step and VERIFY line above, then restart the agent.

A project's state is its `.overwatch/` folder. To start fresh, delete everything in it except `.overwatch/vault/`: the spec vault is git-tracked durable work.

## Optional tool groups

New sessions expose core planning, guard checks, feedback, mistake history and `tool_groups` by default. Native Claude Code also keeps `decompress` and `search_context` while compaction is enabled. Call `tool_groups` once for the installed groups and exact setup help; the catalog stays fixed until the host restarts.

For native Claude Code, set overwatch user configuration `toolGroups` to a comma-separated string such as `vault,background`. For MCP, Pi, OpenCode and other portable hosts, set `OVERWATCH_TOOL_GROUPS=vault,background` in the server or host process environment. Set `all` to restore the complete catalog. Restart the host after changing either setting. Unknown values produce an explicit configuration error and retain core enforcement with optional groups disabled.

| Group | Capabilities |
|---|---|
| `vault` | Unit notes, claims, dependencies and evidence |
| `prd` | PRD planning and collection; includes `vault` |
| `maintenance` | Loadout, hygiene and disk tools; enables disk notices |
| `background` | Launch and inspect background commands |
| `changelog` | Changelog updates |

MCP does not advertise dynamic list changes. Direct terminal subcommands remain explicit operations; `overwatch tool-groups` shows the configured tool catalog.
