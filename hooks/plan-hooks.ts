import { atom, read, update, type Register } from "claude-code"
import type { Guard, Plan } from "../types/index.d.ts"
import { GUARD_MET, JUDGE_URL, judgeFile, judgeRequest, judgeProbs, lastTurn, openGuards, type Msg } from "./guards.ts"
import { incident } from "./incidents.ts"
import { CLEAN, EDIT_TOOLS, EMPTY, FRESH, PLAN_TOOLS, REVIEW_SKILLS, planPage, gateReason, newWork, openLine, reminder, runAutoChecks, runPicked, skillRan, slot, stopBudgetReason, stopVerdict, tool, withDecided, type Result } from "./plan.ts"
import { engineRun, sessionIo } from "./io.ts"
import { VAULT_TOOLS } from "./vault.ts"
import { CHANGELOG_TOOLS } from "./changelog.ts"
import { measured, trackEdit } from "./review.ts"
import { observedRequest, usageOperation } from "./usage.ts"
import { liveResultBudget } from "./paging.ts"

const PLAN = atom({ plugin: "overwatch", key: "plan" } as const, EMPTY)
const VERIFY = atom({ plugin: "overwatch", key: "verify" } as const, CLEAN)
const STOPS = atom({ plugin: "overwatch", key: "stop" } as const, FRESH)
const NO_JUDGMENT = { body: "", probabilities: {} as Record<string, number> }
const JUDGMENT = atom({ plugin: "overwatch", key: "judgment" } as const, NO_JUDGMENT)
/** Where the session started: guard checks run from here, not from wherever a `cd` left the shell. */
const ROOT = atom({ plugin: "overwatch", key: "root" } as const, "")
/** Whether a prompt already carried the full reminder; later ones carry one line. */
const TOLD = atom({ plugin: "overwatch", key: "told" } as const, false)

/** Prompt origins that are the person: terminal, Remote Control, SDK. */
const PERSON = new Set(["composer", "bridge", "sdk"])

/** Publishes the gauge; without followline the call throws and nothing is drawn. */
async function show($: any, s: Plan): Promise<void> {
  try {
    await $.followline.put(slot(s))
  } catch {}
}


/** Writes decided guards onto whatever the plan holds now and redraws the gauge. */
const record = async ($: any, decided: Guard[]): Promise<Plan> => {
  const plan = await update($, PLAN, (p) => withDecided(p, decided))
  await show($, plan)
  return plan
}

async function guardCheck($: any, e: any): Promise<{ result: string } | { deny: string }> {
  const [s, root] = await Promise.all([read($, PLAN), read($, ROOT)])
  const out = await runPicked(s, e.guard_id, e.tier, engineRun($), root || undefined, e.timeout_ms)
  if (typeof out === "string") return { deny: out }
  await record($, out.decided)
  return { result: out.report }
}

async function planShow($: any, e: any, maxChars: number) {
  const [s, v] = await Promise.all([read($, PLAN), read($, VERIFY)])
  try { return { result: planPage(s, v, e, maxChars) } }
  catch (err: any) { return { deny: String(err?.message ?? err) } }
}

/** The plan beside a prompt: the full rules once per session, then one line. Only the person resets the stop rounds; task notifications and peers do not. */
export async function planReminder($: any, e: any): Promise<string> {
  const [plan, told] = await Promise.all([
    read($, PLAN),
    read($, TOLD),
    PERSON.has(e.origin?.kind ?? "composer") && Promise.all([
      update($, STOPS, (b) => ({ ...FRESH, nokeyTold: b.nokeyTold })),
      update($, JUDGMENT, () => NO_JUDGMENT),
    ]),
  ])
  if (!told) await update($, TOLD, () => true)
  return reminder(plan, told)
}

/** Session start: remember the start directory, draw the gauge. */
export async function startPlan($: any, e: any): Promise<void> {
  await Promise.all([
    e.cwd && update($, ROOT, (r) => r || e.cwd),
    read($, PLAN).then((s) => show($, s)),
  ])
}

export const register: Register = (on, options) => {
  on("tool.call", { tool: tool("guard_check") }, async ($, e: any) => guardCheck($, e))
  const pageBudget = Math.min(7800, liveResultBudget(options.liveResultMaxChars) - 16)
  on("tool.call", { tool: tool("plan_show") }, async ($, e: any) => planShow($, e, pageBudget))
  for (const [name, { run, act }] of Object.entries({ ...PLAN_TOOLS, ...VAULT_TOOLS, ...CHANGELOG_TOOLS })) {
    if (!run && !act) continue
    on("tool.call", { tool: tool(name) }, async ($, e: any) => {
      let out!: Result
      // act reads the project first; its plan replaces the one it read. Ceiling: a plan call landing during that read is lost.
      if (act) out = await act(await sessionIo($), await read($, PLAN), e)
      const plan = await update($, PLAN, (s) => (act ? out : (out = run!(s, e))).state)
      await Promise.all([show($, plan), out.work && update($, VERIFY, newWork)])
      return out.warn ? { deny: out.text } : { result: out.text }
    })
  }

  // The gate precedes execution; review counts come from the actual resulting files.
  for (const tool of EDIT_TOOLS)
    on("tool.call", { tool }, async ($, e, next) => {
      const why = gateReason(await read($, PLAN))
      if (why) {
        await incident($, "unplanned_edit", String(e.tool))
        return { deny: why }
      }
      return trackEdit(await sessionIo($), e, () => next(e),
        (before, after, failed) => update($, VERIFY, (v) => measured(v, before, after, failed)))
    })

  // /code-review and /simplify, typed or through the Skill tool.
  on("skill.prompt", async ($, e: any, next) => {
    const key = REVIEW_SKILLS.has(e.skill) ? "review" : e.skill === "simplify" ? "simplify" : undefined
    if (key) await update($, VERIFY, (v) => skillRan(v, key))
    return next(e)
  })

  on("classic.Stop", async ($, e: any, next) => {
    const result = await next(e)
    // Paused, not stopped: background work or a cron wakes the session on its own.
    if (e.background_tasks?.length || e.session_crons?.length) return result
    const [s, book, root, v] = await Promise.all([read($, PLAN), read($, STOPS), read($, ROOT), read($, VERIFY)])
    const exhausted = stopBudgetReason(book)
    if (exhausted) {
      await incident($, "stalled", exhausted)
      return { ...result, additionalContext: [exhausted] }
    }
    const cwd = root || e.cwd || undefined
    const open = s.tasks.some((t) => t.status !== "done") ? [] : openGuards(s.guards)
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
          Promise.all(paths.map(async (p) => [p, await $.fs.read(p).then(judgeFile, () => "[no such file]")] as const)),
        ])
        const request = judgeRequest(lastTurn(messages as Msg[]), judged, Object.fromEntries(files), options.maxJudgeTokens)
        if (request.error) return judged.map((g) => ({ ...g, met: false, last: { error: request.error } }))
        const cached = await read($, JUDGMENT)
        let ps = cached.probabilities
        if (cached.body !== request.body) {
          const operation = await usageOperation($, 'guard')
          ps = await observedRequest($, operation, 1, request.tokens, () => $.http.fetch(JUDGE_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: request.body,
          } as any), (body) => {
            if (!judged.every((g) => typeof (body?.answers?.[g.id]?.noul ?? body?.answers?.[g.id]?.probability) === 'number')) throw new Error('invalid_response')
            const values = judgeProbs(body?.answers, judged)
            if (!Object.values(values).every((p) => Number.isFinite(p) && p >= 0 && p <= 1)) throw new Error('invalid_response')
            return values
          })
          await update($, JUDGMENT, () => ({ body: request.body, probabilities: ps }))
        }
        return judged.map((g) => ({ ...g, met: ps[g.id]! >= GUARD_MET, last: { p: ps[g.id]! || 0 } }))
      } catch (err: any) {
        const reason = ['transport_error', 'http_error', 'invalid_response'].includes(err?.message) ? err.message : 'judgment unavailable'
        $.ui.toast(`overwatch: judge unavailable (${reason}); judged guards not decided this stop`)
        return []
      }
    }

    const [checked, judged] = await Promise.all([runAutoChecks(engineRun($), open, cwd), judge(open.filter((g) => !g.check))])
    const decided = [...checked, ...judged]
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
