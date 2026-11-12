import { expect, test } from "bun:test"
import { register as commands } from "./commands.ts"
import { register as compaction, compactToolCall } from "./compaction.ts"

test.each([512, 1000])("native mistakes pages survive live compaction exactly at cap %s", async (cap) => {
  const handlers = new Map<string, any>(), options = { liveResultMaxChars: cap }
  commands(((event: string, match: any, handler: any) => { if (event === "tool.call" && match?.tool) handlers.set(match.tool, handler) }) as any, options)
  compaction((() => {}) as any, options)
  const raw = '# Exact 😀\n- repeat "\\ line\n'.repeat(200)
  const files = new Map([["/repo/.overwatch/mistakes.md", raw]])
  const $: any = { plugin: { root: "/plugin" }, session: { cwd: async () => "/repo", id: async () => "mistakes-cap" },
    fs: { exists: async (p: string) => files.has(p), read: async (p: string) => files.get(p), write: async (p: string, t: string) => { files.set(p, t) } } }
  let joined = "", args: any = {}, seq = 0
  while (true) {
    const e = { tool: "mcp__overwatch__mistakes", tool_use_id: `mistakes_page_${seq++}`, ...args }
    const out = await compactToolCall($, e, (input) => handlers.get(e.tool)($, input))
    expect(typeof out.result).toBe("object")
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(cap)
    const page: any = out.result
    joined += page.text
    if (page.next_offset === null) break
    args = { id: page.id, offset: page.next_offset, limit: 100000 }
  }
  expect(joined).toBe(raw)
})
