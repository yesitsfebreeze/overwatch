/**
 * overwatch outside Claude Code's hooks engine: the same plan tools, gate and stop verdict
 * (hooks/plan.ts) and commands (hooks/commands.ts), over a state file instead of `$.state`.
 * Every host adapter goes through `callTool` and `onEvent`.
 *
 * State is per project, not per session (.overwatch/plan.json in the project root): an MCP
 * server is never told which session calls it. Ceiling: two sessions in one project share one
 * plan; key by session once every host passes a session id to its MCP servers.
 */
import type { Plan, StopBook } from "../types/index.d.ts"
import { CLEAN, EDIT_TOOLS as CLAUDE_EDIT_TOOLS, EMPTY, FRESH, PLAN_TOOLS, detail, gateReason, openLine, reminder, runAutoChecks, runPicked, stopBudgetReason, stopVerdict, withDecided } from "../hooks/plan.ts"
import { openGuards } from "../hooks/guards.ts"
import { note } from "../hooks/incidents.ts"
import { learned } from "../hooks/surface.ts"
import { fullNotice } from "../hooks/gardener.ts"
import { COMMAND_TOOLS } from "../hooks/commands.ts"
import { schemaOf, TOOL_PREFIX, type ToolSpec } from "../hooks/catalog.ts"
import { ignoreHint, join, STATE_DIR, type Io } from "../hooks/io.ts"
import { VAULT_TOOLS } from "../hooks/vault.ts"
import { CHANGELOG_TOOLS } from "../hooks/changelog.ts"
const ALL_PLAN_TOOLS = { ...PLAN_TOOLS, ...VAULT_TOOLS, ...CHANGELOG_TOOLS }

export { schemaOf }

type State = { plan: Plan; stops: StopBook; told: boolean }
const FRESH_STATE: State = { plan: EMPTY, stops: FRESH, told: false }

/** No /simplify or /code-review outside Claude Code: the contract has no review pass. */
const HOST_CONTRACT =
  "Every stop is refused until all tasks are done and every guard is upheld. Need the user's input: ask them. A guard that cannot be met: say so and why; only the user drops a guard."

/** Hosts' file write and edit tools, lower-cased: gated until the plan has tasks and guards. */
const EDIT_TOOLS = new Set([
  ...CLAUDE_EDIT_TOOLS.map((t) => t.toLowerCase()), // Claude Code (pi and opencode share write, edit)
  "apply_patch", "applypatch", "patch", // Codex, Droid, opencode, Hermes
  "write_file", "replace", "edit_file", "create", "str_replace", "str_replace_editor", "create_file", // Gemini, Copilot, Cursor, Droid, Hermes
  "mcp__git-fs__write", "mcp__git-fs__edit",
])
const isEdit = (tool: string) => EDIT_TOOLS.has(tool.toLowerCase())

/** Every overwatch tool a host can offer: the commands and the plan, by short name. */
export const TOOLS: Record<string, ToolSpec> = Object.fromEntries(
  [...Object.entries(COMMAND_TOOLS), ...Object.entries(ALL_PLAN_TOOLS)].map(([n, t]) => [n, { description: t.description, properties: t.properties, required: t.required }]),
)

/** Text written for Claude Code names tools `mcp__overwatch__x`; other hosts get the short name. */
const plain = (s: string) => s.replaceAll(TOOL_PREFIX, "")

/** The git toplevel of `dir`, else `dir`. `OVERWATCH_PROJECT` overrides it (a host that starts MCP servers elsewhere). */
async function projectRoot(io: Io, dir = io.cwd): Promise<string> {
  const pinned = process.env.OVERWATCH_PROJECT
  if (pinned) return pinned
  const r = await io.run(["git", "rev-parse", "--show-toplevel"], { cwd: dir, timeoutMs: 5000 })
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : dir
}

/** Read-modify-write of the project's state. Ceiling: no lock, so a hook and a tool call in the same millisecond can lose one write; add a lock file if that shows up. */
async function withState<T>(io: Io, root: string, f: (s: State) => Promise<[State, T]> | [State, T]): Promise<T> {
  const path = join(root, STATE_DIR, "plan.json")
  let s: State
  try { s = { ...FRESH_STATE, ...JSON.parse((await io.read(path)) ?? "") } } catch { s = FRESH_STATE }
  const [next, out] = await f(s)
  if (next !== s) await io.write(path, JSON.stringify(next, null, 1))
  return out
}

/** Runs one overwatch tool by short name. */
export async function callTool(io: Io, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; error?: boolean }> {
  const root = await projectRoot(io)
  const at: Io = { ...io, cwd: root }
  try {
    const cmd = COMMAND_TOOLS[name]
    if (cmd) return { text: await cmd.run(at, args) }
    if (name === "plan_show") return withState(io, root, (s) => [s, { text: plain(detail(s.plan, CLEAN)) }])
    if (name === "guard_check") {
      return withState(io, root, async (s) => {
        const out = await runPicked(s.plan, args.guard_id, args.tier, io.run, root, args.timeout_ms)
        if (typeof out === "string") return [s, { text: out, error: true }]
        return [{ ...s, plan: withDecided(s.plan, out.decided) }, { text: out.report }]
      })
    }
    const t = ALL_PLAN_TOOLS[name]
    if (!t?.run && !t?.act) return { text: `unknown overwatch tool: ${name}; there are ${Object.keys(TOOLS).join(", ")}`, error: true }
    return withState(io, root, async (s) => {
      const r = t.act ? await t.act(at, s.plan, args) : t.run!(s.plan, args)
      return [{ ...s, plan: r.state }, { text: plain(r.text), error: r.warn }]
    })
  } catch (err: any) {
    return { text: String(err?.message ?? err), error: true }
  }
}

/** A host event, normalized. `person` marks a prompt the user typed (it resets the stop rounds). */
export type Event =
  | { kind: "start"; cwd: string }
  | { kind: "prompt"; cwd: string; person?: boolean }
  | { kind: "pre_tool"; cwd: string; tool: string }
  | { kind: "stop"; cwd: string }

/** What the host does: add `context` to the model's input, `deny` the tool call, `block` the stop (the turn continues with the reason), or `notify` the user. */
export type Outcome = { context?: string; deny?: string; block?: string; notify?: string }

export async function onEvent(io: Io, e: Event): Promise<Outcome> {
  const root = await projectRoot(io, e.cwd || io.cwd)
  const at: Io = { ...io, cwd: root }
  switch (e.kind) {
    case "start": {
      // Once per session: the gardener's ask, earlier sessions' lessons and, until git ignores the state folder, the line asking for it.
      const [lessons, hint, disk] = await Promise.all([learned(at).catch(() => ""), ignoreHint(at), fullNotice(at).then(plain, () => "")])
      return withState(io, root, (s) => [{ ...s, told: false }, { context: [hint, disk, plain(reminder(s.plan, false, HOST_CONTRACT)), lessons].filter(Boolean).join("\n\n") }])
    }
    case "prompt":
      return withState(io, root, (s) => [
        { ...s, told: true, stops: e.person === false ? s.stops : { ...FRESH, nokeyTold: s.stops.nokeyTold } },
        { context: plain(reminder(s.plan, s.told, HOST_CONTRACT)) },
      ])
    case "pre_tool": {
      if (!isEdit(e.tool)) return {}
      const why = await withState(io, root, (s) => [s, gateReason(s.plan)])
      if (!why) return {}
      await note(at, "unplanned_edit", e.tool)
      return { deny: plain(why) }
    }
    case "stop": {
      const out = await withState(io, root, async (s): Promise<[State, Outcome]> => {
        const exhausted = stopBudgetReason(s.stops)
        if (exhausted) return [s, { notify: exhausted }]
        // Judged guards need the turn's transcript, which each host shapes differently: they fail open here (ceiling: read transcript_path where a host gives one).
        const open = s.plan.tasks.some((t) => t.status !== "done") ? [] : openGuards(s.plan.guards)
        const decided = await runAutoChecks(io.run, open, root)
        const plan = withDecided(s.plan, decided)
        const { verdict, next } = stopVerdict(plan, decided, CLEAN, s.stops, HOST_CONTRACT)
        const out: Outcome = verdict.kind === "pass" ? {} : verdict.kind === "block" ? { block: plain(verdict.reason) } : { notify: plain(verdict.reason) }
        return [{ ...s, plan, stops: next }, out]
      })
      const refused = out.block ?? out.notify
      if (refused) await note(at, out.block ? "early_stop" : "stalled", openLine(refused))
      return out
    }
  }
}
