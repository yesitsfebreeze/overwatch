import { expect } from "claude-code/testing"
import { session } from "./test-session.ts"
import { tool } from "./plan.ts"

session("guard evaluation: defer open work, reuse exact judgments, and stop spending at the cap", async ($, on) => {
  on("session.id", async () => ({ value: "guard-usage-test" }) as any)
  on("session.cwd", async () => ({ value: "/repo" }) as any)
  on("env.get", async () => ({ value: "test-key" }) as any)
  on("prompt.submit", async (_: any, e: any) => ({ ...e }))
  on("classic.Stop", async () => ({}) as any)
  let usage: any
  on("fs.write", async (_: any, e: any) => { if (String(e.path).replace(/\\/g, "/").endsWith("/usage/guard-usage-test.json")) usage = JSON.parse(e.text); return { value: undefined } as any })
  let evidence = "first"
  let reads = 0
  let requests = 0
  let checks = 0
  let exit = 0
  let invalid = false
  let failed = false
  on("session.messages", async () => {
    reads++
    return { value: [{ role: "user", content: "Verify the evidence file." }] } as any
  })
  on("fs.read", async (_: any, e: any) => {
    if (!String(e.path ?? e).endsWith("evidence.txt")) return { deny: "ENOENT" } as any
    reads++
    return { value: evidence } as any
  })
  on("http.fetch", async () => {
    requests++
    return { value: { ok: !failed, status: failed ? 503 : 200, text: JSON.stringify({ usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 3 }, answers: invalid ? {} : { "evidence-match-requirements": { noul: 0.1 } } }) } } as any
  })
  on("process.run", async (_: any, e: any) => {
    const isCheck = (e.argv ?? e).at(-1) === "guard-probe"
    if (isCheck) checks++
    return { value: { exitCode: isCheck ? exit : 0, stdout: "", stderr: "" } } as any
  })
  const call = (name: string, args: any = {}) => $.tool.call({ tool: tool(name), ...args } as any)
  const stop = () => $.classic.Stop({ stop_hook_active: false } as any)
  const prompt = () => $.prompt.submit({ text: "Continue", origin: { kind: "composer" } } as any)
  await call("task_add", { titles: ["Finish work"] })
  await call("guard_add", { question: "Does the evidence match the requirements?", files: ["evidence.txt"] })
  await call("guard_add", { question: "Does the guard probe pass?", check: "guard-probe" })
  await stop()
  expect([requests, checks, reads]).toEqual([0, 0, 0])
  await call("guard_check")
  expect(checks).toBe(1)
  await call("task_complete", { task_id: 1 })
  await prompt()
  await stop()
  await stop()
  expect(requests).toBe(1)
  expect(usage.attempts).toBe(1)
  expect(checks).toBe(3)
  evidence = "changed"
  await stop()
  expect(requests).toBe(2)
  await prompt()
  await stop()
  expect(requests).toBe(3)
  invalid = true
  evidence = "invalid response"
  await stop()
  await stop()
  expect(requests).toBe(5)
  invalid = false
  failed = true
  evidence = "transport failure"
  await stop()
  await stop()
  expect(requests).toBe(7)
  expect([usage.attempts, usage.successes, usage.failures]).toEqual([7, 3, 4])
  expect(usage.usage.input_tokens).toEqual({ total: 49, reported: 7, unknown: 0 })
  expect(usage.usage.cache_read_input_tokens.total).toBe(21)
  failed = false
  await prompt()
  for (let n = 1; n <= 8; n++) {
    evidence = `evidence-${n}`
    exit = n
    expect(JSON.stringify(await stop())).toContain("block")
  }
  const before = [requests, checks, reads]
  expect(JSON.stringify(await stop())).toContain("unverified")
  expect([requests, checks, reads]).toEqual(before)
  await call("guard_check")
  expect(checks).toBe(before[1] + 1)
  await prompt()
  await stop()
  expect(requests).toBe(before[0] + 1)
  expect(checks).toBe(before[1] + 2)
})
