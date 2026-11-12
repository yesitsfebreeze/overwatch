import { test, expect } from "claude-code/testing"
import { session } from "./test-session.ts"
import { tool } from "./plan.ts"
import { judgeFile, judgeRequest, lastTurn, MAX_JUDGE_TOKENS } from "./guards.ts"

const turn = lastTurn([{ role: "user", content: "Verify the files." }])
const guards = [{ id: "files", question: "Do the files match the requirements?" }]

test("judge budget: aggregate files and questions are bounded without dropping inputs", () => {
  const files = Object.fromEntries(Array.from({ length: 10 }, (_, n) => [`file-${n}`, "x".repeat(12000)]))
  const request = judgeRequest(turn, guards, files)
  expect(request.tokens).toBeGreaterThan(MAX_JUDGE_TOKENS)
  expect(request.error).toContain("Narrow the listed files")
  expect(Object.keys(JSON.parse(request.body).state.project.files)).toHaveLength(10)
  const long = judgeRequest(turn, [{ id: "long", question: "x".repeat(160000) }], {})
  expect(long.error).toBeTruthy()
  expect(JSON.parse(long.body).questions.long.instructions).toContain("x".repeat(160000))
})

test("judge budget: JSON escaping counts and invalid configuration remains bounded", () => {
  expect(judgeRequest(turn, guards, { file: "x".repeat(1000) }, 600).error).toBeUndefined()
  expect(judgeRequest(turn, guards, { file: "\"".repeat(1000) }, 600).error).toBeTruthy()
  for (const limit of [0, -1, NaN, Infinity, "unlimited"])
    expect(judgeRequest(turn, guards, { file: "x".repeat(160000) }, limit).error).toContain("limit 18000")
  const small = judgeRequest(turn, guards, { first: "one", second: "two" }, 1000)
  expect(small.error).toBeUndefined()
  expect(Object.keys(JSON.parse(small.body).questions)).toEqual(["files"])
  expect(JSON.parse(small.body).state.project.files).toEqual({ first: "one", second: "two" })
})

test("judge files visibly mark the existing per-file truncation", () => {
  expect(judgeFile("x".repeat(12000))).toHaveLength(12000)
  expect(judgeFile("x".repeat(13000))).toEndWith("[truncated; 1000 characters omitted]")
})

session("judge budget: oversized evidence blocks without HTTP; smaller evidence can pass", async ($, on) => {
  on("session.cwd", async () => ({ value: "/repo" }) as any)
  on("env.get", async () => ({ value: "test-key" }) as any)
  on("session.messages", async () => ({ value: [{ role: "user", content: "Verify the selected files." }] }) as any)
  let large = true
  on("fs.read", async () => ({ value: large ? "x".repeat(12000) : "verified" }) as any)
  on("classic.Stop", async () => ({}) as any)
  const requests: any[] = []
  on("http.fetch", async (_: any, e: any) => {
    requests.push(e)
    return { value: { ok: true, status: 200, text: JSON.stringify({ answers: { "selected-match-requirements": { noul: 1 } } }) } } as any
  })
  await $.tool.call({ tool: tool("task_add"), titles: ["Verify selected files"] } as any)
  await $.tool.call({ tool: tool("task_complete"), task_id: 1 } as any)
  await $.tool.call({ tool: tool("guard_add"), question: "Do the selected files match the requirements?", files: Array.from({ length: 10 }, (_, n) => `file-${n}.txt`) } as any)
  const stop = () => $.classic.Stop({ stop_hook_active: false } as any)
  const blocked = JSON.stringify(await stop())
  expect(requests.length).toBe(0)
  expect(blocked).toContain("not evaluated")
  expect(blocked).toContain("18000")
  expect(blocked).not.toContain("judged p=")
  const shown = JSON.stringify(await $.tool.call({ tool: tool("plan_show") } as any))
  expect(shown).not.toContain("[upheld]")
  expect(shown).toContain("not evaluated")
  large = false
  const allowed = JSON.stringify(await stop())
  expect(requests.length).toBe(1)
  expect(allowed).not.toContain("block")
  expect(JSON.stringify(await $.tool.call({ tool: tool("plan_show") } as any))).toContain("[upheld]")
})
