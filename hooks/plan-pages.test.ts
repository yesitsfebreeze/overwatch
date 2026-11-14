import { test, expect } from "claude-code/testing"
import { session } from "./test-session.ts"
import { CLEAN, FRESH, detail, planPage, reminder, stopVerdict, tool } from "./plan.ts"

test("plan reminders bound history and previews without exposing partial commands", () => {
  const state: any = {
    nextId: 2002,
    tasks: [...Array.from({ length: 2000 }, (_, n) => ({ id: n + 1, title: "completed-sentinel".repeat(100), progress: 100, status: "done" })), { id: 2001, title: "active-sentinel".repeat(1000), progress: 20, status: "active" }],
    guards: [{ id: "g".repeat(10000), question: "question".repeat(1000), check: "command-sentinel".repeat(1000), last: { exit: 1 } }],
  }
  const text = reminder(state, true)
  expect(text.length).toBeLessThan(1200)
  expect(text).toContain("2000 done")
  expect(text).toContain("active-sentinel")
  expect(text).not.toContain("completed-sentinel")
  expect(text).not.toContain("command-sentinel")
  expect(text).toContain("plan_show")
  expect(state.tasks.length).toBe(2001)
  const crowded = { ...state, guards: Array.from({ length: 2000 }, (_, n) => ({ ...state.guards[0], id: String(n).padEnd(64, "g") })) }
  expect(reminder(crowded, true).length).toBeLessThan(1200)
  expect(reminder(crowded).length).toBeLessThan(2000)
  const stop = stopVerdict(state, state.guards, CLEAN, FRESH).verdict
  expect(stop.kind).toBe("block")
  if (stop.kind !== "pass") {
    expect(stop.reason.length).toBeLessThan(3000)
    expect(stop.reason).toContain("2 item(s) open")
    expect(stop.reason).not.toContain("command-sentinel")
  }
})

test("plan pages preserve full history and guard fields with bounded serialization", () => {
  const state: any = { nextId: 2, tasks: [{ id: 1, title: 'done 😀 \\"\n'.repeat(1500), progress: 100, status: "done" }], guards: [{ id: "g", question: "Is it done?", check: 'echo "😀\\\\"\n'.repeat(2000), files: ["complete-file-name"], last: { exit: 1, out: "full last outcome" } }] }
  let page = planPage(state, CLEAN, { limit: 100000 })
  const id = page.id
  let text = ""
  while (true) {
    expect(JSON.stringify({ result: page }).length).toBeLessThan(8000)
    text += page.text
    if (page.next_offset === null) break
    page = planPage(state, CLEAN, { id, offset: page.next_offset, limit: 100000 })
  }
  expect(text).toBe(detail(state, CLEAN))
  expect(text).toContain("complete-file-name")
  expect(text).toContain("full last outcome")
  expect(() => planPage({ ...state, tasks: [] }, CLEAN, { id, offset: 1 })).toThrow("plan changed")
  expect(() => planPage(state, CLEAN, { offset: 1 })).toThrow("first page's id")
  for (const args of [{ offset: -1 }, { offset: 1.5 }, { offset: "0" }, { limit: 0 }, { limit: Infinity }, { limit: "5" }])
    expect(() => planPage(state, CLEAN, args)).toThrow()
})

session("plan_show: native pages keep exact text through live result handling", async ($, on) => {
  on("session.cwd", async () => ({ value: "/repo" }) as any)
  const title = 'Unicode 😀 mcp__overwatch__literal \\"\n'.repeat(300)
  await $.tool.call({ tool: tool("task_add"), titles: [title] } as any)
  const first: any = await $.tool.call({ tool: tool("plan_show"), limit: 100000 } as any)
  expect(typeof first.result).toBe("string")
  let page = JSON.parse(first.result)
  let restored = ""
  do {
    expect(JSON.stringify(page).length).toBeLessThan(8000)
    restored += page.text
    if (page.next_offset === null) break
    const next: any = await $.tool.call({ tool: tool("plan_show"), id: page.id, offset: page.next_offset, limit: 100000 } as any)
    page = JSON.parse(next.result)
  } while (true)
  expect(restored).toBe(detail({ tasks: [{ id: 1, title: title.trim(), progress: 0, status: "todo" }], nextId: 2, guards: [] }, CLEAN))
  const bad: any = await $.tool.call({ tool: tool("plan_show"), offset: -1 } as any)
  expect(JSON.stringify(bad)).toContain("offset")
  await $.tool.call({ tool: tool("task_add"), titles: ["new revision"] } as any)
  const stale: any = await $.tool.call({ tool: tool("plan_show"), id: JSON.parse(first.result).id, offset: 1 } as any)
  expect(JSON.stringify(stale)).toContain("plan changed")
})
