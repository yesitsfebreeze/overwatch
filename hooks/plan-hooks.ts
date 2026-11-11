import { atom, read, update, type Register } from "claude-code"
import type { Guard, Plan } from "../types/index.d.ts"
import { GUARD_MET, JUDGE_URL, checkScript, judgeBody, judgeProbs, lastTurn, openGuards, type Msg } from "./guards.ts"
import { incident } from "./incidents.ts"
import { CHECK_TIMEOUT_MS, CLEAN, EDIT_TOOLS, EMPTY, FRESH, PLAN_TOOLS, REVIEW_SKILLS, changedLines, checkReport, checked, detail, gateReason, openLine, pickChecks, reminder, slot, stopVerdict, tool, withDecided, type Result } from "./plan.ts"

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
  try {
    const r = await $.process.run(["sh", "-c", checkScript(g.check!)], { cwd, timeoutMs: CHECK_TIMEOUT_MS })
    return checked(g, r.exitCode, r.stdout + r.stderr)
  } catch (err: any) {
    return checked(g, null, `[check did not finish: ${err?.message ?? err}]`)
  }
}

/** Writes decided guards back onto whatever the plan holds now and redraws the gauge. */
const record = async ($: any, decided: Guard[]): Promise<Plan> => {
  const plan = await update($, PLAN, (p) => withDecided(p, decided))
  await show($, plan)
  return plan
}

/** guard_check: runs the picked guards' checks now and records the outcome. */
async function guardCheck($: any, e: any): Promise<{ result: string } | { deny: string }> {
  const [s, root] = await Promise.all([read($, PLAN), read($, ROOT)])
  const pick = pickChecks(s, e.guard_id)
  if (typeof pick === "string") return { deny: pick }
  const decided = await Promise.all(pick.map((g) => runCheck($, g, root || undefined)))
  await record($, decided)
  return { result: checkReport(decided) }
}

/** plan_show: the plan in full beside the review state. */
async function planShow($: any): Promise<{ result: string }> {
  const [s, v] = await Promise.all([read($, PLAN), read($, VERIFY)])
  return { result: detail(s, v) }
}

/**
 * The plan beside a prompt: the full rules once per session, then one line. Only the
 * person (terminal, Remote Control, SDK) resets the stop rounds; task notifications
 * and peers do not. Called from overwatch.ts's one prompt.submit.
 */
export async function planReminder($: any, e: any): Promise<string> {
  const [plan, told] = await Promise.all([
    read($, PLAN),
    read($, TOLD),
    PERSON.has(e.origin?.kind ?? "composer") && update($, STOPS, (b) => ({ ...FRESH, nokeyTold: b.nokeyTold })),
  ])
  if (!told) await update($, TOLD, () => true)
  return reminder(plan, told)
}

/** Session start for the plan: remember the start directory, draw the gauge. Called from overwatch.ts's one session.start; the catalog declares the tools. */
export async function startPlan($: any, e: any): Promise<void> {
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
      if (why) {
        await incident($, "unplanned_edit", String(e.tool))
        return { deny: why }
      }
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
        if (!nokeyTold) $.ui.toast("overwatch: judged guards need TYPESAFE_API_KEY; only guards with a check hold the stop")
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
        $.ui.toast(`overwatch: judge unavailable (${err?.message ?? err}); judged guards not decided this stop`)
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
    await incident($, verdict.kind === "stalled" ? "stalled" : "early_stop", openLine(verdict.reason))
    if (verdict.kind === "stalled") {
      $.ui.toast("overwatch: work still open, stopped asking — needs your input")
      return { ...result, additionalContext: [verdict.reason] }
    }
    return { block: verdict.reason }
  })
}
