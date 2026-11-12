/**
 * The guard core, from orly: a guard is one yes/no question about the finished
 * work, decided by a shell command where one can, else judged by Jev (TypeSafe)
 * from the recorded turn. Pure: the hooks module does the I/O.
 */
import type { CheckTier, Guard } from "../types/index.d.ts"
import { estimateTokens } from "../jev/state.js"

// ── the turn, reduced to what a judge reads ──────────────────────────
const MAX_RESULTS = 12
const MAX_ACTIONS = 40

type Turn = {
  user_request: string
  assistant_final_message: string
  assistant_said: string
  actions_taken: string[]
  command_results: string[]
}

/** A Messages API message: role plus content blocks (text, tool_use, tool_result). */
export type Msg = { role: string; content?: unknown }

const FAILURE = /\b(fail(?:ed|ure|s|ing)?|errors?|err!|exit (?:code|status) [1-9]|traceback|panic(?:ked)?|not found|cannot find|denied|refused|timed out|assertion)\b/i
const EVIDENCE = /\b(pass(?:e[sd]|ing)?|ok|green|succe\w+|exit|done|\d+ (?:tests?|specs?))\b|✓|✗/i
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}…[${s.length - n} more chars]`)

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n")
      : ""

const blocks = (content: unknown): any[] => (Array.isArray(content) ? content : [])
const hasToolResult = (content: unknown) => blocks(content).some((b) => b?.type === "tool_result")

/** One line per tool call: the name plus whatever field names its target. */
function describeCall(name: string, input: any): string {
  const t = input?.command ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.url ?? input?.query ?? input?.description ?? (input === undefined ? "" : JSON.stringify(input))
  return clip(`${name}: ${String(t).replace(/\s+/g, " ")}`, 300)
}

/** Failures first (up to half the budget), the rest from the tail: a blind tail drops early failures. */
export function selectResults(results: string[], max = MAX_RESULTS): string[] {
  if (results.length <= max) return results
  const keep = new Set<number>()
  for (let i = 0; i < results.length && keep.size < Math.floor(max / 2); i++) if (FAILURE.test(results[i]!)) keep.add(i)
  for (let i = results.length - 1; i >= 0 && keep.size < max; i--) keep.add(i)
  return [...keep].sort((a, b) => a - b).map((i) => results[i]!)
}

/** Results share one budget: short ones whole, each long one its head, its tail, and the lines between that carry evidence. */
export function fitResults(results: string[], budget = MAX_RESULTS * 600): string[] {
  let left = budget
  let n = results.length
  let cap = Infinity
  for (const len of results.map((r) => r.length).sort((a, b) => a - b)) {
    if (len * n > left) {
      cap = Math.floor(left / n)
      break
    }
    left -= len
    n--
  }
  return results.map((r) => {
    if (r.length <= cap) return r
    const hits: [number, string][] = []
    let at = cap >> 2
    let used = 0
    for (const l of r.slice(at, -at).split("\n")) {
      if (used < cap / 2 && (FAILURE.test(l) || EVIDENCE.test(l))) {
        const c = clip(l.trim(), 200)
        hits.push([at, c])
        used += c.length + 1
      }
      at += l.length + 1
    }
    const q = Math.floor((cap - used) / 2)
    const kept = hits.filter(([i]) => i >= q && i < r.length - q).map(([, c]) => c)
    return `${r.slice(0, q)}…[cut: only lines carrying evidence kept]\n${kept.join("\n")}\n…${r.slice(-q)}`
  })
}

/** User-role text the harness wrote: stop-hook feedback, skill expansions, reminders. */
const MACHINE = /^(Stop hook feedback|overwatch: not done|Base directory for this skill|<command-(name|message)>|<system-reminder>|<task-notification>)/

const human = (m: Msg) => {
  if (m.role !== "user" || hasToolResult(m.content)) return false
  const text = textOf(m.content).trim()
  return text !== "" && !MACHINE.test(text)
}

/** The last turn, from the last genuine human message on, reduced to a `Turn`. */
export function lastTurn(messages: readonly Msg[]): Turn {
  const start = Math.max(0, messages.findLastIndex(human))
  const said: string[] = []
  const actions: string[] = []
  const results: string[] = []
  const ids = new Map<string, number>()
  for (const m of messages.slice(start + 1)) {
    if (m.role === "assistant") {
      const text = textOf(m.content).trim()
      if (text) said.push(text)
      for (const b of blocks(m.content))
        if (b?.type === "tool_use") {
          actions.push(`#${actions.length + 1} ${describeCall(b.name, b.input)}`)
          ids.set(String(b.id), actions.length)
        }
    } else
      for (const b of blocks(m.content))
        if (b?.type === "tool_result") {
          const body = typeof b.content === "string" ? b.content : textOf(b.content)
          results.push(`#${ids.get(String(b.tool_use_id)) ?? "?"} → ${body.trim().replace(/\n{3,}/g, "\n\n") || "(no output)"}`)
        }
  }
  return {
    user_request: clip(textOf(messages[start]?.content).trim(), 4000),
    assistant_final_message: clip(said.at(-1) ?? "", 4000),
    assistant_said: clip(said.join("\n\n"), 8000),
    actions_taken: actions.slice(-MAX_ACTIONS),
    command_results: fitResults(selectResults(results)),
  }
}

// ── guards ───────────────────────────────────────────────────────────
const STOP = new Set(
  "the and are for its any all not was has had did can does this that with from have into only when what which where there their then than them they were been will would should could about every each also file files project code line lines true false shown current real show shows after before still".split(" "),
)

/** An id from the question's first three telling words, unique among `taken`. */
export function guardId(question: string, taken: string[] = []): string {
  const base = (question.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter((w) => !STOP.has(w)).slice(0, 3).join("-")
  const slug = base.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "guard"
  let id = slug
  for (let n = 2; taken.includes(id); n++) id = `${slug}-${n}`
  return id
}

const UNCHECKABLE =
  /\b(clean|elegant|readable|maintainable|idiomatic|well[- ](structured|designed|written)|good|nice|proper|appropriate|robust|scalable|performant|secure enough|best practice)\b/i

/** A command that exits 0 whatever happened, as the last word of a check. */
const ALWAYS = String.raw`(?:true|:|exit\s+0|(?:echo|printf)(?:[ \t][^|;&\n]*)?)`

const BARE = new RegExp(`^(?:${ALWAYS}|exit)$`)
const OR_ALWAYS = new RegExp(String.raw`\|\|\s*${ALWAYS}$`)
const LAST_ALWAYS = new RegExp(String.raw`[;\n]\s*${ALWAYS}$`)
const PIPED_AWAY = new RegExp(String.raw`(?:^|[^|])\|&?\s*(?:(?:tail|head|tee|cat)\b[^|;&\n]*|${ALWAYS})$`)
const ENDS_EARLIER = /\bexit\s+[1-9]|\bset\s+(?:-[a-z]*e|-o\s+errexit)/

/**
 * Whether a check's exit code says nothing about the work: a bare always-0 command, anything ending in
 * `|| <always-0>`, a last `; <always-0>` with no earlier `exit N` or `set -e` that could end it first, or a
 * last pipe into tail/head/tee/cat or an always-0 command (sh takes a pipe's status from its last command).
 * Quoted text, comments, parens and trailing `;` are looked through; a substitution (`$(...)`, `<(...)`,
 * backticks) is one word, so a pipe inside it is not the check's own.
 */
export function cannotFail(check: string): boolean {
  let c = check
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''") // quoted text neither ends nor joins commands
    .replace(/(^|[ \t])#.*$/gm, "$1")
    .replace(/`[^`]*`/g, "x")
  // Innermost first, so nested substitutions fold; one holding a bare subshell `$( (a) )` is left as is.
  for (let prev = ""; prev !== c; ) {
    prev = c
    c = c.replace(/[$<>]\([^()]*\)/g, "x")
  }
  c = c
    .replace(/[()]/g, " ")
    .replace(/[;\s]+$/, "")
    .trim()
  return BARE.test(c) || OR_ALWAYS.test(c) || PIPED_AWAY.test(c) || (LAST_ALWAYS.test(c) && !ENDS_EARLIER.test(c))
}

/** The check tiers a guard may name: cheap, unit-level, or the full milestone gate. */
export const CHECK_TIERS = ["fast", "unit", "milestone"] as const

/** Whether a value is a tier; the one place the list is checked. */
export const isTier = (t: unknown): t is CheckTier => typeof t === "string" && (CHECK_TIERS as readonly string[]).includes(t)

/** A command's weight from its name: a build or a project verify is the milestone gate, tests are unit, the rest fast. */
export function checkTier(command: string): CheckTier {
  if (/\b(build|e2e|verify|accept|milestone)\b/.test(command)) return "milestone"
  if (/\b(test|spec)s?\b|pytest|vitest|jest|mocha|nextest|cargo test/.test(command)) return "unit"
  return "fast"
}

export const CHECK_TIMEOUT_MS = 60_000
export const MAX_CHECK_TIMEOUT_MS = 600_000
export const checkTimeout = (value: unknown): number | string => value === undefined ? CHECK_TIMEOUT_MS
  : typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_CHECK_TIMEOUT_MS ? value
  : `timeout_ms must be an integer from 1 to ${MAX_CHECK_TIMEOUT_MS} (default ${CHECK_TIMEOUT_MS})`

/** A new guard, or the reason it is refused. */
export function makeGuard(taken: Guard[], question: string, check?: string, files?: string[], tier?: string, timeout_ms?: unknown): Guard | string {
  const q = question.trim().replace(/\s+/g, " ")
  if (q.length < 15) return "a guard is one yes/no question of at least 15 characters"
  const c = check?.trim()
  if (check !== undefined && !c) return "check needs a command"
  if (c && cannotFail(c)) return `check cannot fail: \`${c}\`; give a command whose exit code decides the question`
  const taste = !c && q.replace(/`[^`]*`/g, "").match(UNCHECKABLE)
  if (taste) return `taste words cannot be judged: ${taste[0]}`
  const t = tier?.trim()
  if (t && !isTier(t)) return `tier must be one of ${CHECK_TIERS.join(", ")}`
  const timeout = checkTimeout(timeout_ms)
  if (typeof timeout === "string") return timeout
  if (timeout_ms !== undefined && !c) return "timeout_ms only applies to a shell check"
  const g: Guard = { id: guardId(q, taken.map((x) => x.id)), question: q }
  if (timeout_ms !== undefined) g.timeout_ms = timeout
  if (c) g.check = c
  if (t) g.tier = t as Guard["tier"]
  if (files?.length) g.files = files
  return g
}

/** Guards the next stop decides: every check, and every judged guard not yet upheld. */
export const openGuards = (gs: Guard[]) => gs.filter((g) => g.check || !g.met)

export const guardMark = (g: Guard): "upheld" | "failing" | "open" => (g.met ? "upheld" : g.last ? "failing" : "open")

// ── the judge ────────────────────────────────────────────────────────
export const GUARD_MET = 0.7
export const JUDGE_URL = "https://api.typesafe.ai/v1/systemone"
export const MAX_JUDGE_TOKENS = 18_000
export const judgeFile = (text: string) => text.length <= 12_000 ? text : `${text.slice(0, 12_000)}\n...[truncated; ${text.length - 12_000} characters omitted]`

const FRAME =
  "Judge only from the recorded turn (`user_request`, `assistant_said`, `actions_taken`, `command_results`) and, where shown, `project.files`, the real current content of those files. Something not shown is unknown, not absent. The agent's own words are a claim, not evidence; a recorded command result or a shown file is evidence."

/** The request body that asks Jev one question per judged guard. */
export const judgeBody = (turn: Turn, guards: Guard[], files: Record<string, string>) => ({
  model: "jev-latest",
  state: Object.keys(files).length ? { ...turn, project: { files } } : turn,
  questions: Object.fromEntries(
    guards.map((g) => [
      g.id,
      {
        type: "noul",
        instructions: `${g.question}\n\n${FRAME}`,
        criteria: { true: "The recorded evidence establishes that the answer is yes.", false: "The evidence does not establish it, or shows the opposite." },
      },
    ]),
  ),
})

/** Measure the complete serialized request; no question or selected file is silently dropped. */
export function judgeRequest(turn: Turn, guards: Guard[], files: Record<string, string>, maxTokens?: unknown) {
  const limit = typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : MAX_JUDGE_TOKENS
  const body = JSON.stringify(judgeBody(turn, guards, files))
  const tokens = estimateTokens(body)
  const error = tokens > limit ? `Judge input is approximately ${tokens} tokens; limit ${limit}. Narrow the listed files or split the work into smaller guarded steps.` : undefined
  return { body, tokens, error }
}

/** The probability of yes per guard id from Jev's answers; NaN where it gave none. */
export const judgeProbs = (answers: any, guards: Guard[]): Record<string, number> =>
  Object.fromEntries(guards.map((g) => [g.id, Number(answers?.[g.id]?.noul ?? answers?.[g.id]?.probability ?? NaN)]))
