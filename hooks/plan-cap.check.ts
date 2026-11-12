// Real registered native handlers plus live compaction; only SDK atom storage is stubbed.
import { expect, mock, test } from "bun:test"
mock.module("claude-code", () => ({
  atom: (key: any, initial: any) => ({ key: key.key, initial }),
  read: async ($: any, atom: any) => $.values.get(atom.key) ?? atom.initial,
  update: async ($: any, atom: any, f: any) => {
    const value = f($.values.get(atom.key) ?? atom.initial)
    $.values.set(atom.key, value)
    return value
  },
}))
const { register: plan } = await import("./plan-hooks.ts")
const { register: compaction, compactToolCall } = await import("./compaction.ts")
const { CLEAN, detail, tool } = await import("./plan.ts")
const { liveResultBudget } = await import("./paging.ts")

test.each([0, 1000, NaN])("configured native plan pages survive live compaction exactly (%s)", async (configured) => {
  const handlers = new Map<string, any>()
  const options = { liveResultMaxChars: configured }
  plan(((event: string, match: any, handler: any) => { if (event === "tool.call" && match?.tool) handlers.set(match.tool, handler) }) as any, options)
  compaction((() => {}) as any, options)
  const files = new Map<string, string>()
  const $: any = { values: new Map(), session: { cwd: async () => "/repo", id: async () => "plan-cap" },
    fs: { exists: async (p: string) => files.has(p), read: async (p: string) => files.get(p), write: async (p: string, t: string) => { files.set(p, t) } } }
  let seq = 0
  const call = async (name: string, args: any) => {
    const e = { tool: tool(name), tool_use_id: `toolu_page_${seq++}`, ...args }
    return compactToolCall($, e, (input) => handlers.get(e.tool)($, input))
  }
  const title = "same exact line 😀\\\"\n".repeat(100)
  await call("task_add", { titles: [title] })
  let page = (await call("plan_show", { limit: 100000 })).result
  let text = ""
  while (true) {
    expect(typeof page).toBe("object")
    expect(JSON.stringify({ result: page }).length).toBeLessThanOrEqual(liveResultBudget(configured))
    text += page.text
    if (page.next_offset === null) break
    page = (await call("plan_show", { id: page.id, offset: page.next_offset, limit: 100000 })).result
  }
  expect(text).toBe(detail({ tasks: [{ id: 1, title: title.trim(), progress: 0, status: "todo" }], nextId: 2, guards: [] }, CLEAN))
})
