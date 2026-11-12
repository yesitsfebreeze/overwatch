import { expect, test } from "claude-code/testing"
import { memIo, type Runner } from "./io.ts"
import { contractDigest, GATE_ROUNDS, parsePrd, prdAdd, prdBrief, prdCollect, prdNext, prdRefine, prdReview, prdScan, prdSet } from "./prd.ts"

const V = "/p/.overwatch/vault"
const SPEC_TEMPLATE = "---\ntitle: {{title}}\ncategory:\nstatus: target\nupdated: {{date}}\n---\n\n# {{title}}\n\n## Summary\n\nOne.\n\n## Plan\n\n- [ ] placeholder\n\n## Status\n\nNothing yet.\n"
const PRD_TEMPLATE = "---\ntitle: {{title}}\nstatus: open\npriority: 50\nparent:\nneeds: []\nfootprint: []\nchecks: []\ncreated: {{date}}\n---\n\n# {{title}}\n\n## Summary\n\nOne.\n\n## Acceptance\n\n- [ ] placeholder\n\n## Specs\n\n## Review\n\n## Status\n\nNothing yet.\n"
const scaffold = () => ({
  "/plug/data/vault/00 Meta/Spec Template.md": SPEC_TEMPLATE,
  "/plug/data/vault/00 Meta/PRD Template.md": PRD_TEMPLATE,
  "/plug/data/vault/Home.md": "# Home\n",
})
const io = (files: Record<string, string> = {}, run?: Runner) => ({ ...memIo({ ...scaffold(), ...files }, "/p", run), root: "/plug" })

const prd = (name: string, fm: string, body = "") => ({
  [`${V}/02 PRDs/${name}.md`]: `---\nstatus: open\npriority: 50\n${fm}---\n\n# ${name}\n\n## Acceptance\n\n- [x] works\n- [x] refuses bad input\n\n## Specs\n\n${body}\n\n## Review\n\n## Status\n\nNothing yet.\n`,
})
const unit = (name: string, status: string, checks = "[]") => ({
  [`${V}/01 Specs/${name}.md`]: `---\nstatus: ${status}\ncategory: behavior\nchecks: ${checks}\n---\n\n# ${name}\n\n## Plan\n\n- [x] do it\n\n## Status\n\nDone.\n`,
})

/** git answers HEAD and a clean (or one dirty) tree; `sh -c <cmd>` answers each check from `codes`. */
const runner = (opts: { dirty?: string[]; codes?: Record<string, number> } = {}): Runner => async (argv) => {
  const s = argv.join(" ")
  if (s.includes("git rev-parse")) return { code: 0, stdout: "abc123def456\n", stderr: "" }
  if (s.includes("git status --porcelain")) return { code: 0, stdout: (opts.dirty ?? []).map((p) => ` M ${p}`).join("\n"), stderr: "" }
  if (argv[0] === "sh" && argv[1] === "-c") {
    const code = argv[2] === "true" ? 0 : (opts.codes?.[argv[2]] ?? 0)
    return { code, stdout: code ? "boom" : "ok", stderr: "" }
  }
  return { code: 127, stdout: "", stderr: "no" }
}

test("prd_add writes a note from the template; scan and next read states, needs and priority", async () => {
  const at = io(prd("Base", "priority: 80\n"))
  const out = await prdAdd(at as any, { title: "Second", acceptance: ["it runs"], needs: ["Base"], priority: 90 })
  expect(out).toContain("02 PRDs/Second.md")
  const text = (at as any).files[`${V}/02 PRDs/Second.md`]
  expect(text).toContain("priority: 90")
  expect(text).toContain("needs: [Base]")
  expect(text).toContain("- [ ] it runs")
  // Base is ready (no needs); Second waits for Base to be done.
  const next = await prdNext(at as any)
  expect(next).toContain("Base")
  expect(next).not.toContain("Second")
  const scan = await prdScan(at as any)
  expect(scan).toContain("Second · open")
  expect(scan).toContain("held: needs: Base")
  // The template's example link inside its HTML comment is not a linked unit.
  expect(scan).toContain("0 spec(s)")
  // A claimed PRD is not ready either.
  const claimed = io({ ...prd("Base", "priority: 80\n"), [`${V}/02 PRDs/Second.md`]: (at as any).files[`${V}/02 PRDs/Second.md`].replace("priority: 90", "priority: 90\nowner: someone") })
  expect(await prdNext(claimed as any)).not.toContain("Second")
})

test("prd_set refuses specced without a unit, blocked without a reason, and done by hand", async () => {
  const at = io(prd("A", ""))
  await expect(prdSet(at as any, { prd: "A", state: "specced" })).rejects.toThrow("no linked units")
  await expect(prdSet(at as any, { prd: "A", state: "blocked" })).rejects.toThrow("blocked needs a reason")
  await expect(prdSet(at as any, { prd: "A", state: "done" })).rejects.toThrow("state must be one of")
  expect(await prdSet(at as any, { prd: "A", state: "blocked", reason: "waits on vendor" })).toContain("waits on vendor")
  expect((at as any).files[`${V}/02 PRDs/A.md`]).toContain("blocked: waits on vendor")
  expect(await prdSet(at as any, { prd: "A", state: "open" })).toContain("is open")
  expect((at as any).files[`${V}/02 PRDs/A.md`]).not.toContain("blocked: waits on vendor")
})

test("review gate: a passing round accepts, editing the contract makes it stale, low scores fail, five rounds end it", async () => {
  const base = { ...prd("A", "checks: []\n", "[[U]]"), ...unit("U", "implemented") }
  const at = io(base)
  const digest = await contractDigest(at as any, parsePrd("02 PRDs/A.md", (at as any).files[`${V}/02 PRDs/A.md`]))
  await expect(prdCollect(at as any, { prd: "A" })).rejects.toThrow("review: none yet")
  expect(await prdReview(at as any, { prd: "A", score: 95, reviewer: "agent-r", findings: "none" })).toContain("passes the gate")
  const reviewed = (at as any).files[`${V}/02 PRDs/A.md`]
  expect(reviewed).toContain(`digest ${digest}`)
  expect(reviewed).toContain("round 1 · 95/100")
  // Editing the contract (a unit's checks) changes the digest: the round is stale.
  ;(at as any).files[`${V}/01 Specs/U.md`] = (at as any).files[`${V}/01 Specs/U.md`].replace("checks: []", 'checks: ["bun test"]')
  await expect(prdCollect(at as any, { prd: "A" })).rejects.toThrow("review: stale")
  // A low round fails the gate; five failed rounds exhaust the allowance.
  const two = io(base)
  await prdReview(two as any, { prd: "A", score: 70, reviewer: "agent-r" })
  await expect(prdCollect(two as any, { prd: "A" })).rejects.toThrow("scored 70")
  for (let i = 2; i <= GATE_ROUNDS; i++) await prdReview(two as any, { prd: "A", score: 60, reviewer: "agent-r" })
  await expect(prdReview(two as any, { prd: "A", score: 96, reviewer: "agent-r" })).rejects.toThrow(`all ${GATE_ROUNDS} review rounds`)
})

test("prd_collect refuses each missing gate, then writes done, proof and the receipt", async () => {
  const open = io({ ...prd("A", "checks: [\"bun test\"]\n", "[[U]]"), ...unit("U", "implemented") })
  open.files[`${V}/02 PRDs/A.md`] = open.files[`${V}/02 PRDs/A.md`].replace("- [x] refuses bad input", "- [ ] refuses bad input")
  await prdReview(open as any, { prd: "A", score: 95, reviewer: "agent-r" })
  await expect(prdCollect(open as any, { prd: "A" })).rejects.toThrow("open acceptance box")

  const unimplemented = io({ ...prd("A", "", "[[U]]"), ...unit("U", "target") })
  await prdReview(unimplemented as any, { prd: "A", score: 95, reviewer: "agent-r" })
  await expect(prdCollect(unimplemented as any, { prd: "A" })).rejects.toThrow("units not implemented")

  const noSpecs = io(prd("A", ""))
  await prdReview(noSpecs as any, { prd: "A", score: 95, reviewer: "agent-r" })
  await expect(prdCollect(noSpecs as any, { prd: "A" })).rejects.toThrow("links no units")

  const dirty = io({ ...prd("A", "", "[[U]]"), ...unit("U", "implemented") }, runner({ dirty: ["src/x.ts"] }))
  await prdReview(dirty as any, { prd: "A", score: 95, reviewer: "agent-r" })
  await expect(prdCollect(dirty as any, { prd: "A" })).rejects.toThrow("commit the work first")

  const failing = io({ ...prd("A", "checks: [\"bun test\"]\n", "[[U]]"), ...unit("U", "implemented") }, runner({ codes: { "bun test": 1 } }))
  await prdReview(failing as any, { prd: "A", score: 95, reviewer: "agent-r" })
  // The refusal names the command, not an ordinal, so the reader knows what to fix.
  await expect(prdCollect(failing as any, { prd: "A" })).rejects.toThrow("bun test: failing")

  const good = io({ ...prd("A", "checks: [\"bun test\"]\n", "[[U]]"), ...unit("U", "implemented") }, runner())
  await prdReview(good as any, { prd: "A", score: 95, reviewer: "agent-r" })
  const out = await prdCollect(good as any, { prd: "A" })
  expect(out).toContain("Collected \"A\" as done at abc123def456")
  const note = good.files[`${V}/02 PRDs/A.md`]
  expect(note).toContain("status: done")
  expect(note).toContain("proof: \"abc123def456 · review: round 1 · 95/100 · agent-r · 1 check(s) exit 0\"")
  expect(note).toContain("## Collection")
  expect(note).toContain("checks: `bun test` exit 0")
  // A collected PRD is final: no second collect, no new review, no state change.
  expect(await prdCollect(good as any, { prd: "A" })).toContain("already collected")
  await expect(prdReview(good as any, { prd: "A", score: 99, reviewer: "agent-r" })).rejects.toThrow("record is final")
})

test("prd_refine splits an open PRD into children and turns the parent to refine", async () => {
  const at = io(prd("Big", ""))
  const out = await prdRefine(at as any, { prd: "Big", children: ["Part One", "Part Two"], summary: "Split." })
  expect(out).toContain("Refined \"Big\" into 2 child PRD(s)")
  expect((at as any).files[`${V}/02 PRDs/Big.md`]).toContain("status: refine")
  expect((at as any).files[`${V}/02 PRDs/Part One.md`]).toContain("parent: Big")
  await expect(prdRefine(at as any, { prd: "Big", children: ["Part Three"] })).rejects.toThrow("needs an open or question PRD")
  const brief = await prdBrief(at as any, "Part One")
  expect(brief).toContain("parent Big")
})

test("held states: blocked and failed PRDs never show ready, and a refined parent resolves through its children", async () => {
  const at = io(prd("A", "priority: 60\n"))
  await prdSet(at as any, { prd: "A", state: "blocked", reason: "waits on vendor" })
  expect(await prdNext(at as any)).toContain("nothing ready")
  expect(await prdScan(at as any)).toContain("held: state: blocked — waits on vendor")
  await expect(prdCollect(at as any, { prd: "A" })).rejects.toThrow("held: state: blocked")
  await prdSet(at as any, { prd: "A", state: "open" })
  expect(await prdNext(at as any)).toContain("A")

  const split = io({ ...prd("Big", ""), ...prd("Down", "needs: [Big]\n") })
  await prdRefine(split as any, { prd: "Big", children: ["One", "Two"] })
  expect(await prdNext(split as any)).not.toContain("Down")
  for (const c of ["One", "Two"]) {
    const f = `${V}/02 PRDs/${c}.md`
    split.files[f] = split.files[f].replace("status: open", "status: done")
  }
  // Every child collected: the refined parent no longer holds its dependents.
  expect(await prdNext(split as any)).toContain("Down")
})

test("review rounds: the fifth miss fails the PRD, and a passing fifth buys no sixth", async () => {
  const miss = io(prd("A", ""))
  for (let i = 1; i <= GATE_ROUNDS; i++) await prdReview(miss as any, { prd: "A", score: 60, reviewer: "r" })
  expect(miss.files[`${V}/02 PRDs/A.md`]).toContain("status: failed")
  expect(await prdScan(miss as any)).toContain("held: state: failed")
  await expect(prdReview(miss as any, { prd: "A", score: 96, reviewer: "r" })).rejects.toThrow("allowance is exhausted")

  const pass = io(prd("A", ""))
  for (let i = 2; i <= GATE_ROUNDS; i++) await prdReview(pass as any, { prd: "A", score: 60, reviewer: "r" })
  expect(await prdReview(pass as any, { prd: "A", score: 96, reviewer: "r" })).toContain("passes the gate")
  await expect(prdReview(pass as any, { prd: "A", score: 96, reviewer: "r" })).rejects.toThrow("allowance is exhausted")
})

test("the digest follows the contract text, not the ticks or the layout", async () => {
  const at = io({ ...prd("A", "", "[[U]]"), ...unit("U", "target") })
  const note = () => parsePrd("02 PRDs/A.md", at.files[`${V}/02 PRDs/A.md`])
  const first = await contractDigest(at as any, note())
  at.files[`${V}/02 PRDs/A.md`] = at.files[`${V}/02 PRDs/A.md`].replace("- [x] works", "- [ ] works")
  expect(await contractDigest(at as any, note())).toBe(first)
  at.files[`${V}/02 PRDs/A.md`] = at.files[`${V}/02 PRDs/A.md`].replace("- [ ] works", "- [x] works differently")
  expect(await contractDigest(at as any, note())).not.toBe(first)
  at.files[`${V}/02 PRDs/A.md`] = at.files[`${V}/02 PRDs/A.md`].replace("- [x] works differently", "- [x] works").replace("priority: 50", "priority: 70")
  expect(await contractDigest(at as any, note())).toBe(first)
})

test("a newline in the reviewer cannot split the round line and reset the gate", async () => {
  const at = io({ ...prd("A", "", "[[U]]"), ...unit("U", "implemented") })
  await prdReview(at as any, { prd: "A", score: 95, reviewer: "agent\nr" })
  expect(at.files[`${V}/02 PRDs/A.md`]).toContain("· agent r")
  expect(await prdScan(at as any)).toContain("review: round 1 · 95/100")
  // A second round appends; the first survives a rewritten section body.
  await prdReview(at as any, { prd: "A", score: 96, reviewer: "agent-r", findings: "line one\nline two" })
  const text = at.files[`${V}/02 PRDs/A.md`]
  expect(text).toContain("round 1 · 95/100")
  expect(text).toContain("round 2 · 96/100")
  expect(text).toContain("finding: line one line two")
})

test("prd_add keeps the template's defaults for fields the caller leaves out", async () => {
  const at = io()
  await prdAdd(at as any, { title: "Plain" })
  const text = at.files[`${V}/02 PRDs/Plain.md`]
  expect(text).toContain("priority: 50")
  expect(text).toContain("needs: []")
  expect(text).toContain("checks: []")
})

test("prd_set open starts a fresh five-round allowance however the last attempt ended", async () => {
  // Spent on failures the PRD is `failed`; spent with a passing last round it stays `open`.
  for (const [status, last] of [["failed", 40], ["open", 95]] as const) {
    const at = io(prd("A", ""))
    for (let i = 0; i < GATE_ROUNDS - 1; i++) await prdReview(at as any, { prd: "A", score: 40, reviewer: "r" })
    const text = await prdReview(at as any, { prd: "A", score: last, reviewer: "r" })
    if (last >= 90) expect(text).toContain("passes the gate")
    expect(at.files[`${V}/02 PRDs/A.md`]).toContain(`status: ${status}`)
    await expect(prdReview(at as any, { prd: "A", score: 95, reviewer: "r" })).rejects.toThrow(`used all ${GATE_ROUNDS}`)
    expect(await prdSet(at as any, { prd: "A", state: "open" })).toContain("rounds reset")
    expect(at.files[`${V}/02 PRDs/A.md`]).toContain("- reopened")
    // The round numbers keep counting; the allowance restarts.
    expect(await prdReview(at as any, { prd: "A", score: 95, reviewer: "r" })).toContain(`round ${GATE_ROUNDS + 1}/${GATE_ROUNDS}`)
    expect(await prdScan(at as any)).toContain(`review: round ${GATE_ROUNDS + 1} · 95/100`)
  }
})

test("a hand-written case twin is refused by every read path, not silently shadowed", async () => {
  const at = io({ ...prd("Base", ""), ...prd("base", "") })
  await expect(prdSet(at as any, { prd: "Base", state: "blocked", reason: "waiting" })).rejects.toThrow("ambiguous")
  await expect(prdAdd(at as any, { title: "Child", parent: "base" })).rejects.toThrow("ambiguous")
})

test("prd_add refuses a title that differs from a note only in case", async () => {
  const at = io(prd("Base", ""))
  await expect(prdAdd(at as any, { title: "base" })).rejects.toThrow("differ by case only")
})

test("a need or a parent written in another case still resolves", async () => {
  const at = io(prd("Base", ""))
  await prdAdd(at as any, { title: "Child", needs: ["base"], parent: "BASE" })
  expect(at.files[`${V}/02 PRDs/Child.md`]).toContain("needs: [Base]")
  expect(at.files[`${V}/02 PRDs/Child.md`]).toContain("parent: Base")
  // A hand-written lower-case need is found, so it waits instead of reporting it missing.
  const hand = io({
    ...prd("Base", ""),
    ...prd("Kid", "needs: [base]\n"),
    [`${V}/02 PRDs/Base.md`]: (at as any).files[`${V}/02 PRDs/Base.md`],
  })
  expect(await prdScan(hand as any)).toContain("held: needs: base")
  expect(await prdScan(hand as any)).not.toContain("missing needs")
})

test("prd_brief sends a held PRD to its hold instead of to review and collect", async () => {
  const brief = await prdBrief(io(prd("A", "status: blocked\nblocked: vendor\n")) as any, "A")
  expect(brief).toContain("held: state: blocked — vendor")
  expect(brief).toContain("next: state: blocked — vendor")
  expect(brief).not.toContain("next: work the linked units")
})

test("every PRD write refreshes the plan snapshot", async () => {
  const at = io()
  await prdAdd(at as any, { title: "Plain" })
  const data = JSON.parse(at.files[`${V}/00 Meta/Plan Data.json`])
  expect(data.source.files.some((f: { path: string }) => f.path === "02 PRDs/Plain.md")).toBe(true)
})
