import { test, expect } from "claude-code/testing"
import { COMMAND_TOOLS } from "./commands.ts"

test("tools: flat, no action switch, required fields named in the schema", () => {
  expect(Object.keys(COMMAND_TOOLS)).toEqual(["checks", "scan", "status", "report", "rate", "mistake", "loadout", "hygiene_ledger"])
  for (const t of Object.values(COMMAND_TOOLS)) {
    expect(Object.keys(t.properties ?? {})).not.toContain("action")
    for (const r of t.required ?? []) expect(Object.keys(t.properties ?? {})).toContain(r)
    expect(t.description.length).toBeGreaterThan(40)
  }
})

test("session: a command tool runs in-process; a refusal is an error result", async ($, on) => {
  on("session.cwd" as any, async () => ({ value: "/nonexistent-overwatch-test" }) as any)
  const runs: any[] = []
  on("process.run", async (_: any, e: any) => (runs.push(e), { value: { exitCode: 0, stdout: "", stderr: "" } }) as any)
  const ok = JSON.stringify(await $.tool.call({ tool: "mcp__overwatch__checks" } as any))
  expect(ok).toContain("no checks frozen")
  expect(runs).toEqual([]) // in-process: reading the frozen checks spawns nothing
  const bad = await $.tool.call({ tool: "mcp__overwatch__rate", name: "WebFetch", verdict: "useful", reason: "x" } as any)
  expect(JSON.stringify(bad)).toContain("needs a trigger")
  expect((bad as any).isError).toBe(true)
})

test("surface: built once from the active tools, added to the prompt, reused after", async ($, on) => {
  on("tool.list", async () => ({ value: [{ name: "Agent", description: "", mcp: false }] }) as any)
  on("prompt.compose", async () => ({ sections: [{ id: "intro", text: "x", scope: "shared" }] }) as any)
  const reads: string[] = []
  on("fs.read", async (_: any, e: any, next: any) => (reads.push(String(e?.path ?? e)), next(e)) as any)
  const block = async () => (await ($.prompt.compose as any)({ model: "m", promptModel: "m", surfaces: [], tools: ["Bash", "Read"], outputStyle: null, traits: [] })).sections.filter((x: any) => x.id === "overwatch:surface")
  const first = await block()
  const n = reads.length
  const again = await block()
  expect(JSON.stringify(again)).toBe(JSON.stringify(first))
  expect(reads.length).toBe(n) // the second compose reads nothing: the block is kept in $.state
})
