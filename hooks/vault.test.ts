import { expect, test } from "claude-code/testing"
import type { Plan } from "../types/index.d.ts"
import { memIo, type Runner } from "./io.ts"
import { EMPTY } from "./plan.ts"
import { closeNote, computePlan, frontmatter, parseSpec, patchFrontmatter, planItems, PLAN_DATA, PLAN_TASKS, serialize, tickItems, unitLoad, unitNew, unitRecord, vaultInit } from "./vault.ts"

const V = "/p/.overwatch/vault"
const TEMPLATE = "---\ntitle: {{title}}\ncategory:\nstatus: target\nupdated: {{date}}\n---\n\n# {{title}}\n\n## Summary\n\nOne paragraph.\n\n## Plan\n\n- [ ] placeholder\n\n## Status\n\nNothing yet.\n\n## Open questions\n\n-\n"
const scaffold = () => ({ "/plug/data/vault/00 Meta/Spec Template.md": TEMPLATE, "/plug/data/vault/Home.md": "# Home\n", "/plug/data/vault/.obsidian/community-plugins.json": '["plan-view"]' })
const io = (files: Record<string, string> = {}, run?: Runner) => ({ ...memIo({ ...scaffold(), ...files }, "/p"), root: "/plug", ...(run ? { run } : {}) })
const spec = (name: string, fm: string, plan = "- [ ] do it") => ({ [`${V}/01 Specs/${name}.md`]: `---\nstatus: target\ncategory: behavior\n${fm}---\n\n# ${name}\n\n## Plan\n\n${plan}\n` })

test("frontmatter: lists parse, patch keeps other lines, a comma value is quoted", () => {
  const text = "---\ntitle: A\ndepends: [B, \"C, D\"]\npaths:\n  - x.ts\n  - y.ts\n---\nbody\n"
  expect(frontmatter(text).fields).toEqual({ title: "A", depends: ["B", "C, D"], paths: ["x.ts", "y.ts"] })
  const patched = patchFrontmatter(text, { paths: null, status: "implemented" })
  expect(patched).toBe("---\ntitle: A\ndepends: [B, \"C, D\"]\nstatus: implemented\n---\nbody\n")
  expect(serialize("a, b")).toBe('"a, b"')
})

test("plan: waves follow depends; cycles, missing prerequisites and claims hold; shared paths clash", () => {
  const specs = Object.entries({
    ...spec("A", "paths: [src/a.ts]\n"),
    ...spec("B", "depends: [A]\n"),
    ...spec("C", "depends: [B]\nprio: high\n"),
    ...spec("D", "paths: [src/a.ts]\nowner: x@12345678\n"),
    ...spec("E", "depends: [F]\n"),
    ...spec("F", "depends: [E]\n"),
    ...spec("G", "depends: [Nope]\n"),
    ...spec("H", "proof: abc\n"),
    ...spec("K", "paths: [src/a.ts/lex.ts]\n"),
    ...spec("L", "paths: [SRC/A.TS]\n"),
    ...spec("M", "", "- [x] do it"),
  }).map(([p, t]) => parseSpec(p.slice(V.length + 1), t))
  specs.find((s) => s.name === "H")!.status = "implemented"
  const d = computePlan(specs)
  const row = (n: string) => d.rows.find((r) => r.name === n)!
  expect([row("A").wave, row("B").wave, row("C").wave]).toEqual([1, 2, 3])
  expect([row("B").start, row("C").start]).toEqual([1, 2])
  expect(row("A").held).toBe("")
  expect(row("B").held).toBe("waiting")
  expect(row("D").held).toBe("claimed")
  expect(row("E").held).toBe("cycle")
  expect(row("G").held).toBe("missing Nope")
  expect(row("C").mark).toBe("⏫")
  // A covers K's path and L's differs only in case; D is claimed and M has no open item,
  // so neither can start now and neither clashes.
  expect(d.clashes).toEqual([["A", "K"], ["A", "L"], ["K", "L"]])
  expect(row("D").held).toBe("claimed")
  expect(row("M").held).toBe("no open Plan items")
  expect(d.done.map((x) => x.name)).toEqual(["H"])
  expect(d.progress.ready).toBe(3)
  expect(d.warnings.some((w) => w.includes("cycle"))).toBe(true)
})

test("closeNote: ticks finished items, partial while one stays open, proof and Status written", () => {
  const text = `---\nstatus: target\nowner: x@12345678\n---\n\n## Plan\n\n- [ ] one\n- [ ] two\n\n## Status\n\nold\n`
  const half = closeNote(text, { done: ["one"], commit: "abc", guards: ["t exit 0"], summary: "One works.", limitations: "two left" })
  expect(half.status).toBe("partial")
  expect(planItems(half.text)).toEqual([{ done: true, text: "one" }, { done: false, text: "two" }])
  expect(frontmatter(half.text).fields.proof).toBe("abc guards: t exit 0; limitations: two left")
  expect(frontmatter(half.text).fields.owner).toBeUndefined()
  expect(half.text).toContain("## Status\n\nOne works.\n")
  expect(closeNote(half.text, { done: ["two"], commit: "def", guards: [], summary: "Both.", limitations: "none" }).status).toBe("implemented")
})

test("vaultInit copies the scaffold, never overwrites, and writes the plan", async () => {
  const x = io({ [`${V}/Home.md`]: "mine\n" })
  const out = await vaultInit(x)
  expect(out).toContain("00 Meta/Spec Template.md")
  expect(x.files[`${V}/Home.md`]).toBe("mine\n")
  expect(x.files[`${V}/.obsidian/community-plugins.json`]).toBe('["plan-view"]')
  expect(JSON.parse(x.files[`${V}/${PLAN_DATA}`]).source.files.map((f: any) => f.path)).toEqual(["00 Meta/Spec Template.md", "Home.md"])
  expect(await vaultInit(x)).toContain("nothing added")
})

test("round trip: unit_new, unit_load turns Plan items into tasks and checks into guards, unit_record writes proof back", async () => {
  let dirty = " M src/a.ts\n"
  const ran: string[] = []
  const run: Runner = async (argv) => {
    ran.push(argv.join(" "))
    if (argv[0] === "git" && argv[1] === "rev-parse") return { code: 0, stdout: "0123456789abcdef\n", stderr: "" }
    if (argv[0] === "git" && argv[1] === "status") return { code: 0, stdout: dirty, stderr: "" }
    return { code: 0, stdout: "ok", stderr: "" } // the guard check's shell
  }
  const x = io({}, run)
  expect(await unitNew(x, { title: "Parser", category: "behavior", summary: "Parse things.", tasks: ["lex tokens", "build tree"], checks: ["bun test parser"] })).toContain("wave 1")
  await expect(unitNew(x, { title: "Parser", category: "behavior", tasks: ["x"] })).rejects.toThrow("exists")
  await expect(unitNew(x, { title: "Bad/Name", category: "behavior", tasks: ["x"] })).rejects.toThrow("note name")
  await expect(unitNew(x, { title: "_Hidden", category: "behavior", tasks: ["x"] })).rejects.toThrow("note name")
  const note = () => x.files[`${V}/01 Specs/Parser.md`]
  expect(planItems(note()).map((i) => i.text)).toEqual(["lex tokens", "build tree"])

  const loaded = await unitLoad(x, { ...EMPTY, nextId: 4 }, { unit: "parser" })
  expect(loaded.warn).toBeUndefined()
  let s: Plan = loaded.state
  expect(s.tasks.map((t) => [t.id, t.title])).toEqual([[4, "lex tokens"], [5, "build tree"]])
  expect(s.guards.map((g) => g.check)).toEqual(["bun test parser"])
  expect(s.unit).toEqual({ name: "Parser", tasks: { 4: "lex tokens", 5: "build tree" }, guards: [s.guards[0].id], checks: ["bun test parser"] })
  expect((await unitLoad(x, s, { unit: "Parser" })).warn).toBe(true) // nothing new

  const close = { summary: "Parses tokens into a tree.", limitations: "none" }
  expect((await unitRecord(x, s, close)).text).toContain("still open: #4, #5")
  s = { ...s, tasks: s.tasks.map((t) => ({ ...t, status: "done" as const, progress: 100 })) }
  expect((await unitRecord(x, s, close)).text).toContain("uncommitted: src/a.ts")
  dirty = ""
  expect(ran.some((c) => c.endsWith("-- . :(exclude,literal).overwatch"))).toBe(true) // git, not a prefix test, leaves out the state dir
  const rec = await unitRecord(x, s, close)
  expect(rec.warn).toBeUndefined()
  expect(rec.text).toContain("as implemented at 0123456789ab")
  expect(rec.state.unit).toBeUndefined()
  expect(rec.state.guards[0].met).toBe(true)
  expect(ran.some((c) => c.includes("bun test parser"))).toBe(true)
  const fields = frontmatter(note()).fields
  expect(fields.status).toBe("implemented")
  expect(String(fields.proof)).toMatch(/^0123456789abcdef guards: .+ exit 0; limitations: none$/)
  expect(planItems(note()).every((i) => i.done)).toBe(true)
  expect(note()).toContain("## Status\n\nParses tokens into a tree.\n")
  expect(JSON.parse(x.files[`${V}/${PLAN_DATA}`]).done[0]).toMatchObject({ name: "Parser", proven: true })
  expect(x.files[`${V}/${PLAN_TASKS}`]).toContain("- [x] [[Parser]]")
})

test("unit_load refuses a held unit and a second unit while one is loaded", async () => {
  const x = io({ ...spec("A", ""), ...spec("B", "depends: [A]\n") })
  expect((await unitLoad(x, EMPTY, { unit: "B" })).text).toContain("held: waiting")
  const a = await unitLoad(x, EMPTY, { unit: "A" })
  expect(a.text).toContain("no `checks`")
  expect((await unitLoad(x, { ...a.state, unit: { name: "Other", tasks: {}, guards: [] } }, { unit: "A" })).text).toContain('unit "Other" is loaded')
  expect((await unitLoad(x, EMPTY, { unit: "Z" })).text).toContain("no unit \"Z\"")
})

test("review fixes: wiki-link lists, claims wait on prerequisites, a shared check is re-run, a removed task does not hold the unit", async () => {
  expect(parseSpec("01 Specs/X.md", "---\ndepends: [[A]], [[B]]\n---\n").depends).toEqual(["A", "B"])
  expect(parseSpec("01 Specs/X.md", "---\ndepends: [[[C]], \"[[D]]\"]\n---\n").depends).toEqual(["C", "D"])
  const d = computePlan([spec("A", ""), spec("B", "depends: [A]\nowner: x@1\n")].flatMap((o) => Object.entries(o)).map(([p, t]) => parseSpec(p.slice(V.length + 1), t)))
  expect(d.rows.find((r) => r.name === "B")!.held).toBe("waiting")
  const files = { ...spec("A", "checks: [bun test]\n", "- [ ] one\n- [ ] two"), ...spec("C", "owner: x@1\n") }
  const ran: string[] = []
  const run: Runner = async (argv) => {
    ran.push(argv.join(" "))
    return { code: 0, stdout: argv[0] === "git" ? (argv[1] === "rev-parse" ? "abc\n" : "") : "ok", stderr: "" }
  }
  const x = io(files, run)
  expect((await unitLoad(x, EMPTY, { unit: "C" })).text).toContain("held: claimed by x@1")
  const mine: Plan = { ...EMPTY, guards: [{ id: "g", question: "q", check: "bun test" } as Plan["guards"][number]] }
  const s = (await unitLoad(x, mine, { unit: "A" })).state
  expect(s.guards.length).toBe(1)
  expect(s.unit!.guards).toEqual(["g"])
  const left: Plan = { ...s, tasks: [{ ...s.tasks[0], status: "done" }] } // the second task was removed
  const rec = await unitRecord(x, left, { summary: "One works.", limitations: "two dropped" })
  expect(rec.text).toContain("as partial")
  expect(ran.some((c) => c.includes("bun test"))).toBe(true)
})

test("unit_record re-runs the unit's checks even after its guards left the plan", async () => {
  const run: Runner = async (argv) => {
    if (argv[0] === "git" && argv[1] === "rev-parse") return { code: 0, stdout: "/p\n", stderr: "" }
    if (argv[0] === "git" && argv[1] === "status") return { code: 0, stdout: "", stderr: "" }
    return { code: 1, stdout: "", stderr: "boom" }
  }
  const x = io({ ...spec("A", "checks: [bun test]\n") }, run)
  const s = (await unitLoad(x, EMPTY, { unit: "A" })).state
  const done = { ...s, guards: [], tasks: s.tasks.map((t) => ({ ...t, status: "done" as const, progress: 100 })) }
  const rec = await unitRecord(x, done, { summary: "s", limitations: "none" })
  expect(rec.warn).toBe(true)
  expect(rec.text).toContain("unit checks failing")
})

test("the plan holds a unit whose open Plan items repeat, so nothing points at an unloadable unit", () => {
  const d = computePlan([parseSpec("01 Specs/D.md", "---\nstatus: target\n---\n\n## Plan\n\n- [ ] same\n- [ ] same\n")])
  expect(d.rows[0].held).toContain("repeats the Plan item")
})

test("the state folder exclusion keeps the folder's real case", async () => {
  const ran: string[] = []
  const run: Runner = async (argv) => {
    ran.push(argv.join(" "))
    if (argv[0] === "git" && argv[1] === "rev-parse" && argv.includes("--show-toplevel")) return { code: 0, stdout: "/Repo\n", stderr: "" }
    if (argv[0] === "git" && argv[1] === "rev-parse") return { code: 0, stdout: "abc\n", stderr: "" }
    if (argv[0] === "git" && argv[1] === "status") return { code: 0, stdout: "", stderr: "" }
    return { code: 0, stdout: "ok", stderr: "" }
  }
  const note = "---\nstatus: target\ncategory: behavior\n---\n\n# A\n\n## Plan\n\n- [ ] do it\n"
  const x = { ...memIo({ ...scaffold(), ["/Repo/Sub/.overwatch/vault/01 Specs/A.md"]: note }, "/Repo/Sub"), root: "/Repo", run }
  const s = (await unitLoad(x, EMPTY, { unit: "A" })).state
  await unitRecord(x, { ...s, tasks: s.tasks.map((t) => ({ ...t, status: "done" as const, progress: 100 })) }, { summary: "s", limitations: "none" })
  expect(ran.find((c) => c.includes("git status"))).toContain(":(exclude,literal)Sub/.overwatch")
})

test("Plan items match by trimmed text, and a repeated item is refused", async () => {
  const text = "---\nstatus: target\n---\n\n## Plan\n\n- [ ]  run tests\n"
  expect(planItems(text).map((i) => i.text)).toEqual(["run tests"])
  expect(planItems(tickItems(text, new Set(["run tests"])))[0].done).toBe(true)
  const x = io({ ...spec("R", "", "- [ ] same\n- [ ] same") })
  expect((await unitLoad(x, EMPTY, { unit: "R" })).text).toContain("repeats the Plan item")
})
