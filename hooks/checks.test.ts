import { test, expect } from "claude-code/testing"
import { session } from "./test-session.ts"
import { engineRun, resetShellArgv, type Runner } from "./io.ts"
import { makeGuard } from "./guards.ts"
import { CLEAN, EMPTY, FRESH, PLAN_TOOLS, checkReport, runAutoChecks, runCheck, runChecks, runPicked, stopVerdict, tool, withDecided } from "./plan.ts"
import type { Guard } from "../types/index.d.ts"

const guard: Guard = { id: "probe", question: "Does the probe pass?", check: "guard-probe" }

test("guard budgets default to 60s, accept long checks and reject invalid settings before execution", async () => {
  resetShellArgv()
  const budgets: number[] = []
  const run: Runner = async (argv, init) => {
    if (argv.at(-1) === guard.check) budgets.push(init!.timeoutMs!)
    return { code: 0, stdout: "passed", stderr: "" }
  }
  expect((await runCheck(run, guard)).met).toBe(true)
  expect((await runCheck(run, { ...guard, timeout_ms: 120000 })).met).toBe(true)
  expect(budgets).toEqual([60000, 120000])
  const plan = { ...EMPTY, guards: [guard] }
  for (const timeout_ms of [0, -1, 1.5, NaN, Infinity, "120000", 600001]) {
    expect(typeof makeGuard([], guard.question, guard.check, undefined, undefined, timeout_ms)).toBe("string")
    expect(typeof await runPicked(plan, undefined, undefined, run, undefined, timeout_ms)).toBe("string")
  }
  expect(budgets).toHaveLength(2)
  expect(makeGuard([], guard.question, undefined, undefined, undefined, 120000)).toContain("only applies")
  expect(PLAN_TOOLS.guard_add.properties!.check).toBeDefined()
})

test("checks run at once, and a note check borrows its plan guard's budget", async () => {
  resetShellArgv()
  let running = 0, most = 0
  const budgets: [string, number][] = []
  const run: Runner = async (argv, init) => {
    const check = argv.at(-1)!
    if (!check.startsWith("seq-")) return { code: 0, stdout: "", stderr: "" }
    running++; most = Math.max(most, running)
    budgets.push([check, init!.timeoutMs!])
    await new Promise((r) => setTimeout(r, 5))
    running--
    return { code: 0, stdout: "", stderr: "" }
  }
  const slow: Guard = { id: "slow", question: "Does the slow check pass?", check: "seq-slow", timeout_ms: 600000 }
  await runChecks(run, ["seq-slow", "seq-fast"], undefined, [slow])
  await runAutoChecks(run, [slow, { ...guard, check: "seq-other" }])
  expect(most).toBe(2)
  expect(budgets.slice(0, 2)).toEqual([["seq-slow", 600000], ["seq-fast", 60000]])
})

test("timed-out guards remain unmet without automatic retries; explicit checks update and recover", async () => {
  let calls = 0, timedOut = true
  const budgets: number[] = []
  const run: Runner = async (argv, init) => {
    if (argv.at(-1) !== guard.check) return { code: 0, stdout: "", stderr: "" }
    calls++; budgets.push(init!.timeoutMs!)
    return { code: timedOut ? 124 : 0, stdout: "", stderr: "", timedOut }
  }
  let plan = { ...EMPTY, guards: await runAutoChecks(run, [guard]) }
  expect(plan.guards[0].last).toMatchObject({ exit: null, timedOut: true, timeout_ms: 60000 })
  for (let i = 0; i < 3; i++) {
    const decided = await runAutoChecks(run, plan.guards)
    expect(stopVerdict(plan, decided, CLEAN, FRESH).verdict.kind).toBe("block")
  }
  expect(calls).toBe(1)
  expect(checkReport(plan.guards)).toContain("automatic retries paused")
  timedOut = false
  const result = await runPicked(plan, "probe", undefined, run, undefined, 180000)
  if (typeof result === "string") throw new Error(result)
  plan = withDecided(plan, result.decided)
  expect(plan.guards[0].timeout_ms).toBe(180000)
  expect(plan.guards[0].last?.timedOut).toBeUndefined()
  expect((await runAutoChecks(run, plan.guards))[0].met).toBe(true)
  expect(budgets).toEqual([60000, 180000, 180000])
})

test("transport timeout differs from natural exit 124, which is retried normally", async () => {
  const natural = engineRun({ process: { run: async () => ({ exitCode: 124, stdout: "", stderr: "" }) } })
  const expired = engineRun({ process: { run: async () => { throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) } } })
  expect((await natural(["probe"])).timedOut).toBeUndefined()
  expect((await expired(["probe"])).timedOut).toBe(true)
  let calls = 0
  const runner: Runner = async (argv) => {
    if (argv.at(-1) === guard.check) calls++
    return { code: argv.at(-1) === guard.check ? 124 : 0, stdout: "", stderr: "" }
  }
  const first = await runAutoChecks(runner, [guard])
  expect(first[0].last?.exit).toBe(124)
  expect(checkReport(first)).toContain("exit 124")
  await runAutoChecks(runner, first)
  expect(calls).toBe(2)
})

session("native guard timeout pauses automatic checks and an explicit override recovers", async ($, on) => {
  on("session.cwd", async () => ({ value: "/repo" }) as any)
  on("env.get", async () => ({ value: undefined }) as any)
  on("classic.Stop", async () => ({}) as any)
  let calls = 0, timedOut = true
  on("process.run", async (_: any, e: any) => {
    if ((e.argv ?? e).at(-1) !== "guard-probe") return { value: { exitCode: 0, stdout: "", stderr: "" } } as any
    calls++
    return timedOut ? { deny: "process timed out" } : { value: { exitCode: 0, stdout: "passed", stderr: "" } } as any
  })
  await $.tool.call({ tool: tool("guard_add"), question: guard.question, check: guard.check } as any)
  expect(JSON.stringify(await $.classic.Stop({} as any))).toContain("timed out")
  expect(JSON.stringify(await $.classic.Stop({} as any))).toContain("timed out")
  expect(calls).toBe(1)
  timedOut = false
  expect(JSON.stringify(await $.tool.call({ tool: tool("guard_check"), guard_id: "missing-guard", timeout_ms: 180000 } as any))).toContain("no guard")
  expect(JSON.stringify(await $.tool.call({ tool: tool("guard_check"), timeout_ms: 180000 } as any))).toContain("upheld")
  expect(JSON.stringify(await $.classic.Stop({} as any))).not.toContain('"block"')
  expect(calls).toBe(3)
})
