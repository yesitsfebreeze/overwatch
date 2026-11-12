import { expect, test } from "bun:test"
import { join } from "node:path"

const probe = (setting: string) => {
  const source = `import { TOOLS, callTool, onEvent } from ${JSON.stringify(join(import.meta.dir, "core.ts"))};
import { memIo } from ${JSON.stringify(join(import.meta.dir, "../hooks/io.ts"))};
const calls=[]; const io=memIo({},'/group-fixture',async(argv)=>{calls.push(argv[0]);return {code:0,stdout:'',stderr:''}});
const start=await onEvent(io,{kind:'start',cwd:io.cwd});
await callTool(io,'task_add',{titles:['Small change']});
await callTool(io,'guard_add',{question:'Does the small change pass verification?',check:'probe-tests'});
await callTool(io,'task_complete',{task_id:1});
const stopped=await onEvent(io,{kind:'stop',cwd:io.cwd});
const discovery=await callTool(io,'tool_groups');
const disabled=TOOLS.launch?null:await callTool(io,'launch',{command:'must not run'});
console.log(JSON.stringify({names:Object.keys(TOOLS),start,calls,stopped,discovery,disabled,plan:JSON.parse(io.files['/group-fixture/.overwatch/plan.json']).plan}));`
  const child = Bun.spawnSync([process.execPath, "-e", source], { env: { ...process.env, OVERWATCH_TOOL_GROUPS: setting, OVERWATCH_PROJECT: "/group-fixture" } })
  expect(child.exitCode).toBe(0)
  return JSON.parse(child.stdout.toString())
}

test("portable static groups preserve the small core task and suppress disabled maintenance", () => {
  const core = probe(""), full = probe("all"), bad = probe("typo")
  expect(core.plan).toEqual(full.plan)
  expect(core.stopped).toEqual({})
  expect(full.stopped).toEqual({})
  expect(core.names).not.toContain("launch")
  expect(core.names).toContain("mistakes")
  expect(full.names).toContain("launch")
  expect(core.calls).not.toContain("df")
  expect(full.calls).toContain("df")
  expect(core.disabled.text).toContain("enable group background")
  expect(bad.start.context).toContain("Invalid tool groups")
  expect(bad.stopped).toEqual({})
})

test("MCP tools/list advertises only the configured groups", () => {
  const result = (setting: string) => {
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "../bin/cli.ts"), "mcp"], {
      env: { ...process.env, OVERWATCH_TOOL_GROUPS: setting },
      stdin: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n"),
    })
    expect(child.exitCode).toBe(0)
    return JSON.parse(child.stdout.toString()).result.tools
  }
  const core = result(""), full = result("all")
  expect(core.some((t: any) => t.name === "tool_groups")).toBe(true)
  expect(core.some((t: any) => t.name === "disk")).toBe(false)
  expect(full.some((t: any) => t.name === "disk")).toBe(true)
  expect(JSON.stringify(core).length).toBeLessThan(JSON.stringify(full).length)
})
