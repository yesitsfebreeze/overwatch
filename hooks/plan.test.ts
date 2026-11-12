import { test, expect } from "claude-code/testing"
import { CLEAN, EMPTY, FRESH, LARGE_CHANGE_LINES, MAX_STALLS, SMALL_CHANGE_LINES, PLAN_TOOLS, changedLines, detail, gateReason, edited, newWork, reminder, reviewLine, slot, stopVerdict, tool } from "./plan.ts"
import { fitResults, guardId, lastTurn, makeGuard, openGuards, selectResults } from "./guards.ts"
import type { Guard, Plan } from "../types/index.d.ts"

const P = (tasks: Plan["tasks"], guards: Guard[] = []): Plan => ({ tasks, nextId: tasks.length + 1, guards })
const OPEN = { id: 1, title: "fix the parser", progress: 45, status: "active" } as const
const DONE = { id: 1, title: "fix the parser", progress: 100, status: "done" } as const
/** One plan tool's pure change, as its tool.call would apply it. */
const run = (name: string, s: Plan, e: object) => PLAN_TOOLS[name]!.run!(s, e)
const G = (id: string, extra: Partial<Guard> = {}): Guard => ({ id, question: `Does ${id} hold after the change?`, ...extra })

// ── tasks ────────────────────────────────────────────────────────────
test("tasks: add, progress to done, replace retires the id, remove, clear", () => {
  let s = P([])
  for (let i = 1; i <= 7; i++) s = run("task_add", s, { titles: [`t${i}`] }).state
  expect(s.tasks.length).toBe(7)
  expect(run("task_add", s, { titles: [" "] }).warn).toBe(true)
  s = run("task_progress", P([{ ...OPEN, progress: 0, status: "todo" }]), { task_id: 1, progress: 50 }).state
  expect(s.tasks[0]).toMatchObject({ progress: 50, status: "active" })
  s = run("task_progress", s, { task_id: 1, progress: 100 }).state
  expect(s.tasks[0]?.status).toBe("done")
  s = run("task_replace", s, { task_id: 1, title: "renamed" }).state
  expect(s.tasks.map((t) => [t.id, t.title])).toEqual([[2, "renamed"]])
  expect(run("task_remove", s, { task_id: 9 }).warn).toBe(true)
  expect(run("plan_clear", s, {}).state).toMatchObject({ tasks: [], guards: [] })
})

// ── guards ───────────────────────────────────────────────────────────
test("guards: ids from telling words, taste words refused unless a check decides, drop by id", () => {
  expect(guardId("Does the README list every plugin?")).toBe("readme-list-plugin")
  expect(guardId("Does the README list every plugin?", ["readme-list-plugin"])).toBe("readme-list-plugin-2")
  expect(makeGuard([], "short?")).toContain("at least 15")
  expect(makeGuard([], "Is the parser code clean and readable?")).toContain("taste words")
  expect(makeGuard([], "Is the parser code clean and readable?", "bun test")).toMatchObject({ check: "bun test" })
  let s = run("guard_add", P([]), { question: "Do the tests pass with bun test?", check: "bun test" }).state
  expect(s.guards.map((g) => g.id)).toEqual(["tests-pass-bun"])
  expect(run("guard_drop", s, { guard_id: "nope" }).warn).toBe(true)
  s = run("guard_drop", s, { guard_id: "tests-pass-bun" }).state
  expect(s.guards).toEqual([])
  // A judged guard retires once upheld; a check guard runs at every stop.
  expect(openGuards([G("a", { check: "true", met: true }), G("b", { met: true }), G("c")]).map((g) => g.id)).toEqual(["a", "c"])
})

test("guard: a no-op check that cannot fail is refused", () => {
  const q = "Do the parser tests pass?"
  const never = ["true", ":", "exit", "exit 0", "true;", "echo done", "printf ok", "bun test || true", "bun test; exit 0", "bun test ;  true",
    "bun test || echo failed", "bun test; echo done", "bun test || true;", "bun test || true # flaky", "(bun test || true)",
    "bun test || true\n# flaky", "bun test || true # it's flaky", "bun test || echo 'a|b'", "(bun test) || (true)", "bun test; echo \"exit 1 means fail\"",
    "bun test 2>&1 | tail -20", "bun test | head -5", "bun test |& tee log.txt", "bun test | cat", "bun test | true", "bun test | echo x"]
  for (const c of never) expect([c, makeGuard([], q, c)]).toEqual([c, expect.stringContaining("check cannot fail")])
  const can = ["bun test", "test -f out.txt", "echo x | grep -q x", "grep -q true config.json", "true && bun test", "echo running tests\nbun test",
    "set -e; bun test; true", "test -f out.txt || exit 1; exit 0", "echo-server --selftest", "bun test | grep -q '0 fail'", "bun test || tail -5 log.txt",
    "set -o errexit; bun test; true", "grep -q '#' notes.md"]
  for (const c of can) expect(makeGuard([], q, c)).toMatchObject({ check: c })
})

test("lastTurn: from the last human message, tool calls numbered, results paired", () => {
  const t = lastTurn([
    { role: "user", content: "old request" },
    { role: "user", content: [{ type: "text", text: "add retries" }] },
    { role: "assistant", content: [{ type: "text", text: "on it" }, { type: "tool_use", id: "a", name: "Bash", input: { command: "bun test" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "3 pass" }] },
    { role: "assistant", content: [{ type: "text", text: "done, tests pass" }] },
  ])
  expect(t.user_request).toBe("add retries")
  expect(t.actions_taken).toEqual(["#1 Bash: bun test"])
  expect(t.command_results).toEqual(["#1 → 3 pass"])
  expect(t.assistant_final_message).toBe("done, tests pass")
})

test("results: failures kept over a blind tail, long output cut to evidence", () => {
  const rs = ["early failure: exit code 1", ...Array.from({ length: 20 }, (_, i) => `ok ${i}`)]
  expect(selectResults(rs, 4)[0]).toBe("early failure: exit code 1")
  const long = `head\n${"noise\n".repeat(2000)}3 tests passed\n${"noise\n".repeat(2000)}tail`
  const [cut] = fitResults([long], 1000)
  expect(cut!.length).toBeLessThan(long.length)
  expect(cut).toContain("3 tests passed")
})

// ── the stop ─────────────────────────────────────────────────────────
const met = (g: Guard, ok: boolean): Guard => ({ ...g, met: ok, last: { exit: ok ? 0 : 1, out: ok ? "" : "1 fail" } })
const reasonOf = (r: ReturnType<typeof stopVerdict>) => (r.verdict as any).reason as string

test("stopVerdict: open tasks and failing guards refuse the stop, named in the reason", () => {
  const g = G("tests", { check: "bun test" })
  const r = stopVerdict(P([OPEN], [g]), [met(g, false)], CLEAN, FRESH)
  expect(r.verdict.kind).toBe("block")
  const reason = reasonOf(r)
  expect(reason).toContain('task #1 "fix the parser" (45%)')
  expect(reason).toContain("guard tests (check `bun test` exit 1)")
  expect(reason).toContain("1 fail")
  expect(stopVerdict(P([DONE], [g]), [met(g, true)], CLEAN, FRESH).verdict.kind).toBe("pass")
})

test("verify: a large change is refused until code-review and simplify both ran", () => {
  const g = G("tests", { check: "bun test" })
  const plan = P([DONE], [g])
  const dirty = edited(CLEAN, LARGE_CHANGE_LINES)
  const none = reasonOf(stopVerdict(plan, [met(g, true)], dirty, FRESH))
  expect(none).toContain("run /code-review, then run /simplify")
  const half = reasonOf(stopVerdict(plan, [met(g, true)], { ...dirty, review: true }, FRESH))
  expect(half).toContain("run /simplify")
  expect(half).not.toContain("run /code-review")
  expect(stopVerdict(plan, [met(g, true)], { ...dirty, review: true, simplify: true }, FRESH).verdict.kind).toBe("pass")
  // Not asked while tasks are open: the review pass is for finished work.
  const early = reasonOf(stopVerdict(P([OPEN], [g]), [met(g, true)], dirty, FRESH))
  expect(early).not.toContain("run /simplify")
  // No edits, nothing to review.
  expect(stopVerdict(plan, [met(g, true)], CLEAN, FRESH).verdict.kind).toBe("pass")
})

test("stopVerdict: unchanged refusals stall to the cap, progress resets it", () => {
  let book = FRESH
  const plan = P([OPEN])
  for (let i = 0; i < MAX_STALLS; i++) {
    const r = stopVerdict(plan, [], CLEAN, book)
    expect(r.verdict.kind).toBe("block")
    book = r.next
  }
  expect(stopVerdict(plan, [], CLEAN, book).verdict.kind).toBe("stalled")
  const moved = stopVerdict(P([{ ...OPEN, progress: 60 }]), [], CLEAN, book)
  expect(moved.verdict.kind).toBe("block")
  expect(moved.next.stalls).toBe(0)
})

test("verify: a mid-size change needs only simplify", () => {
  const g = G("tests", { check: "bun test" })
  const plan = P([DONE], [g])
  const mid = edited(CLEAN, LARGE_CHANGE_LINES - 1)
  const r = reasonOf(stopVerdict(plan, [met(g, true)], mid, FRESH))
  expect(r).toContain("run /simplify")
  expect(r).not.toContain("run /code-review")
  expect(stopVerdict(plan, [met(g, true)], { ...mid, simplify: true }, FRESH).verdict.kind).toBe("pass")
  expect(reasonOf(stopVerdict(plan, [met(g, true)], edited(CLEAN, SMALL_CHANGE_LINES), FRESH))).toContain("run /simplify")
})

test("verify: a small change needs no review pass", () => {
  const g = G("tests", { check: "bun test" })
  const small = edited(CLEAN, SMALL_CHANGE_LINES - 1)
  expect(stopVerdict(P([DONE], [g]), [met(g, true)], small, FRESH).verdict.kind).toBe("pass")
  expect(reviewLine(small)).toContain("no review pass needed")
  // Still held by open tasks and unmet guards.
  expect(stopVerdict(P([OPEN], [g]), [met(g, true)], small, FRESH).verdict.kind).toBe("block")
})

test("changedLines: replaced or new text, summed over edits and items", () => {
  expect(changedLines({ old_string: "a\nb\nc", new_string: "x\n" })).toBe(3)
  expect(changedLines({ old_string: "a\nb", new_string: "x" })).toBe(2)
  expect(changedLines({ edits: [{ old_string: "a", new_string: "b\nc" }, { oldText: "q", newText: "r" }] })).toBe(3)
  expect(changedLines({ items: [{ path: "f", old: "a", new: "b\nc\nd" }, { path: "g", edits: [{ old: "x", new: "y" }] }] })).toBe(4)
  expect(changedLines({})).toBe(0)
})

test("changedLines: an unmeasurable call is never a small change", () => {
  // A whole-file write (Write, git-fs write) hides the replaced text; replace_all hides how often it hits.
  for (const i of [{ content: "a" }, { path: "f", text: "a\nb" }, { items: [{ path: "f", text: "x" }] }, { old_string: "a", new_string: "b", replace_all: true }])
    expect(changedLines(i)).toBeGreaterThanOrEqual(SMALL_CHANGE_LINES)
  expect(changedLines({ content: "x\n".repeat(400) })).toBe(400)
  // A notebook cell replace or delete hides the old cell; an insert shows everything it adds.
  expect(changedLines({ notebook_path: "n.ipynb", edit_mode: "replace", new_source: "x = 1" })).toBe(SMALL_CHANGE_LINES)
  expect(changedLines({ notebook_path: "n.ipynb", edit_mode: "delete" })).toBe(SMALL_CHANGE_LINES)
  expect(changedLines({ notebook_path: "n.ipynb", edit_mode: "insert", new_source: "x = 1" })).toBe(1)
  // The floor is per call: five one-line new files are one small change, not five.
  expect(changedLines({ items: Array.from({ length: 5 }, (_, k) => ({ path: `f${k}`, text: "x" })) })).toBe(SMALL_CHANGE_LINES)
})

// ── the flat tools ───────────────────────────────────────────────────
test("tools: one flat tool per change, no action switch, every schema names its required fields", () => {
  const names = Object.keys(PLAN_TOOLS)
  expect(names).toEqual(["task_add", "task_progress", "task_start", "task_complete", "task_replace", "task_remove", "guard_add", "guard_drop", "guard_check", "plan_show", "plan_clear"])
  for (const [name, t] of Object.entries(PLAN_TOOLS)) {
    expect(Object.keys(t.properties ?? {})).not.toContain("action")
    for (const r of t.required ?? []) expect(Object.keys(t.properties ?? {})).toContain(r)
    expect(t.description.length).toBeGreaterThan(40)
    // Each tool owns its logic: a pure change to the plan, except the two named handlers.
    expect(!!t.run).toBe(!["guard_check", "plan_show"].includes(name))
  }
})

test("tools: task_add takes every title or none; by-id tools refuse an unknown number", () => {
  const s = run("task_add", P([]), { titles: ["split the parser", "update the README"] })
  expect(s.state.tasks.map((t) => t.title)).toEqual(["split the parser", "update the README"])
  expect(s.work).toBe(true)
  expect(run("task_add", P([]), { titles: ["ok", " "] })).toMatchObject({ warn: true, state: { tasks: [] } })
  expect(run("task_complete", s.state, { task_id: 2 }).state.tasks[1]?.status).toBe("done")
  expect(run("task_progress", s.state, { task_id: 9, progress: 5 }).text).toContain("plan_show lists the task numbers")
})

test("verify: new work counts lines only since each skill last ran", () => {
  const big = edited(CLEAN, 3 * LARGE_CHANGE_LINES)
  expect(newWork({ ...big, review: true, simplify: true })).toEqual({ ...CLEAN, dirty: true })
  // A skill that did not run keeps its count: those lines never went through it.
  expect(newWork({ ...big, review: true })).toEqual({ ...CLEAN, dirty: true, lines: big.lines })
  expect(newWork({ ...big, simplify: true })).toEqual({ ...CLEAN, dirty: true, unreviewed: big.lines })
  expect(newWork(big)).toEqual(big)
  // The fix for a /code-review finding, added as a task: /code-review is not asked for again, /simplify still is.
  const g = G("tests", { check: "bun test" })
  const fix = edited(newWork({ ...big, review: true }), 3)
  expect(fix).toMatchObject({ lines: big.lines + 3, unreviewed: 3 })
  const r = reasonOf(stopVerdict(P([DONE], [g]), [met(g, true)], fix, FRESH))
  expect(r).toContain("run /simplify")
  expect(r).not.toContain("run /code-review")
  // After /simplify too, a small fix needs no pass at all; a large one is reviewed again.
  const after = newWork({ ...fix, simplify: true })
  expect(stopVerdict(P([DONE], [g]), [met(g, true)], edited(after, 3), FRESH).verdict.kind).toBe("pass")
  expect(reasonOf(stopVerdict(P([DONE], [g]), [met(g, true)], edited(after, LARGE_CHANGE_LINES), FRESH))).toContain("run /code-review, then run /simplify")
  // The first edit after a passed stop voids a pass run before it.
  expect(edited({ ...CLEAN, review: true, simplify: true }, 2)).toEqual({ ...CLEAN, dirty: true, lines: 2, unreviewed: 2 })
})

test("plan_show: tasks, guard questions and the review state", () => {
  const text = detail(P([OPEN], [G("tests", { check: "bun test", met: true })]), edited(CLEAN, SMALL_CHANGE_LINES))
  expect(text).toContain("#1 45% active: fix the parser")
  expect(text).toContain("guard tests [upheld] check `bun test`: Does tests hold after the change?")
  expect(text).toContain("due once tasks and guards are clear: /simplify")
  expect(reviewLine(CLEAN)).toContain("no file changes")
  expect(reviewLine({ ...edited(CLEAN, LARGE_CHANGE_LINES), review: true, simplify: true })).toContain("review pass done")
  expect(detail(EMPTY, CLEAN)).toContain("No tasks, no guards.")
})

// ── view and reminder ────────────────────────────────────────────────
test("review fixes: progress needs a number, stalls ignore output noise, harness text is not the request", () => {
  const s = P([{ ...OPEN }])
  expect(run("task_progress", s, { task_id: 1 })).toMatchObject({ warn: true, state: s })
  const fail = (out: string): Guard[] => [G("tests-pass", { check: "bun test", met: false, last: { exit: 1, out } })]
  let book = FRESH
  for (let i = 0; i < MAX_STALLS; i++) book = stopVerdict(P([]), fail(`took ${i}.${i}ms`), CLEAN, book).next
  expect(book.stalls).toBe(MAX_STALLS - 1)
  const turn = lastTurn([
    { role: "user", content: [{ type: "text", text: "add a README" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "a", name: "Write", input: { file_path: "README.md" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] },
    { role: "user", content: [{ type: "text", text: "Stop hook feedback:\noverwatch: not done" }] },
  ] as any)
  expect(turn.user_request).toBe("add a README")
})

test("slot: one followline gauge, red while a guard fails, green when all holds", () => {
  expect(slot(EMPTY)).toMatchObject({ id: "plan", pct: 0, detail: "no plan" })
  const failing = slot(P([OPEN], [G("tests", { met: true }), G("docs", { last: { exit: 1 } })]))
  expect(failing).toMatchObject({ pct: 45, color: "red", detail: "0/1 done · guards 1/2 · ▶ #1 fix the parser" })
  expect(slot(P([DONE], [G("tests", { met: true })]))).toMatchObject({ pct: 100, color: "green" })
  expect(slot(P([OPEN], [G("tests")])).color).toBeUndefined()
})

test("reminder and gate: both ask for tasks and guards", () => {
  expect(reminder(EMPTY)).toContain("you MUST first")
  expect(reminder(EMPTY)).toContain("mcp__overwatch__task_add")
  expect(reminder(EMPTY)).toContain("mcp__overwatch__guard_add")
  expect(gateReason(EMPTY)).toContain("mcp__overwatch__task_add")
  expect(reminder(EMPTY)).toContain(`/code-review when the change is large (${LARGE_CHANGE_LINES}+`)
  expect(gateReason(EMPTY)).toContain("no tasks and no guards")
  expect(gateReason(P([OPEN]))).toContain("no guards")
  expect(gateReason(P([OPEN], [G("x")]))).toBeUndefined()
})

test("reminder once: the full rules, then one line", () => {
  const short = reminder(EMPTY, true)
  expect(short).not.toContain("you MUST first")
  expect(short).toContain("mcp__overwatch__task_add")
  expect(short.length).toBeLessThan(200)
  expect(reminder(P([OPEN]), true)).not.toContain("Every stop is refused")
  // A later request still hears it needs its own tasks and guards.
  expect(reminder(P([DONE]), true)).toContain("Add tasks and guards for new work")
  expect(reminder(P([OPEN]))).toContain("Every stop is refused")
})

test("session: reminder once per session, then the short line", async ($, on) => {
  on("prompt.submit", async (_: any, e: any) => ({ ...e }))
  const ctx = async () => JSON.stringify(await $.prompt.submit({ text: "hi" } as any))
  expect(await ctx()).toContain("you MUST first")
  const second = await ctx()
  expect(second).not.toContain("you MUST first")
  expect(second).toContain("rules given earlier this session")
})

test("session: a git repo that does not ignore .overwatch/ is asked to, once; an ignored one never", async ($, on) => {
  let code = 1 // git check-ignore: 1 = not ignored
  on("prompt.submit", async (_: any, e: any) => ({ ...e }))
  on("session.cwd", async () => ({ value: "/repo" }) as any)
  on("process.run", async (_: any, e: any) => ({ value: { exitCode: (e.argv ?? e)[1] === "check-ignore" ? code : 0, stdout: "", stderr: "" } }) as any)
  const ctx = async () => JSON.stringify(await $.prompt.submit({ text: "hi" } as any))
  expect(await ctx()).toContain(">> .gitignore")
  expect(await ctx()).not.toContain(">> .gitignore")
})

// ── end to end ───────────────────────────────────────────────────────
test("session: gate, plan, large edit, stop refused until checks pass and code-review + simplify ran", async ($, on) => {
  on("prompt.submit", async (_: any, e: any) => ({ ...e }))
  on("skill.prompt", async (_: any, e: any) => ({ text: e.text }))
  on("env.get", async () => ({ value: undefined }) as any)
  let exitCode = 1
  on("process.run", async () => ({ value: { exitCode, stdout: exitCode ? "1 fail" : "1 pass", stderr: "" } }) as any)
  on("classic.Stop", async () => ({}) as any)
  // overwatch's own followline stores each gauge in its slots: record the writes
  const slots: any[] = []
  on("state.set" as any, async (_: any, e: any, next: any) => (e?.key === "slots" && slots.push(e.value), next(e)))
  on("tool.call", async () => ({ result: "written" }) as any)

  const denied = (await $.tool.call({ tool: "Write", file_path: "/tmp/x", content: "x" } as any)) as any
  expect(JSON.stringify(denied)).toContain("no tasks and no guards")
  await $.tool.call({ tool: tool("task_add"), titles: ["the work"] } as any)
  await $.tool.call({ tool: tool("guard_add"), question: "Do the tests pass with bun test?", check: "bun test" } as any)
  expect(JSON.stringify(await $.prompt.submit({ text: "go on" } as any))).toContain("1 guard(s): tests-pass-bun")
  expect(JSON.stringify(await $.tool.call({ tool: "Write", file_path: "/tmp/x", content: "x\n".repeat(LARGE_CHANGE_LINES) } as any))).toContain("written")

  const stop = async () => JSON.stringify(await $.classic.Stop({ stop_hook_active: false, last_assistant_message: "x" } as any))
  let r = await stop()
  expect(r).toContain('task #1 \\"the work\\"')
  expect(r).toContain("exit 1")
  expect(slots.at(-1)?.plan).toMatchObject({ id: "plan", color: "red" })
  // guard_check runs the checks now, before any stop.
  expect(JSON.stringify(await $.tool.call({ tool: tool("guard_check") } as any))).toContain("tests-pass-bun: failing (exit 1)")
  await $.tool.call({ tool: tool("task_complete"), task_id: 1 } as any)
  exitCode = 0
  expect(JSON.stringify(await $.tool.call({ tool: tool("guard_check"), guard_id: "tests-pass-bun" } as any))).toContain("tests-pass-bun: upheld")
  expect(JSON.stringify(await $.tool.call({ tool: tool("plan_show") } as any))).toContain("due once tasks and guards are clear: /code-review, then /simplify")
  r = await stop()
  expect(r).toContain("run /code-review, then run /simplify")
  await $.skill.prompt({ skill: "code-review", text: "review" } as any)
  expect(await stop()).toContain("run /simplify")
  await $.skill.prompt({ skill: "simplify", text: "simplify" } as any)
  expect(await stop()).not.toContain("block")
})

test("review fixes 2: string ids resolve, a done task can't be restarted, empty task_add is refused", () => {
  const one = run("task_add", EMPTY, { titles: ["a"] }).state
  expect(run("task_complete", one, { task_id: "1" }).warn).toBeFalsy()
  const start = run("task_start", run("task_complete", one, { task_id: 1 }).state, { task_id: 1 })
  expect(start.warn).toBe(true)
  expect(start.work).toBeFalsy()
  expect(run("task_add", EMPTY, { titles: [] }).warn).toBe(true)
})
