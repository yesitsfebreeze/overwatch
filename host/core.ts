/**
 * overwatch outside Claude Code's hooks engine: the same plan tools, gate and stop
 * verdict (hooks/plan.ts) and the same commands (hooks/tools.ts), over a state file
 * instead of `$.state`. Every host adapter (MCP server, command hooks, pi, opencode,
 * Hermes) goes through `callTool` and `onEvent`.
 *
 * State is per project, not per session: an MCP server is never told which session
 * calls it, so the plan file is keyed by the project root (the git toplevel, else the
 * directory). Ceiling: two sessions in one project share one plan; key by session once
 * every host passes a session id to its MCP servers.
 */
import type { Guard, Plan, StopBook } from "../types/index.d.ts"
import { CHECK_TIMEOUT_MS, CLEAN, EMPTY, FRESH, PLAN_TOOLS, detail, gateReason, ran, reminder, stopVerdict, tail } from "../hooks/plan.ts"
import { openGuards } from "../hooks/guards.ts"
import { COMMAND_TOOLS } from "../hooks/tools.ts"
import { hash, TOOL_PREFIX, type ToolSpec } from "../hooks/version.ts"
import { join, type Io } from "../hooks/io.ts"

export type State = { plan: Plan; stops: StopBook; told: boolean }
const FRESH_STATE: State = { plan: EMPTY, stops: FRESH, told: false }

/** No /simplify or /code-review outside Claude Code, so the review pass is not part of the contract here. */
export const HOST_CONTRACT =
  "Every stop is refused until all tasks are done and every guard is upheld. Need the user's input: ask them. A guard that cannot be met: say so and why; only the user drops a guard."

/** Tool names hosts use for file writes and edits, lower-cased: gated until the plan has tasks and guards. */
export const EDIT_TOOLS = new Set([
  "write", "edit", "multiedit", "notebookedit", // Claude Code, pi, opencode
  "apply_patch", "applypatch", "patch", // Codex, Droid, opencode, Hermes
  "write_file", "replace", "edit_file", "create", "str_replace", "str_replace_editor", "create_file", // Gemini, Copilot, Cursor, Droid, Hermes
  "mcp__plugin_git-fs_git-fs__write", "mcp__plugin_git-fs_git-fs__edit", "mcp__git-fs__write", "mcp__git-fs__edit",
])
export const isEdit = (tool: string) => EDIT_TOOLS.has(tool.toLowerCase())

/** Every overwatch tool a host can offer: the commands and the plan, by short name. */
export const TOOLS: Record<string, ToolSpec> = Object.fromEntries(
  [...Object.entries(COMMAND_TOOLS), ...Object.entries(PLAN_TOOLS)].map(([n, t]) => [n, { description: t.description, properties: t.properties, required: t.required }]),
)
export const schemaOf = (t: ToolSpec) => ({ type: "object", properties: t.properties ?? {}, ...(t.required?.length ? { required: [...t.required] } : {}) })

/** Text meant for Claude Code names tools `mcp__overwatch__x`; other hosts get the short name. */
export const plain = (s: string) => s.replaceAll(TOOL_PREFIX, "")

/** The project root: the git toplevel of `dir`, else `dir`. `OVERWATCH_PROJECT` overrides it (a host that starts MCP servers elsewhere). */
export async function projectRoot(io: Io, dir = io.cwd): Promise<string> {
  const pinned = process.env.OVERWATCH_PROJECT
  if (pinned) return pinned
  const r = await io.run(["git", "rev-parse", "--show-toplevel"], { cwd: dir, timeoutMs: 5000 })
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : dir
}

async function stateFile(io: Io, root: string): Promise<string> {
  const base = (await io.env("XDG_STATE_HOME")) || join((await io.env("HOME")) ?? "", ".local/state")
  return join(base, "overwatch/plans", `${hash(root)}.json`)
}

/** Read-modify-write of the project's state. Ceiling: no lock, so a hook and a tool call landing in the same millisecond can lose one write; add a lock file if that shows up. */
export async function withState<T>(io: Io, root: string, f: (s: State) => Promise<[State, T]> | [State, T]): Promise<T> {
  const path = await stateFile(io, root)
  let s: State
  try { s = { ...FRESH_STATE, ...JSON.parse((await io.read(path)) ?? "") } } catch { s = FRESH_STATE }
  const [next, out] = await f(s)
  if (next !== s) await io.write(path, JSON.stringify({ ...next, root }, null, 1))
  return out
}

const runCheck = async (io: Io, g: Guard, cwd: string): Promise<Guard> => {
  const r = await io.run(["sh", "-c", g.check!], { cwd, timeoutMs: CHECK_TIMEOUT_MS })
  const exit = r.code === 124 ? null : r.code
  return { ...g, met: exit === 0, last: { exit, out: (r.stdout + r.stderr).trim().slice(-600) } }
}

const decide = (plan: Plan, decided: Guard[]): Plan => {
  const byId = new Map(decided.map((g) => [g.id, g]))
  return { ...plan, guards: plan.guards.map((g) => byId.get(g.id) ?? g) }
}

export type ToolResult = { text: string; error?: boolean }

/** Runs one overwatch tool by short name, as every host's tool call does. */
export async function callTool(io: Io, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const root = await projectRoot(io)
  const at: Io = { ...io, cwd: root }
  try {
    const cmd = COMMAND_TOOLS[name]
    if (cmd) return { text: await cmd.run(at, args) }
    if (name === "plan_show") return withState(io, root, (s) => [s, { text: plain(detail(s.plan, CLEAN)) }])
    if (name === "guard_check") {
      const id = typeof args.guard_id === "string" && args.guard_id ? args.guard_id : undefined
      return withState(io, root, async (s) => {
        const pick = s.plan.guards.filter((g) => g.check && (!id || g.id === id))
        if (!pick.length) return [s, { text: id ? `no guard "${id}" with a check; plan_show lists the guard ids` : "no guard has a check; judged guards are decided at the stop", error: true }]
        const decided = await Promise.all(pick.map((g) => runCheck(io, g, root)))
        return [{ ...s, plan: decide(s.plan, decided) }, { text: decided.map((g) => `${g.id}: ${g.met ? "upheld" : `failing (${ran(g)})${tail(g)}`}`).join("\n") }]
      })
    }
    const run = PLAN_TOOLS[name]?.run
    if (!run) return { text: `unknown overwatch tool: ${name}; there are ${Object.keys(TOOLS).join(", ")}`, error: true }
    return withState(io, root, (s) => {
      const r = run(s.plan, args)
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

/** What a host does with the answer: add `context` to the model's input, `deny` the tool call, `block` the stop (the turn continues with the reason), or `notify` the user. */
export type Outcome = { context?: string; deny?: string; block?: string; notify?: string }

export async function onEvent(io: Io, e: Event): Promise<Outcome> {
  const root = await projectRoot(io, e.cwd || io.cwd)
  switch (e.kind) {
    case "start":
      return withState(io, root, (s) => [{ ...s, told: false }, { context: plain(reminder(s.plan, false, HOST_CONTRACT)) }])
    case "prompt":
      return withState(io, root, (s) => [
        { ...s, told: true, stops: e.person === false ? s.stops : { ...FRESH, nokeyTold: s.stops.nokeyTold } },
        { context: plain(reminder(s.plan, s.told, HOST_CONTRACT)) },
      ])
    case "pre_tool": {
      if (!isEdit(e.tool)) return {}
      const why = await withState(io, root, (s) => [s, gateReason(s.plan)])
      return why ? { deny: plain(why) } : {}
    }
    case "stop":
      return withState(io, root, async (s) => {
        // Judged guards need the turn's transcript, which hosts hand over in different shapes; they fail open here (ceiling: read transcript_path where a host gives one).
        const decided = await Promise.all(openGuards(s.plan.guards).filter((g) => g.check).map((g) => runCheck(io, g, root)))
        const plan = decide(s.plan, decided)
        const { verdict, next } = stopVerdict(plan, decided, CLEAN, s.stops)
        const out: Outcome = verdict.kind === "pass" ? {} : verdict.kind === "block" ? { block: plain(verdict.reason) } : { notify: plain(verdict.reason) }
        return [{ ...s, plan, stops: next }, out]
      })
  }
}
