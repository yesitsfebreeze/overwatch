import type { Guard, Plan, StopBook, Task, Verify } from "../types/index.d.ts"
import { TOOL_PREFIX } from "./catalog.ts"
import { guardMark, makeGuard } from "./guards.ts"

// The plan's pure logic: tools, reminder, gate and stop verdict. No engine import, so the
// Claude Code hooks (plan-hooks.ts) and every other host (host/core.ts) run the same code.

/** A registered tool's full name: `mcp__<plugin>__<name>`. */
export const tool = (name: string) => TOOL_PREFIX + name
export const EMPTY: Plan = { tasks: [], nextId: 1, guards: [] }
export const CLEAN: Verify = { dirty: false, review: false, simplify: false, lines: 0, unreviewed: 0 }
export const FRESH: StopBook = { sig: "", stalls: 0, rounds: 0 }

/** Refused stops with nothing changed before the stop is let through and the user told. */
export const MAX_STALLS = 3
/** Refused stops per user prompt before the same. */
export const MAX_ROUNDS = 8
/** A check past this is killed and counts as not upheld. */
export const CHECK_TIMEOUT_MS = 60_000
/** Skills that count as the review pass; `/review` is the older name of `/code-review`. */
export const REVIEW_SKILLS = new Set(["code-review", "review"])
/** Tools that change files: gated on an empty plan and marking the work dirty. Bash writes and kern `fs` writes (one tool that also reads) are not seen (ceiling: track a diff of the worktree instead). */
export const EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "mcp__plugin_git-fs_git-fs__write", "mcp__plugin_git-fs_git-fs__edit"]
/** A change touching this many lines is large: /code-review is asked for on top of /simplify. */
export const LARGE_CHANGE_LINES = 50
/** A change under this many lines is small: no review pass is asked for. */
export const SMALL_CHANGE_LINES = 10

/** Lines in `s`, a trailing newline not starting one; counted without copying, as a whole-file write passes through here. */
const lineCount = (s: unknown) => {
  if (typeof s !== "string" || !s) return 0
  let n = 1
  for (let i = s.indexOf("\n"); i !== -1 && i < s.length - 1; i = s.indexOf("\n", i + 1)) n++
  return n
}
const parts = (i: any): unknown[] => [i?.edits, i?.items].filter(Array.isArray).flat()
const oldText = (i: any) => i?.old_string ?? i?.old ?? i?.oldText
const wholeText = (i: any) => i?.content ?? i?.text
const newText = (i: any) => i?.new_string ?? i?.new ?? i?.newText ?? wholeText(i) ?? i?.new_source

/** Lines the input shows: the larger of the replaced and the new text, summed over `edits` and git-fs `items`. */
const shownLines = (i: any): number => {
  const ps = parts(i)
  if (ps.length) return ps.reduce((n: number, x) => n + shownLines(x), 0)
  return Math.max(lineCount(oldText(i)), lineCount(newText(i)))
}

/** Whether the input hides text the call replaces: a whole-file write, a replace_all, a notebook cell replace or delete. */
const hidesReplaced = (i: any): boolean =>
  parts(i).some(hidesReplaced) ||
  i?.replace_all === true ||
  (oldText(i) === undefined && wholeText(i) !== undefined) ||
  (i?.notebook_path !== undefined && i?.edit_mode !== "insert")

/**
 * Lines one edit-tool call touches. A call that hides what it replaces counts as at least SMALL_CHANGE_LINES, once
 * per call (not per item), so it never slips under the small-change exemption and a few new files stay small.
 */
export const changedLines = (i: any): number => Math.max(shownLines(i), hidesReplaced(i) ? SMALL_CHANGE_LINES : 0)

/** One gauge on followline's line, as `$.followline.put` takes it (followline's own type, kept local: no dependency). */
export type Slot = { id: string; label?: string; pct: number; color?: "green" | "yellow" | "red"; detail?: string }

const clamp = (p: number) => Math.max(0, Math.min(100, Math.round(p)))
const openTasks = (s: Plan) => s.tasks.filter((t) => t.status !== "done")

/**
 * What a plan tool's pure `run` returns: the next plan and the text the model
 * reads. `warn` marks a refusal, the plan unchanged. `work` marks a change that
 * starts new work, which ends a running review/simplify pass.
 */
export type Result = { state: Plan; text: string; warn?: boolean; work?: boolean }

const refuse = (s: Plan, text: string): Result => ({ state: s, text, warn: true })

/** Runs `f` on a copy of the task `e.task_id` names, or refuses; MCP clients may send `"3"` for an integer field. */
const withTask = (s: Plan, e: any, f: (t: Task, tasks: Task[]) => Result): Result => {
  const tasks = s.tasks.map((t) => ({ ...t }))
  const t = tasks.find((x) => x.id === Number(e.task_id))
  return t ? f(t, tasks) : refuse(s, `no task #${e.task_id}; plan_show lists the task numbers`)
}

/**
 * The review passes still due on a dirty change, each judged by the lines changed since it last ran: /simplify
 * from SMALL_CHANGE_LINES, /code-review first from LARGE_CHANGE_LINES.
 */
export const due = (v: Verify): string[] =>
  [(v.unreviewed || 0) >= LARGE_CHANGE_LINES && !v.review && "/code-review", (v.lines || 0) >= SMALL_CHANGE_LINES && !v.simplify && "/simplify"].filter((x): x is string => !!x)

/** One edit of `n` lines: the first marks the change dirty and voids a pass run before it; later ones add to both counts and keep the pass. */
export const edited = (v: Verify, n: number): Verify =>
  v.dirty ? { ...v, lines: (v.lines || 0) + n, unreviewed: (v.unreviewed || 0) + n } : { ...CLEAN, dirty: true, lines: n, unreviewed: n }

/**
 * New work ends a review pass. Each skill that ran covered every line so far, so its count starts again from 0
 * and the fix for a finding is judged by its own size, not the reviewed change's; a skill that did not run keeps its count.
 */
export const newWork = (v: Verify): Verify => ({ ...v, review: false, simplify: false, lines: v.simplify ? 0 : v.lines, unreviewed: v.review ? 0 : v.unreviewed })

/** A task's state as every view prints it: `done`, or `45%` / `45% active`. */
const taskState = (t: Task) => (t.status === "done" ? "done" : `${t.progress}%${t.status === "active" ? " active" : ""}`)

/** How a check ended (`exit 1` / `did not finish`), and its output's last lines, indented. */
export const ran = (g: Guard) => (g.last?.exit === null ? "did not finish" : `exit ${g.last?.exit}`)
export const tail = (g: Guard) => (g.last?.out ? `\n    ${g.last.out.trim().split("\n").slice(-4).join("\n    ")}` : "")

/** A guard after its check ran: exit 0 upholds it, null means it did not finish. The last 600 chars of output are kept. */
export const checked = (g: Guard, exit: number | null, out: string): Guard => ({ ...g, met: exit === 0, last: { exit, out: out.trim().slice(-600) } })

/** The plan with the decided guards written back by id, onto whatever it holds now. */
export const withDecided = (s: Plan, decided: Guard[]): Plan => {
  const byId = new Map(decided.map((g) => [g.id, g]))
  return { ...s, guards: s.guards.map((g) => byId.get(g.id) ?? g) }
}

/** guard_check's pick: the guards with a check (only `guard_id` when given), or the refusal when there are none. */
export const pickChecks = (s: Plan, guard_id: unknown): Guard[] | string => {
  const id = typeof guard_id === "string" && guard_id ? guard_id : undefined
  const pick = s.guards.filter((g) => g.check && (!id || g.id === id))
  if (pick.length) return pick
  return id ? `no guard "${id}" with a check; plan_show lists the guard ids` : "no guard has a check; judged guards are decided at the stop"
}

/** guard_check's answer: each guard upheld or failing, with its exit and output tail. */
export const checkReport = (decided: Guard[]): string => decided.map((g) => `${g.id}: ${g.met ? "upheld" : `failing (${ran(g)})${tail(g)}`}`).join("\n")

/** The open items of a refused stop in one line, for the incident ledger. */
export const openLine = (reason: string): string => reason.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2)).join("; ")

/** Where the review pass stands: what plan_show reports beside the plan. */
export const reviewLine = (v: Verify): string => {
  if (!v.dirty) return "Review: no file changes since the last passed stop."
  const lines = Math.max(v.lines || 0, v.unreviewed || 0)
  const left = due(v)
  if (lines < SMALL_CHANGE_LINES) return `Review: ${lines} changed line(s) (small); no review pass needed.`
  return `Review: ${lines} changed line(s)${(v.unreviewed || 0) >= LARGE_CHANGE_LINES ? " (large)" : ""}; ${left.length ? `due once tasks and guards are clear: ${left.join(", then ")}` : "review pass done"}.`
}

/** The plan in full for plan_show: tasks, each guard with its question and last outcome, the review state. */
export const detail = (s: Plan, v: Verify): string =>
  [
    ...s.tasks.map((t) => `#${t.id} ${taskState(t)}: ${t.title}`),
    ...s.guards.map((g) => `guard ${g.id} [${guardMark(g)}]${g.check ? ` check \`${g.check}\`` : " judged"}: ${g.question}`),
    s.tasks.length || s.guards.length ? `${overall(s)}% overall.` : "No tasks, no guards.",
    reviewLine(v),
  ].join("\n")

/** The plan in one line each for tasks and guards, as the model reads it. */
export const summary = (s: Plan): string =>
  [
    s.tasks.length
      ? `${s.tasks.length} task(s), ${overall(s)}% overall: ` +
        s.tasks.map((t) => `#${t.id} "${t.title}" ${taskState(t)}`).join("; ")
      : "",
    s.guards.length ? `${s.guards.length} guard(s): ` + s.guards.map((g) => `${g.id} [${guardMark(g)}]${g.check ? ` (\`${g.check}\`)` : ""}`).join("; ") : "",
  ]
    .filter(Boolean)
    .join(". ")

/** Overall progress: the mean over all tasks, a done task counting 100. */
export const overall = (s: Plan): number =>
  s.tasks.length ? clamp(s.tasks.reduce((n, t) => n + (t.status === "done" ? 100 : clamp(t.progress)), 0) / s.tasks.length) : 0

/**
 * The plan as one followline gauge: overall progress, red while a guard fails,
 * green once everything holds. Followline owns the drawing.
 */
export function slot(s: Plan): Slot {
  if (!s.tasks.length && !s.guards.length) return { id: "plan", label: "tasks", pct: 0, detail: "no plan" }
  const open = openTasks(s).length
  const held = s.guards.filter((g) => g.met).length
  const failing = s.guards.some((g) => guardMark(g) === "failing")
  const active = s.tasks.find((t) => t.status === "active")
  return {
    id: "plan",
    label: "tasks",
    pct: overall(s),
    ...(failing ? { color: "red" as const } : !open && held === s.guards.length ? { color: "green" as const } : {}),
    detail: [`${s.tasks.length - open}/${s.tasks.length} done`, `guards ${held}/${s.guards.length}`, active && `▶ #${active.id} ${active.title}`].filter(Boolean).join(" · "),
  }
}

export const CONTRACT = `Every stop is refused until all tasks are done, every guard is upheld and, when ${SMALL_CHANGE_LINES}+ lines changed, /simplify ran on the change, preceded by /code-review when the change is large (${LARGE_CHANGE_LINES}+ changed lines); invoke them with the Skill tool. Need the user's input: ask with AskUserQuestion. A guard that cannot be met: say so and why; only the user drops a guard.`

/** What the model reads beside every prompt: the full rules until `told`, then one line. */
export function reminder(s: Plan, told = false, contract = CONTRACT): string {
  const empty = !s.tasks.length && !s.guards.length
  if (told) return `[overwatch] ${empty ? `No plan. Before changing files: ${tool("task_add")} + ${tool("guard_add")}` : `${summary(s)}. Add tasks and guards for new work`} (rules given earlier this session).`
  if (empty)
    return `[overwatch] No plan yet. If this request involves creating, changing or fixing anything, you MUST first, BEFORE starting the work, (1) break it into tasks with ${tool("task_add")} {titles:[…]} and (2) add one guard per thing the work must deliver with ${tool("guard_add")} {question:"<one yes/no question about the finished work>", check:"<shell command, exit 0 = upheld>"} (leave out check only when no command decides it; files:[…] lets the judge read them). File edits are refused until both exist. Report progress with task_progress {task_id, progress} and finish with task_complete {task_id} as you go. For a question or chat that changes nothing, skip all of this. ${contract}`
  return `[overwatch] ${summary(s)}. Keep this current with the plan tools (task_add, task_progress, task_start, task_complete, task_replace, task_remove, guard_add, guard_check, plan_show); add tasks and guards for new work. ${contract}`
}

/** Why an edit is refused: the plan is missing tasks or guards. */
export const gateReason = (s: Plan): string | undefined =>
  s.tasks.length && s.guards.length
    ? undefined
    : `overwatch: ${s.tasks.length ? "no guards" : s.guards.length ? "no tasks" : "no tasks and no guards"} yet. Before changing files, put the work in the plan: tasks with ${tool("task_add")} {titles} and one guard per deliverable with ${tool("guard_add")} {question, check}. Then retry this call.`

export type StopVerdict = { kind: "pass" } | { kind: "block"; reason: string } | { kind: "stalled"; reason: string }

/**
 * The pure decision every stop goes through. Open tasks and unmet guards come
 * first; the review pass is asked for only once those are clear, so it reviews
 * finished work. A refusal with nothing changed since the last one counts
 * toward MAX_STALLS, every refusal toward MAX_ROUNDS; either cap lets the stop
 * through and tells the user, so a stuck run never loops.
 */
export function stopVerdict(s: Plan, decided: Guard[], v: Verify, book: StopBook): { verdict: StopVerdict; next: StopBook } {
  const open = openTasks(s)
  const unmet = decided.filter((g) => !g.met)
  // A small change needs only /simplify; a large one /code-review as well.
  const left = due(v)
  const verify = !open.length && !unmet.length && v.dirty && left.length > 0
  if (!open.length && !unmet.length && !verify) return { verdict: { kind: "pass" }, next: { ...FRESH, nokeyTold: book.nokeyTold } }
  const lines = [
    ...open.map((t) => `- task #${t.id} "${t.title}" (${t.progress}%)`),
    ...unmet.map((g) => `- guard ${g.id} (${g.check ? `check \`${g.check}\` ${ran(g)}` : `judged p=${(g.last?.p ?? 0).toFixed(2)}`}): ${g.question}${tail(g)}`),
    ...(verify ? [`- files changed: ${left.map((d) => `run ${d}`).join(", then ")} on the change (Skill tool), fix what they find`] : []),
  ]
  const sig = JSON.stringify([open.map((t) => [t.id, t.progress]), unmet.map((g) => [g.id, g.last?.exit, Math.round((g.last?.p ?? 0) * 10)]), verify && left])
  const stalls = sig === book.sig ? book.stalls + 1 : 0
  const next = { ...book, sig, stalls, rounds: book.rounds + 1 }
  const head = `overwatch: not done — ${lines.length} item(s) open:\n${lines.join("\n")}`
  if (stalls >= MAX_STALLS || next.rounds > MAX_ROUNDS)
    return { verdict: { kind: "stalled", reason: `${head}\n${stalls >= MAX_STALLS ? `unchanged over ${MAX_STALLS} refused stops` : `${MAX_ROUNDS} refused stops this prompt`} — letting the stop through for the user to decide.` }, next }
  return { verdict: { kind: "block", reason: `${head}\nWork these to completion with the plan tools (task_progress, task_complete, guard_check), then stop again. ${CONTRACT}` }, next }
}

/**
 * One flat tool: its schema and `run`, its pure change to the plan. guard_check and
 * plan_show read state or run checks, so they have named handlers instead: the
 * engine only lets `$` reach named functions, not ones read from a record.
 */
type PlanTool = { description: string; properties?: Record<string, unknown>; required?: string[]; run?: (s: Plan, e: any) => Result }

const TASK_ID = { type: "integer", minimum: 1, description: "The task's number as task_add or plan_show printed it (#3 → 3)." }
const TASK_TITLE = { type: "string", description: "Short imperative title, e.g. \"split the parser\"." }
const trimmed = (v: unknown) => (typeof v === "string" ? v.trim() : "")

/** The plan's tools, one per change, each its own `mcp__overwatch__<name>`, each owning its logic: no `action` switch. */
export const PLAN_TOOLS: Record<string, PlanTool> = {
  task_add: {
    description: "Add tasks to the session plan, one per step of the user's request, in the order they will be worked. Call once with every title before starting work: file edits are refused until the plan has tasks and guards. Returns each new task's number. All titles are added, or none when one is empty.",
    properties: { titles: { type: "array", items: TASK_TITLE, minItems: 1, description: "One short imperative title per task, e.g. [\"split the parser\", \"update the README\"]." } },
    required: ["titles"],
    run: (s, e) => {
      const titles = (Array.isArray(e.titles) ? e.titles : []).map(trimmed)
      if (!titles.length || titles.some((x: string) => !x)) return refuse(s, "task_add needs at least one title, none empty")
      const fresh: Task[] = titles.map((title: string, k: number) => ({ id: s.nextId + k, title, progress: 0, status: "todo" }))
      const tasks = [...s.tasks, ...fresh]
      return { state: { ...s, tasks, nextId: s.nextId + fresh.length }, text: `${fresh.map((t) => `Added #${t.id} "${t.title}"`).join("\n")} (${tasks.length} tasks)`, work: true }
    },
  },
  task_progress: {
    description: "Set a task's progress as the work moves, 0-100; 100 marks it done. Call after each meaningful step so the gauge stays honest. To finish a task, task_complete says it plainly.",
    properties: { task_id: TASK_ID, progress: { type: "number", minimum: 0, maximum: 100, description: "Percent of the task done." } },
    required: ["task_id", "progress"],
    run: (s, e) =>
      withTask(s, e, (t, tasks) => {
        if (typeof e.progress !== "number" || !Number.isFinite(e.progress)) return refuse(s, "task_progress needs a number 0-100")
        const p = clamp(e.progress)
        t.progress = p
        t.status = p >= 100 ? "done" : p > 0 ? "active" : "todo"
        return { state: { ...s, tasks }, text: `#${t.id} "${t.title}" at ${p}%${p >= 100 ? " — done" : ""}`, work: p < 100 }
      }),
  },
  task_start: {
    description: "Mark the task you are working on now; any other active task goes back to todo. The gauge shows it with ▶. Does not change progress.",
    properties: { task_id: TASK_ID },
    required: ["task_id"],
    run: (s, e) =>
      withTask(s, e, (t, tasks) => {
        if (t.status === "done") return refuse(s, `#${t.id} is done; task_replace starts it over as a new task`)
        for (const x of tasks) if (x.status === "active") x.status = "todo"
        t.status = "active"
        return { state: { ...s, tasks }, text: `Now working on #${t.id} "${t.title}"`, work: true }
      }),
  },
  task_complete: {
    description: "Mark a task done (100%). Call when its work is finished and verified, not when it starts. A stop is refused while any task is open.",
    properties: { task_id: TASK_ID },
    required: ["task_id"],
    run: (s, e) =>
      withTask(s, e, (t, tasks) => {
        t.progress = 100
        t.status = "done"
        const left = tasks.filter((x) => x.status !== "done").length
        return { state: { ...s, tasks }, text: `Completed #${t.id} "${t.title}"${left ? ` (${left} left)` : " — all tasks done"}` }
      }),
  },
  task_replace: {
    description: "Swap a task for a reworded or re-scoped one when the request changed: the old number retires and the new task starts at 0%. Not for renaming a finished task.",
    properties: { task_id: TASK_ID, title: TASK_TITLE },
    required: ["task_id", "title"],
    run: (s, e) =>
      withTask(s, e, (t, tasks) => {
        const title = trimmed(e.title)
        if (!title) return refuse(s, "task_replace needs the new title")
        const fresh: Task = { id: s.nextId, title, progress: 0, status: "todo" }
        tasks[tasks.indexOf(t)] = fresh
        return { state: { ...s, tasks, nextId: s.nextId + 1 }, text: `Replaced #${t.id} "${t.title}" with #${fresh.id} "${title}"`, work: true }
      }),
  },
  task_remove: {
    description: "Drop a task that no longer belongs to the work (the user cut it, or it was a duplicate). Finished tasks are completed with task_complete, not removed.",
    properties: { task_id: TASK_ID },
    required: ["task_id"],
    run: (s, e) => withTask(s, e, (t, tasks) => ({ state: { ...s, tasks: tasks.filter((x) => x !== t) }, text: `Removed #${t.id} "${t.title}"` })),
  },
  guard_add: {
    description: "Add a guard: one yes/no question about the finished work that must hold before the session may stop. Add one per deliverable. Give a check whenever a command can decide it: it runs from the session's start directory at every stop (and on guard_check), exit 0 = upheld, so a regression reopens it. Without a check, a judge decides from the last turn and the listed files. Taste words (clean, nice, readable) are refused unless a check decides. Returns the guard's id.",
    properties: {
      question: { type: "string", description: "One yes/no question about the finished work, at least 15 characters, e.g. \"Do the parser tests pass?\"." },
      check: { type: "string", description: "Shell command that decides it, exit 0 = upheld, e.g. \"bun test hooks/\". Leave out only when no command can decide it." },
      files: { type: "array", items: { type: "string" }, description: "Files (relative to the project) whose current content the judge reads; for guards without a check." },
    },
    required: ["question"],
    run: (s, e) => {
      const g = makeGuard(s.guards, e.question ?? "", e.check, e.files)
      if (typeof g === "string") return refuse(s, g)
      return { state: { ...s, guards: [...s.guards, g] }, text: `Guard ${g.id}${g.check ? ` (check: ${g.check})` : " (judged)"}: ${g.question} (${s.guards.length + 1} guards)` }
    },
  },
  guard_drop: {
    description: "Remove a guard. Only on the user's explicit word: a guard that cannot be met is reported to the user with the reason, not dropped.",
    properties: { guard_id: { type: "string", description: "The guard's id as guard_add or plan_show printed it, e.g. \"tests-pass-bun\"." } },
    required: ["guard_id"],
    run: (s, e) => {
      const g = s.guards.find((x) => x.id === e.guard_id)
      if (!g) return refuse(s, `no guard "${e.guard_id}"; plan_show lists the guard ids`)
      return { state: { ...s, guards: s.guards.filter((x) => x !== g) }, text: `Dropped guard ${g.id}` }
    },
  },
  guard_check: {
    description: "Run the guards' shell checks now and record the outcome, instead of waiting for the stop. Use after a fix to confirm a guard holds before stopping. Only guards with a check run here; judged guards are decided at the stop. Returns each guard upheld or failing with its exit code and output tail.",
    properties: { guard_id: { type: "string", description: "Run only this guard's check; leave out to run every guard that has one." } },
  },
  plan_show: {
    description: "Show the whole plan: every task with its number, progress and status; every guard with its id, question, check and last outcome; and whether /code-review and /simplify are due on the changed files. Read-only.",
  },
  plan_clear: {
    description: "Empty the plan: every task and every guard. Only when the user abandons the work or asks for a fresh start; finished work is completed, not cleared.",
    run: (s) => ({ state: { tasks: [], nextId: s.nextId, guards: [] }, text: `Cleared ${s.tasks.length} task(s) and ${s.guards.length} guard(s)` }),
  },
}

