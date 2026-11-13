// The portable core end to end: plan tools over the state file, the edit gate, the stop verdict with a
// real shell check, and the MCP server over stdio. Run: bun test ./host/host.check.ts
// (*.check.ts so `claude plugin test .` does not load it into the hooks engine).
import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fromNode } from "../bin/node-io.ts"
const { callTool, onEvent } = await import("./core.ts")
const { hook } = await import("./hooks.ts")
import { memIo } from "../hooks/io.ts"
import { CLEAN, detail } from "../hooks/plan.ts"

test("portable plan_show forwards exact pages and rejects invalid or stale continuation", async () => {
  const io = memIo({}, "/plan-pages")
  const title = 'literal mcp__overwatch__prefix 😀 \\"\n'.repeat(300)
  await callTool(io, "task_add", { titles: [title] })
  let page = JSON.parse((await callTool(io, "plan_show", { limit: 1000 })).text)
  const id = page.id
  let text = ""
  while (true) {
    expect(JSON.stringify(page).length).toBeLessThan(8000)
    text += page.text
    if (page.next_offset === null) break
    page = JSON.parse((await callTool(io, "plan_show", { id, offset: page.next_offset, limit: 1000 })).text)
  }
  expect(text).toBe(detail({ tasks: [{ id: 1, title: title.trim(), progress: 0, status: "todo" }], nextId: 2, guards: [] }, CLEAN))
  expect((await callTool(io, "plan_show", { offset: -1 })).error).toBe(true)
  expect((await callTool(io, "plan_show", { offset: 1 })).text).toContain("first page's id")
  expect((await callTool(io, "plan_show", { limit: "5" })).error).toBe(true)
  await callTool(io, "task_add", { titles: ["new revision"] })
  expect((await callTool(io, "plan_show", { id, offset: 1 })).text).toContain("plan changed")
})

const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), "ow-"))
  return { dir, io: fromNode(dir) }
}

test("mistakes reader: portable and CLI pages preserve the original history", async () => {
  const { dir, io } = sandbox()
  const raw = '# Full history 😀\n- quoted "\\ lesson\n'.repeat(300)
  await io.write(join(dir, ".overwatch", "mistakes.md"), raw)
  let page = JSON.parse((await callTool(io, "mistakes", { limit: 1200 })).text), joined = ""
  while (true) {
    joined += page.text
    if (page.next_offset === null) break
    page = JSON.parse((await callTool(io, "mistakes", { id: page.id, offset: page.next_offset, limit: 1200 })).text)
  }
  expect(joined).toBe(raw)
  const cli = Bun.spawnSync([process.execPath, join(import.meta.dir, "../bin/cli.ts"), "mistakes", "0", "1000"], { cwd: dir })
  expect(cli.exitCode).toBe(0)
  expect(JSON.parse(cli.stdout.toString()).text).toBe(raw.slice(0, 1000))
  expect((await callTool(io, "mistakes", { limit: 0 })).error).toBe(true)
})

test("portable timeout remains unmet, pauses automatic retry, and explicit override persists", async () => {
  let calls = 0, timedOut = true
  const budgets: number[] = []
  const io = memIo({}, "/timeout-check", async (argv, init) => {
    if (argv.at(-1) !== "timeout-probe") return { code: 0, stdout: "", stderr: "" }
    calls++; budgets.push(init!.timeoutMs!)
    return { code: timedOut ? 124 : 0, stdout: "", stderr: "", timedOut }
  })
  await callTool(io, "guard_add", { question: "Does the timeout probe pass?", check: "timeout-probe" })
  expect((await onEvent(io, { kind: "stop", cwd: io.cwd })).block).toContain("timed out")
  expect((await onEvent(io, { kind: "stop", cwd: io.cwd })).block).toContain("timed out")
  expect(calls).toBe(1)
  expect((await callTool(io, "guard_check", { timeout_ms: 600001 })).error).toBe(true)
  expect(calls).toBe(1)
  timedOut = false
  expect((await callTool(io, "guard_check", { timeout_ms: 180000 })).text).toContain("upheld")
  expect(await onEvent(io, { kind: "stop", cwd: io.cwd })).toEqual({})
  expect(budgets).toEqual([60000, 180000, 180000])
})

test("automatic checks: open work waits, the ninth stop spends nothing, explicit checks stay fresh", async () => {
  let checks = 0
  let exit = 1
  const io = memIo({}, "/guard-evaluation", async (argv) => {
    const check = argv.at(-1) === "guard-probe"
    if (check) checks++
    return { code: check ? exit : 0, stdout: "", stderr: "" }
  })
  await callTool(io, "task_add", { titles: ["Finish work"] })
  await callTool(io, "guard_add", { question: "Does the guard probe pass?", check: "guard-probe" })
  await onEvent(io, { kind: "stop", cwd: io.cwd })
  expect(checks).toBe(0)
  await callTool(io, "guard_check")
  expect(checks).toBe(1)
  await callTool(io, "task_complete", { task_id: 1 })
  await onEvent(io, { kind: "prompt", cwd: io.cwd, person: true })
  for (exit = 1; exit <= 8; exit++) expect((await onEvent(io, { kind: "stop", cwd: io.cwd })).block).toBeTruthy()
  expect(checks).toBe(9)
  expect((await onEvent(io, { kind: "stop", cwd: io.cwd })).notify).toContain("unverified")
  expect(checks).toBe(9)
  exit = 0
  await callTool(io, "guard_check")
  expect(checks).toBe(10)
  await onEvent(io, { kind: "prompt", cwd: io.cwd, person: true })
  expect(await onEvent(io, { kind: "stop", cwd: io.cwd })).toEqual({})
  expect(checks).toBe(11)
})

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
  expect(held.block).toContain("task_progress, task_complete, guard_check")
  expect(held.block).toContain("only the user drops a guard")
  for (const instruction of ["/code-review", "/simplify", "Skill", "AskUserQuestion"])
    expect(held.block).not.toContain(instruction)
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

test("launch: returns at once, the run goes on, launched reads its exit code and log", async () => {
  const { io } = sandbox()
  const t0 = Date.now()
  const id = /launched id (\w+)/.exec((await callTool(io, "launch", { command: "sleep 1; echo built; exit 3" })).text)?.[1] ?? ""
  expect(Date.now() - t0).toBeLessThan(800)
  expect((await callTool(io, "launched", { id })).text).toContain("running")
  let done = ""
  // The command text holds "exit 3" and "built" too: match the state and the log line only.
  for (let i = 0; i < 40 && !done.startsWith(`${id} exit`); i++) await Bun.sleep(100), (done = (await callTool(io, "launched", { id })).text)
  expect(Date.now() - t0).toBeGreaterThan(900)
  expect(done).toStartWith(`${id} exit 3`)
  expect(done).toEndWith("\nbuilt")
  expect((await callTool(io, "launch", { command: "echo now", wait: true })).text).toBe("exit 0\nnow")
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

test("state: everything lands in .overwatch/ in the project; a git repo is asked to ignore it until it does", async () => {
  const { dir, io } = sandbox()
  expect((await onEvent(io, { kind: "start", cwd: dir })).context).not.toContain(".gitignore") // no repo: nothing to ignore
  Bun.spawnSync(["git", "init", "-q", dir])
  expect((await onEvent(io, { kind: "start", cwd: dir })).context).toContain("printf '\\n.overwatch/*\\n!.overwatch/vault/\\n' >> .gitignore")
  await callTool(io, "task_add", { titles: ["a task"] })
  await callTool(io, "mistake", { text: "a lesson" })
  await onEvent(io, { kind: "pre_tool", cwd: dir, tool: "Edit" }) // no guards yet: refused and recorded
  for (const f of ["plan.json", "mistakes.md", "incidents.json"]) expect(existsSync(join(dir, ".overwatch", f))).toBe(true)
  writeFileSync(join(dir, ".gitignore"), "\n.overwatch/\n")
  expect((await onEvent(io, { kind: "start", cwd: dir })).context).not.toContain(".gitignore") // no vault yet: the old line is fine
  await callTool(io, "vault_init")
  expect((await onEvent(io, { kind: "start", cwd: dir })).context).toContain("hides the spec vault")
  writeFileSync(join(dir, ".gitignore"), "\n.overwatch/*\n!.overwatch/vault/\n")
  expect((await onEvent(io, { kind: "start", cwd: dir })).context).not.toContain(".gitignore")
})
