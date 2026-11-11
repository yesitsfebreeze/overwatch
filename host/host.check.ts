// The portable core end to end: plan tools over the state file, the edit gate, the stop
// verdict with a real shell check, and the MCP server over stdio. Run: bun test ./host/host.check.ts
// (named *.check.ts so `claude plugin test .` does not load it into the hooks engine).
import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fromNode } from "../bin/node-io.ts"
import { callTool, onEvent } from "./core.ts"
import { hook } from "./hooks.ts"

const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), "ow-"))
  process.env.XDG_STATE_HOME = join(dir, "state")
  process.env.OVERWATCH_PROJECT = dir
  return { dir, io: fromNode(dir) }
}

test("plan: edits wait for tasks and guards; the stop holds until the check passes", async () => {
  const { dir, io } = sandbox()
  expect((await onEvent(io, { kind: "pre_tool", cwd: dir, tool: "apply_patch" })).deny).toContain("no tasks and no guards")
  expect((await onEvent(io, { kind: "pre_tool", cwd: dir, tool: "read" })).deny).toBeUndefined()
  expect((await callTool(io, "task_add", { titles: ["make done file"] })).text).toContain('Added #1')
  expect((await callTool(io, "guard_add", { question: "Does the done file exist in the project?", check: "test -f done" })).error).toBeFalsy()
  expect((await onEvent(io, { kind: "pre_tool", cwd: dir, tool: "Edit" })).deny).toBeUndefined()
  const held = await onEvent(io, { kind: "stop", cwd: dir })
  expect(held.block).toContain('task #1')
  expect(held.block).not.toContain("mcp__overwatch__")
  await callTool(io, "task_complete", { task_id: 1 })
  expect((await onEvent(io, { kind: "stop", cwd: dir })).block).toContain("test -f done")
  await io.run(["touch", "done"], { cwd: dir })
  expect(await onEvent(io, { kind: "stop", cwd: dir })).toEqual({})
  expect((await onEvent(io, { kind: "prompt", cwd: dir })).context).toContain("1 task(s), 100% overall")
  // Every catch above was recorded: one refused edit, two refused stops.
  const report = (await callTool(io, "report")).text
  expect(report).toContain("stop with work open 2")
  expect(report).toContain("edit before a plan 1")
  // A third refused stop makes it a habit: the next session starts with the lesson.
  await callTool(io, "task_add", { titles: ["more"] })
  await onEvent(io, { kind: "stop", cwd: dir })
  expect((await onEvent(io, { kind: "start", cwd: dir })).context).toContain("Before ending a turn")
})

test("hook formats: Codex Stop blocks with a reason, PreToolUse denies", async () => {
  const { dir, io } = sandbox()
  const pre = await hook(io, "codex", "PreToolUse", JSON.stringify({ cwd: dir, tool_name: "apply_patch", tool_input: {} }))
  expect(JSON.parse(pre.text).hookSpecificOutput.permissionDecision).toBe("deny")
  await callTool(io, "task_add", { titles: ["x task"] })
  const stop = await hook(io, "codex", "Stop", JSON.stringify({ cwd: dir }))
  expect(JSON.parse(stop.text).decision).toBe("block")
})

test("mcp: initialize, tools/list, tools/call over stdio", async () => {
  const { dir } = sandbox()
  const p = Bun.spawn(["bun", join(import.meta.dir, "../bin/cli.ts"), "mcp"], { cwd: dir, stdin: "pipe", stdout: "pipe", env: process.env })
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "task_add", arguments: { titles: ["a"] } } },
  ]
  p.stdin.write(msgs.map((m) => JSON.stringify(m)).join("\n") + "\n")
  p.stdin.end()
  const out = (await new Response(p.stdout).text()).trim().split("\n").map((l) => JSON.parse(l))
  expect(out.map((o) => o.id)).toEqual([1, 2, 3])
  expect(out[1].result.tools.map((t: any) => t.name)).toContain("guard_add")
  expect(out[2].result.content[0].text).toContain('Added #1 "a"')
})
