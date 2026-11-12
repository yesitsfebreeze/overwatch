import type { FollowlineSlot, Guard, Plan, StopBook, Task, Verify } from "../types/index.d.ts"
import { TOOL_PREFIX } from "./catalog.ts"
import { CHECK_TIERS, guardMark, isTier, makeGuard } from "./guards.ts"
import { shellArgv, type Io, type Runner } from "./io.ts"

// The plan's pure logic: tools, reminder, gate and stop verdict. No engine import:
// plan-hooks.ts (Claude Code) and host/core.ts (every other host) run the same code.

export const tool = (name: string) => TOOL_PREFIX + name
export const EMPTY: Plan = { tasks: [], nextId: 1, guards: [] }
export const CLEAN: Verify = { dirty: false, review: false, simplify: false, lines: 0, unreviewed: 0 }
export const FRESH: StopBook = { sig: "", stalls: 0, rounds: 0 }

/** Refused stops with nothing changed before the stop is let through and the user told. */
export const MAX_STALLS = 3
/** Refused stops per user prompt before the same. */
const MAX_ROUNDS = 8
export const stopBudgetReason = (book: StopBook): string | undefined => book.rounds >= MAX_ROUNDS
  ? `overwatch: automatic verification budget exhausted after ${MAX_ROUNDS} refused stops. Work remains unverified; no new checks or judgments ran. Run guard_check explicitly or ask the user how to continue.`
  : undefined
/** A check past this is killed and counts as not upheld. */
export const CHECK_TIMEOUT_MS = 60_000
/** `/review` is the older name of `/code-review`. */
export const REVIEW_SKILLS = new Set(["code-review", "review"])
/** Tools that change files. Ceiling: writes through Bash or kern `fs` are not seen; track a diff of the worktree instead. */
export const EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "mcp__plugin_git-fs_git-fs__write", "mcp__plugin_git-fs_git-fs__edit"]
/** From this many changed lines /code-review is due before /simplify. */
export const LARGE_CHANGE_LINES = 50
/** Under this many changed lines no review pass is due. */
export const SMALL_CHANGE_LINES = 10

const clamp = (p: number) => Math.max(0, Math.min(100, Math.round(p)))
const openTasks = (s: Plan) => s.tasks.filter((t) => t.status !== "done")

/** What a plan tool's `run` returns. `warn`: a refusal, the plan unchanged. `work`: new work, which ends a review pass. */
export type Result = { state: Plan; text: string; warn?: boolean; work?: boolean }

export const refuse = (s: Plan, text: string): Result => ({ state: s, text, warn: true })

/** Runs `f` on a copy of the task `e.task_id` names, or refuses. `Number`: MCP clients may send `"3"`. */
const withTask = (s: Plan, e: any, f: (t: Task, tasks: Task[]) => Result): Result => {
  const tasks = s.tasks.map((t) => ({ ...t }))
  const t = tasks.find((x) => x.id === Number(e.task_id))
  return t ? f(t, tasks) : refuse(s, `no task #${e.task_id}; plan_show lists the task numbers`)
}

/** The review passes still due, each judged by the lines changed since it last ran. */
export const due = (v: Verify): string[] =>
  [((v.unreviewed || 0) >= LARGE_CHANGE_LINES || v.unknown?.review) && !v.review && "/code-review", ((v.lines || 0) >= SMALL_CHANGE_LINES || v.unknown?.simplify) && !v.simplify && "/simplify"].filter((x): x is string => !!x)

/** Replace the measured net totals; a first real edit voids a pass run before it. */
export const edited = (v: Verify, lines: number, unreviewed = lines): Verify =>
  ({ ...(v.dirty ? v : CLEAN), dirty: true, lines, unreviewed })

/** Each pass gets its own baseline; fixes during that pass retain its completion flag. */
export const skillRan = (v: Verify, skill: "review" | "simplify"): Verify => ({
  ...v, [skill]: true, [skill === "review" ? "unreviewed" : "lines"]: 0,
  ...(v.files ? { files: Object.fromEntries(Object.entries(v.files).map(([p, f]) => [p, { ...f, [skill]: f.current }])) } : {}),
  ...(v.unknown ? { unknown: { ...v.unknown, [skill]: false } } : {}),
})

/** New work ends a review pass: each skill is due again by the lines changed since it last ran. */
export const newWork = (v: Verify): Verify => ({ ...v, review: false, simplify: false })

/** `done`, `45%` or `45% active`. */
const taskState = (t: Task) => (t.status === "done" ? "done" : `${t.progress}%${t.status === "active" ? " active" : ""}`)

/** How a check ended (`exit 1` / `did not finish`), and its output's last lines, indented. */
export const ran = (g: Guard) => (g.last?.exit === null ? "did not finish" : `exit ${g.last?.exit}`)
export const tail = (g: Guard) => (g.last?.out ? `\n    ${g.last.out.trim().split("\n").slice(-4).join("\n    ")}` : "")

/** A guard after its check ran: exit 0 upholds it, null means it did not finish. */
export const checked = (g: Guard, exit: number | null, out: string): Guard => ({ ...g, met: exit === 0, last: { exit, out: out.trim().slice(-600) } })

/** Runs one guard's check from `cwd`; a check past CHECK_TIMEOUT_MS counts as not upheld. */
export const runCheck = async (run: Runner, g: Guard, cwd?: string): Promise<Guard> => {
  const r = await run([...await shellArgv(run), "-c", g.check!], { cwd, timeoutMs: CHECK_TIMEOUT_MS })
  return checked(g, r.code === 124 ? null : r.code, r.stdout + r.stderr)
}

/**
 * One outcome per check command, run from `cwd`. The guard objects are throwaway: a note's checks
 * are not plan guards, so only the command and its `met` matter.
 */
export const runChecks = (run: Runner, checks: string[], cwd?: string): Promise<Guard[]> =>
  Promise.all(checks.map((check) => runCheck(run, { id: check, question: `Does \`${check}\` pass?`, check, met: false }, cwd)))

/** The plan with the decided guards written back by id, onto whatever it holds now. */
export const withDecided = (s: Plan, decided: Guard[]): Plan => {
  const byId = new Map(decided.map((g) => [g.id, g]))
  return { ...s, guards: s.guards.map((g) => byId.get(g.id) ?? g) }
}

/** guard_check's pick: the guards with a check (only `guard_id` and `tier` when given), or the refusal when there are none. */
export const pickChecks = (s: Plan, guard_id: unknown, tier?: unknown): Guard[] | string => {
  const id = typeof guard_id === "string" && guard_id ? guard_id : undefined
  const t = typeof tier === "string" && tier ? tier : undefined
  if (t && !isTier(t)) return `tier must be one of ${CHECK_TIERS.join(", ")}`
  const pick = s.guards.filter((g) => g.check && (!id || g.id === id) && (!t || g.tier === t))
  if (pick.length) return pick
  return id ? `no guard "${id}" with a check; plan_show lists the guard ids`
    : t ? `no guard has a "${t}" check; plan_show lists the guard tiers`
    : "no guard has a check; judged guards are decided at the stop"
}

export const checkReport = (decided: Guard[]): string => decided.map((g) => `${g.id}: ${g.met ? "upheld" : `failing (${ran(g)})${tail(g)}`}`).join("\n")

/** guard_check over every host: the picked guards' checks run through `run`, returning the decision or the refusal. */
export async function runPicked(s: Plan, guard_id: unknown, tier: unknown, run: Runner, cwd?: string): Promise<{ decided: Guard[]; report: string } | string> {
  const pick = pickChecks(s, guard_id, tier)
  if (typeof pick === "string") return pick
  const decided = await Promise.all(pick.map((g) => runCheck(run, g, cwd)))
  return { decided, report: checkReport(decided) }
}

/** The open items of a refused stop in one line, for the incident ledger. */
export const openLine = (reason: string): string => reason.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2)).join("; ")

/** Where the review pass stands, for plan_show. */
export const reviewLine = (v: Verify): string => {
  if (!v.dirty) return "Review: no file changes since the last passed stop."
  const lines = Math.max(v.lines || 0, v.unreviewed || 0)
  const left = due(v)
  if (left.length) return `Review: ${v.unknown?.review || v.unknown?.simplify ? "unmeasured changes; " : ""}${lines} changed line(s)${(v.unreviewed || 0) >= LARGE_CHANGE_LINES ? " (large)" : ""}; due once tasks and guards are clear: ${left.join(", then ")}.`
  if (v.review || v.simplify) return "Review: review pass done."
  if (lines < SMALL_CHANGE_LINES) return `Review: ${lines} changed line(s) (small); no review pass needed.`
  return `Review: ${lines} changed line(s) since the last pass; none due yet.`
}

/** plan_show's answer. */
export const detail = (s: Plan, v: Verify): string =>
  [
    ...s.tasks.map((t) => `#${t.id} ${taskState(t)}: ${t.title}`),
    ...s.guards.map((g) => `guard ${g.id} [${guardMark(g)}]${g.tier ? ` ${g.tier}` : ""}${g.check ? ` check \`${g.check}\`` : " judged"}: ${g.question}${g.last?.error ? `\n    not evaluated: ${g.last.error}` : ""}`),
    s.tasks.length || s.guards.length ? `${overall(s)}% overall.` : "No tasks, no guards.",
    reviewLine(v),
  ].join("\n")

/** The plan in one line, for the reminder. */
const summary = (s: Plan): string =>
  [
    s.tasks.length
      ? `${s.tasks.length} task(s), ${overall(s)}% overall: ` +
        s.tasks.map((t) => `#${t.id} "${t.title}" ${taskState(t)}`).join("; ")
      : "",
    s.guards.length ? `${s.guards.length} guard(s): ` + s.guards.map((g) => `${g.id} [${guardMark(g)}]${g.check ? ` (\`${g.check}\`)` : ""}`).join("; ") : "",
  ]
    .filter(Boolean)
    .join(". ")

/** The mean over all tasks, a done task counting 100. */
export const overall = (s: Plan): number =>
  s.tasks.length ? clamp(s.tasks.reduce((n, t) => n + (t.status === "done" ? 100 : clamp(t.progress)), 0) / s.tasks.length) : 0

/** The plan as one followline gauge: red while a guard fails, green once everything holds. */
export function slot(s: Plan): FollowlineSlot {
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

/** Why an edit is refused, or undefined once the plan has tasks and guards. */
export const gateReason = (s: Plan): string | undefined =>
  s.tasks.length && s.guards.length
    ? undefined
    : `overwatch: ${s.tasks.length ? "no guards" : s.guards.length ? "no tasks" : "no tasks and no guards"} yet. Before changing files, put the work in the plan: tasks with ${tool("task_add")} {titles} and one guard per deliverable with ${tool("guard_add")} {question, check}. Then retry this call.`

type StopVerdict = { kind: "pass" } | { kind: "block"; reason: string } | { kind: "stalled"; reason: string }

/**
 * The decision every stop goes through. The review pass is asked for only once tasks and guards are
 * clear, so it reviews finished work. A refusal with nothing changed counts toward MAX_STALLS, every
 * refusal toward MAX_ROUNDS; either cap lets the stop through, so a stuck run never loops.
 */
export function stopVerdict(s: Plan, decided: Guard[], v: Verify, book: StopBook, contract = CONTRACT): { verdict: StopVerdict; next: StopBook } {
  const open = openTasks(s)
  const unmet = decided.filter((g) => !g.met)
  const left = due(v)
  const verify = !open.length && !unmet.length && v.dirty && left.length > 0
  if (!open.length && !unmet.length && !verify) return { verdict: { kind: "pass" }, next: { ...FRESH, nokeyTold: book.nokeyTold } }
  const lines = [
    ...open.map((t) => `- task #${t.id} "${t.title}" (${t.progress}%)`),
    ...unmet.map((g) => `- guard ${g.id} (${g.last?.error ? `not evaluated: ${g.last.error}` : g.check ? `check \`${g.check}\` ${ran(g)}` : `judged p=${(g.last?.p ?? 0).toFixed(2)}`}): ${g.question}${tail(g)}`),
    ...(verify ? [`- files changed: ${left.map((d) => `run ${d}`).join(", then ")} on the change (Skill tool), fix what they find`] : []),
  ]
  const sig = JSON.stringify([open.map((t) => [t.id, t.progress]), unmet.map((g) => [g.id, g.last?.exit, Math.round((g.last?.p ?? 0) * 10)]), verify && left])
  const stalls = sig === book.sig ? book.stalls + 1 : 0
  const next = { ...book, sig, stalls, rounds: book.rounds + 1 }
  const head = `overwatch: not done — ${lines.length} item(s) open:\n${lines.join("\n")}`
  if (stalls >= MAX_STALLS || next.rounds > MAX_ROUNDS)
    return { verdict: { kind: "stalled", reason: `${head}\n${stalls >= MAX_STALLS ? `unchanged over ${MAX_STALLS} refused stops` : `${MAX_ROUNDS} refused stops this prompt`} — letting the stop through for the user to decide.` }, next }
  return { verdict: { kind: "block", reason: `${head}\nWork these to completion with the plan tools (task_progress, task_complete, guard_check), then stop again. ${contract}` }, next }
}

/**
 * One tool: its schema and `run`, its pure change to the plan. guard_check and plan_show have named
 * handlers instead of `run`: the engine only lets `$` reach named functions, not ones read from a record.
 */
/** `run` is pure; `act` also reads and writes the project (the vault), so each host hands it an Io. */
export type PlanTool = { description: string; properties?: Record<string, unknown>; required?: string[]; run?: (s: Plan, e: any) => Result; act?: (io: Io, s: Plan, e: any) => Promise<Result> }

const TASK_ID = { type: "integer", minimum: 1, description: "The task's number as task_add or plan_show printed it (#3 → 3)." }
const TASK_TITLE = { type: "string", description: "Short imperative title, e.g. \"split the parser\"." }
export const trimmed = (v: unknown) => (typeof v === "string" ? v.trim() : "")

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
      tier: { type: "string", enum: [...CHECK_TIERS], description: "How heavy the check is, so guard_check can run one tier at a time." },
    },
    required: ["question"],
    run: (s, e) => {
      const g = makeGuard(s.guards, e.question ?? "", e.check, e.files, e.tier)
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
    properties: {
      guard_id: { type: "string", description: "Run only this guard's check; leave out to run every guard that has one." },
      tier: { type: "string", enum: [...CHECK_TIERS], description: "Run only checks of this tier." },
    },
  },
  plan_show: {
    description: "Show the whole plan: every task with its number, progress and status; every guard with its id, question, check and last outcome; and whether /code-review and /simplify are due on the changed files. Read-only.",
  },
  plan_clear: {
    description: "Empty the plan: every task and every guard. Only when the user abandons the work or asks for a fresh start; finished work is completed, not cleared.",
    run: (s) => ({ state: { tasks: [], nextId: s.nextId, guards: [] }, text: `Cleared ${s.tasks.length} task(s) and ${s.guards.length} guard(s)` }),
  },
}

