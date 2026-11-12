import { test, expect } from "claude-code/testing"
import { session } from "./test-session.ts"
import { COMMAND_TOOLS } from "./commands.ts"

test("tools: flat, no action switch, required fields named in the schema", () => {
  expect(Object.keys(COMMAND_TOOLS)).toEqual(["vault_init", "vault_plan", "unit_new", "prd_scan", "prd_next", "prd_brief", "prd_add", "prd_refine", "prd_set", "prd_review", "prd_collect", "checks", "scan", "status", "report", "rate", "mistake", "mistakes", "loadout", "hygiene_ledger", "disk", "disk_clean", "launch", "launched"])
  for (const t of Object.values(COMMAND_TOOLS)) {
    expect(Object.keys(t.properties ?? {})).not.toContain("action")
    for (const r of t.required ?? []) expect(Object.keys(t.properties ?? {})).toContain(r)
    expect(t.description.length).toBeGreaterThan(40)
  }
})

session("session: a command tool runs in-process; a refusal is an error result", async ($, on) => {
  on("session.cwd" as any, async () => ({ value: "/nonexistent-overwatch-test" }) as any)
  const runs: any[] = []
  on("process.run", async (_: any, e: any) => (runs.push(e), { value: { exitCode: 0, stdout: "", stderr: "" } }) as any)
  const ok = JSON.stringify(await $.tool.call({ tool: "mcp__overwatch__checks" } as any))
  expect(ok).toContain("no checks frozen")
  // In-process: nothing is spawned but the gardener's one `df`.
  expect(runs.filter((r) => r.argv?.[0] !== "df")).toEqual([])
  const bad = await $.tool.call({ tool: "mcp__overwatch__rate", name: "WebFetch", verdict: "useful", reason: "x" } as any)
  expect(JSON.stringify(bad)).toContain("needs a trigger")
  expect((bad as any).isError).toBe(true)
})

session("surface: built once from the active tools, added to the prompt, reused after", async ($, on) => {
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
