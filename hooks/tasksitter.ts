import { atom, read, update, type Register } from "claude-code"
import type { Guard, Plan } from "../types/index.d.ts"
import { takeNotice } from "./version.ts"
import { takeEvaluation } from "./tools.ts"
import { GUARD_MET, JUDGE_URL, judgeBody, judgeProbs, lastTurn, openGuards, type Msg } from "./guards.ts"
import { CHECK_TIMEOUT_MS, CLEAN, EDIT_TOOLS, EMPTY, FRESH, PLAN_TOOLS, REVIEW_SKILLS, changedLines, detail, gateReason, ran, reminder, slot, stopVerdict, tail, tool, type Result } from "./plan.ts"

export * from "./plan.ts"

const PLAN = atom({ plugin: "overwatch", key: "plan" } as const, EMPTY)
const VERIFY = atom({ plugin: "overwatch", key: "verify" } as const, CLEAN)
const STOPS = atom({ plugin: "overwatch", key: "stop" } as const, FRESH)
/** The directory the session started in: guard checks run from here, not from wherever a `cd` left the shell. */
const ROOT = atom({ plugin: "overwatch", key: "root" } as const, "")
/** Whether this session's prompts already carried the full reminder; later ones carry one line. */
const TOLD = atom({ plugin: "overwatch", key: "told" } as const, false)

/** Prompt origins that are the person speaking. */
const PERSON = new Set(["composer", "bridge", "sdk"])

/** Publish the gauge; without followline loaded the call throws and the gauge goes nowhere. */
async function show($: any, s: Plan): Promise<void> {
  try {
    await $.followline.put(slot(s))
  } catch {}
}

/** Runs one guard's check from the session root; a check past CHECK_TIMEOUT_MS counts as not upheld. */
const runCheck = async ($: any, g: Guard, cwd?: string): Promise<Guard> => {
  let exit: number | null = null
  let out = ""
  try {
    const r = await $.process.run(["sh", "-c", g.check!], { cwd, timeoutMs: CHECK_TIMEOUT_MS })
    exit = r.exitCode
    out = (r.stdout + r.stderr).trim().slice(-600)
  } catch (err: any) {
    out = `[check did not finish: ${err?.message ?? err}]`
  }
  return { ...g, met: exit === 0, last: { exit, out } }
}

/** Writes decided guards back onto whatever the plan holds now and redraws the gauge. */
const record = async ($: any, decided: Guard[]): Promise<Plan> => {
  const byId = new Map(decided.map((g) => [g.id, g]))
  const plan = await update($, PLAN, (p) => ({ ...p, guards: p.guards.map((g) => byId.get(g.id) ?? g) }))
  await show($, plan)
  return plan
}

/** guard_check: runs the picked guards' checks now and records the outcome. */
async function guardCheck($: any, e: any): Promise<{ result: string } | { deny: string }> {
  const [s, root] = await Promise.all([read($, PLAN), read($, ROOT)])
  const id = typeof e.guard_id === "string" && e.guard_id ? e.guard_id : undefined
  const pick = s.guards.filter((g) => g.check && (!id || g.id === id))
  if (!pick.length) return { deny: id ? `no guard "${id}" with a check; plan_show lists the guard ids` : "no guard has a check; judged guards are decided at the stop" }
  const decided = await Promise.all(pick.map((g) => runCheck($, g, root || undefined)))
  await record($, decided)
  return { result: decided.map((g) => `${g.id}: ${g.met ? "upheld" : `failing (${ran(g)})${tail(g)}`}`).join("\n") }
}

/** plan_show: the plan in full beside the review state. */
async function planShow($: any): Promise<{ result: string }> {
  const [s, v] = await Promise.all([read($, PLAN), read($, VERIFY)])
  return { result: detail(s, v) }
}

/** Session start for the plan: remember the start directory, draw the gauge. Called from overwatch.ts's one session.start; the catalog declares the tools. */
export async function startTasksitter($: any, e: any): Promise<void> {
  await Promise.all([
    e.cwd && update($, ROOT, (r) => r || e.cwd),
    read($, PLAN).then((s) => show($, s)),
  ])
}

export const register: Register = (on) => {

  on("tool.call", { tool: tool("guard_check") }, async ($, e: any) => guardCheck($, e))
  on("tool.call", { tool: tool("plan_show") }, async ($) => planShow($))
  for (const [name, { run }] of Object.entries(PLAN_TOOLS)) {
    if (!run) continue
    on("tool.call", { tool: tool(name) }, async ($, e: any) => {
      let out!: Result
      const plan = await update($, PLAN, (s) => (out = run(s, e)).state)
      // New work ends a review pass: the next edit marks the change dirty again.
      await Promise.all([show($, plan), out.work && update($, VERIFY, (v) => ({ ...v, review: false, simplify: false }))])
      return out.warn ? { deny: out.text } : { result: out.text }
    })
  }

  // The gate: no file change before the plan has tasks and guards. The first edit
  // marks the change dirty and voids a pass run before it; later edits (fixes the
  // pass asks for) keep the pass. Every edit adds its lines to the change's size,
  // which decides whether /code-review is due. New work through the task tool ends the pass.
  for (const tool of EDIT_TOOLS)
    on("tool.call", { tool }, async ($, e, next) => {
      const why = gateReason(await read($, PLAN))
      if (why) return { deny: why }
      const n = changedLines(e)
      await update($, VERIFY, (v) => (v.dirty ? { ...v, lines: (v.lines || 0) + n } : { ...CLEAN, dirty: true, lines: n }))
      return next(e)
    })

  // /code-review and /simplify, typed or through the Skill tool.
  on("skill.prompt", async ($, e: any, next) => {
    const key = REVIEW_SKILLS.has(e.skill) ? "review" : e.skill === "simplify" ? "simplify" : undefined
    if (key) await update($, VERIFY, (v) => ({ ...v, [key]: true }))
    return next(e)
  })

  // Every prompt carries the plan. Only the person (terminal, Remote Control, SDK)
  // resets the round count; task notifications and peers do not.
  on("prompt.submit", async ($, e: any, next) => {
    const [plan, notice, told, evaluation] = await Promise.all([
      read($, PLAN),
      takeNotice($),
      read($, TOLD),
      takeEvaluation($),
      PERSON.has(e.origin?.kind ?? "composer") && update($, STOPS, (b) => ({ ...FRESH, nokeyTold: b.nokeyTold })),
    ])
    if (!told) await update($, TOLD, () => true)
    // A hot reload that changed overwatch's tools rides the next prompt once (version.ts).
    // The surface ledger's rating question rides once, after the session did real work (tools.ts).
    return next({ ...e, context: [...(e.context ?? []), ...(notice ? [notice] : []), ...(evaluation ? [evaluation] : []), reminder(plan, told)] })
  })

  on("classic.Stop", async ($, e: any, next) => {
    const result = await next(e)
    // Paused, not stopped: background work or a cron wakes the session on its own.
    if (e.background_tasks?.length || e.session_crons?.length) return result
    const [s, book, root, v] = await Promise.all([read($, PLAN), read($, STOPS), read($, ROOT), read($, VERIFY)])
    const cwd = root || e.cwd || undefined
    const open = openGuards(s.guards)
    let nokeyTold = book.nokeyTold

    // Judged guards fail open: without a key or a judge they are left undecided and cannot hold the stop.
    const judge = async (judged: Guard[]): Promise<Guard[]> => {
      if (!judged.length) return []
      const key = await $.env.get("TYPESAFE_API_KEY")
      if (!key) {
        if (!nokeyTold) $.ui.toast("tasksitter: judged guards need TYPESAFE_API_KEY; only guards with a check hold the stop")
        nokeyTold = true
        return []
      }
      try {
        const paths = [...new Set(judged.flatMap((g) => g.files ?? []))]
        const [messages, files] = await Promise.all([
          $.session.messages({ as: "api" }),
          Promise.all(paths.map(async (p) => [p, await $.fs.read(p).then((t) => t.slice(0, 12_000), () => "[no such file]")] as const)),
        ])
        const res = await $.http.fetch(JUDGE_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(judgeBody(lastTurn(messages as Msg[]), judged, Object.fromEntries(files))),
        } as any)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const ps = judgeProbs(JSON.parse(res.text ?? "{}")?.answers, judged)
        return judged.map((g) => ({ ...g, met: ps[g.id]! >= GUARD_MET, last: { p: ps[g.id]! || 0 } }))
      } catch (err: any) {
        $.ui.toast(`tasksitter: judge unavailable (${err?.message ?? err}); judged guards not decided this stop`)
        return []
      }
    }

    const [checked, judged] = await Promise.all([Promise.all(open.filter((g) => g.check).map((g) => runCheck($, g, cwd))), judge(open.filter((g) => !g.check))])
    const decided = [...checked, ...judged]
    // Write back only the decided guards, onto whatever the plan holds now.
    const plan = decided.length ? await record($, decided) : s
    const { verdict, next: nb } = stopVerdict(plan, decided, v, { ...book, nokeyTold })
    await Promise.all([update($, STOPS, () => nb), verdict.kind === "pass" && update($, VERIFY, () => CLEAN)])
    if (verdict.kind === "pass") return result
    if (verdict.kind === "stalled") {
      $.ui.toast("tasksitter: work still open, stopped asking — needs your input")
      return { ...result, additionalContext: [verdict.reason] }
    }
    return { block: verdict.reason }
  })
}
