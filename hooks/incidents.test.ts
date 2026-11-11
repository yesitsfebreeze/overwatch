import { test, expect } from "claude-code/testing"
import { memIo } from "./io.ts"
import { add, incidentReport, lessons, load, note, REPEAT_AT, tallyLine, totals, WINDOW_DAYS, type Incidents } from "./incidents.ts"
import { learned } from "./surface.ts"

const NONE: Incidents = { days: {}, recent: [] }
const NOW = new Date("2026-11-11T12:00:00Z")
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000)

test("ledger: counts per day, a lesson only once a kind repeats, old days fall out of the window", () => {
  let st = NONE
  for (let i = 0; i < REPEAT_AT - 1; i++) st = add(st, "unplanned_edit", "/repo", "Write", NOW)
  expect(totals(st, NOW)).toEqual([["unplanned_edit", REPEAT_AT - 1]])
  expect(lessons(st, NOW)).toEqual([]) // not a habit yet
  st = add(st, "unplanned_edit", "/repo", "Edit", NOW)
  expect(lessons(st, NOW).join("\n")).toContain(`caught ${REPEAT_AT}× in ${WINDOW_DAYS} days`)
  // A kind without a lesson is counted, never preached.
  for (let i = 0; i < REPEAT_AT; i++) st = add(st, "failed_turn", "/repo", "Bash: exit 1", NOW)
  expect(lessons(st, NOW).length).toBe(1)
  expect(tallyLine(st, NOW)).toContain(`turn with failed tool calls ${REPEAT_AT}`)
  // Behaviour that stopped is forgotten: the same ledger read after the window has nothing left.
  expect(totals(st, daysAgo(-WINDOW_DAYS - 1))).toEqual([])
  expect(Object.keys(add(add(NONE, "stalled", "/r", "", daysAgo(WINDOW_DAYS + 5)), "stalled", "/r", "", NOW).days)).toEqual(["2026-11-11"])
})

test("ledger: the newest entries are kept, clipped to one line, and reported newest first", () => {
  let st = NONE
  for (let i = 0; i < 50; i++) st = add(st, "early_stop", "/home/me/repo", `task #${i}\n  still   open ${"x".repeat(300)}`, NOW)
  expect(st.recent.length).toBe(40)
  expect(st.recent.at(-1)!.detail.length).toBe(200)
  expect(st.recent.at(-1)!.detail).toContain("task #49 still open")
  const lines = incidentReport(st, NOW).split("\n")
  expect(lines[0]).toBe(`caught (${WINDOW_DAYS} days): stop with work open 50`)
  expect(lines[1]).toContain("stop with work open: task #49")
  expect(lines[1]).toContain("(repo)")
})

test("note and learned: a catch lands in the state file; habits and the repo's mistakes make the lessons block", async () => {
  const io = memIo({ "/repo/.claude/overwatch/mistakes.md": "# Mistakes to fold into every plan\n- ran the suite under a held lock: use the built binary (2026-11-01)\n" }, "/repo")
  expect(await learned(io)).not.toContain("Caught repeatedly")
  for (let i = 0; i < REPEAT_AT; i++) await note(io, "early_stop", "task #1")
  expect(totals(await load(io))[0]).toEqual(["early_stop", REPEAT_AT])
  const block = await learned(io)
  expect(block).toContain("# Lessons (overwatch)")
  expect(block).toContain("Before ending a turn")
  expect(block).toContain("ran the suite under a held lock")
  expect(await learned(memIo({}, "/empty"))).toBe("") // nothing learned: nothing added to the prompt
  // A broken ledger starts over instead of failing the hook that caught something.
  const broken = memIo({ ".local/state/overwatch/incidents.json": "{not json" })
  await note(broken, "stalled")
  expect(totals(await load(broken))).toEqual([["stalled", 1]])
})

test("session: a refused edit, an invalid call and a refused stop are each recorded; the habit rides the next session's prompt", async ($, on) => {
  const files: Record<string, string> = {}
  on("session.cwd", async () => ({ value: "/repo" }) as any)
  on("env.get", async (_: any, e: any) => ({ value: (e?.name ?? e) === "XDG_STATE_HOME" ? "/state" : undefined }) as any)
  on("fs.read", async (_: any, e: any) => (String(e?.path ?? e) in files ? { value: files[String(e?.path ?? e)] } : { deny: "ENOENT" }) as any)
  on("fs.write", async (_: any, e: any) => ((files[e.path] = e.text), { value: undefined }) as any)
  on("fs.exists", async (_: any, e: any) => ({ value: String(e?.path ?? e) in files }) as any)
  on("process.run", async () => ({ value: { exitCode: 0, stdout: "", stderr: "" } }) as any)
  on("tool.list", async () => ({ value: [] }) as any)
  on("prompt.compose", async () => ({ sections: [] }) as any)
  on("classic.Stop", async () => ({}) as any)
  on("tool.call", async () => ({ result: "written" }) as any)
  const kinds = () => (JSON.parse(files["/state/overwatch/incidents.json"] ?? "{}").recent ?? []).map((i: any) => i.kind)

  for (let i = 0; i < REPEAT_AT; i++) await $.tool.call({ tool: "Write", file_path: "/repo/x", content: "x" } as any)
  expect(kinds()).toEqual(Array(REPEAT_AT).fill("unplanned_edit"))
  await $.tool.call({ tool: "mcp__overwatch__task_add" } as any) // required `titles` missing
  expect(kinds().at(-1)).toBe("invalid_call")
  await $.tool.call({ tool: "mcp__overwatch__task_add", titles: ["the work"] } as any)
  expect(JSON.stringify(await $.classic.Stop({ stop_hook_active: false, last_assistant_message: "x" } as any))).toContain("not done")
  expect(kinds().at(-1)).toBe("early_stop")
  expect(JSON.parse(files["/state/overwatch/incidents.json"]!).recent.at(-1).detail).toContain('task #1 "the work"')

  const sections = JSON.stringify((await ($.prompt.compose as any)({ model: "m", promptModel: "m", surfaces: [], tools: [], outputStyle: null, traits: [] })).sections)
  expect(sections).toContain("Plan before the first file change")
  expect(sections).not.toContain("Before ending a turn") // caught once: not a habit
})
