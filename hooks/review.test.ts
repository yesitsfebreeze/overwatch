import { test, expect } from "claude-code/testing"
import { CLEAN, due, newWork, skillRan } from "./plan.ts"
import { editPaths, lineChanges, measured, trackEdit } from "./review.ts"
import { memIo } from "./io.ts"
import type { Verify } from "../types/index.d.ts"

function harness(files: Record<string, string> = {}) {
  const io = memIo(files, "/repo")
  let state: Verify = CLEAN
  return {
    io, get state() { return state }, set state(v: Verify) { state = v },
    edit: (path: string, text: string, outcome: "ok" | "error" | "throw" | "partial" = "ok") =>
      trackEdit(io, { file_path: path, content: text }, async () => {
        if (outcome === "ok" || outcome === "partial") files[path] = text
        if (outcome === "throw") throw new Error("write failed")
        return { isError: outcome === "error" || outcome === "partial" }
      }, async (before, after, failed) => { state = measured(state, before, after, failed) }),
  }
}

test("five one-line writes count five, and a whole-file one-line change counts one", async () => {
  const h = harness()
  for (let i = 0; i < 5; i++) await h.edit(`/repo/f${i}`, "x\n")
  expect(h.state.lines).toBe(5)
  expect(due(h.state)).toEqual([])
  const text = Array.from({ length: 1000 }, (_, i) => `line ${i}\n`).join("")
  const f = harness({ "/repo/file": text })
  await f.edit("/repo/file", text.replace("line 500", "changed 500"))
  expect(f.state.lines).toBe(1)
})

test("repeated edits count the net change and a revert removes it", async () => {
  const h = harness({ "/repo/f": "original\n" })
  for (let i = 0; i < 60; i++) await h.edit("/repo/f", `value ${i}\n`)
  expect(h.state.lines).toBe(1)
  await h.edit("/repo/f", "original\n")
  expect(h.state.lines).toBe(0)
  expect(due(h.state)).toEqual([])
})

test("failed, thrown and unchanged writes add nothing; partial writes still count", async () => {
  const h = harness({ "/repo/f": "old\n" })
  await h.edit("/repo/f", "old\n")
  await h.edit("/repo/f", "new\n", "error")
  await expect(h.edit("/repo/f", "new\n", "throw")).rejects.toThrow("write failed")
  expect(h.state).toEqual(CLEAN)
  await h.edit("/repo/f", "new\n", "partial")
  expect(h.state.lines).toBe(1)
})

test("a denied write does not create review work", async () => {
  const io = memIo({ "/repo/f": "old\n" }, "/repo")
  let state = CLEAN
  const result = await trackEdit(io, { file_path: "/repo/f", content: "new\n" }, async () => ({ deny: "permission" }),
    async (before, after, failed) => { state = measured(state, before, after, failed) })
  expect(result).toEqual({ deny: "permission" })
  expect(state).toEqual(CLEAN)
})

test("10/50 net lines keep gates and independent review baselines", async () => {
  const h = harness()
  const text = (n: number) => Array.from({ length: n }, (_, i) => `${i}\n`).join("")
  await h.edit("/repo/f", text(9)); expect(due(h.state)).toEqual([])
  await h.edit("/repo/f", text(10)); expect(due(h.state)).toEqual(["/simplify"])
  await h.edit("/repo/f", text(50)); expect(due(h.state)).toEqual(["/code-review", "/simplify"])
  h.state = skillRan(h.state, "review")
  await h.edit("/repo/f", text(53))
  expect(h.state.unreviewed).toBe(3)
  expect(due(h.state)).toEqual(["/simplify"])
  h.state = newWork(h.state)
  expect(due(h.state)).toEqual(["/simplify"])
  h.state = skillRan(h.state, "simplify")
  expect(h.state.lines).toBe(0)
  expect(h.state.unreviewed).toBe(3)
  h.state = newWork(h.state)
  await h.edit("/repo/f", text(56))
  expect(h.state.lines).toBe(3)
  expect(h.state.unreviewed).toBe(6)
  h.state = CLEAN
  await h.edit("/repo/f", text(57))
  expect(h.state.lines).toBe(1)
})

test("preexisting content is the baseline; distant changes, newlines and large rewrites", () => {
  expect(lineChanges("a\nb\nc\nd\ne\n", "A\nb\nc\nd\nE\n")).toBe(2)
  expect(lineChanges("a\n", "a")).toBe(1)
  expect(lineChanges("", "")).toBe(0)
  expect(lineChanges("a\n".repeat(10000), "b\n".repeat(10000))).toBe(50)
  expect(lineChanges("a\nb\nc\n", "a\nc\n")).toBe(1)
})

test("unreadable and unknown targets are explicit, conservative, and nonadditive", () => {
  let v = measured(CLEAN, { f: undefined }, { f: "x" })
  for (let i = 0; i < 10; i++) v = measured(v, {}, {})
  expect(v.lines).toBe(0)
  expect(v.unknown).toEqual({ review: true, simplify: true })
  expect(due(v)).toEqual(["/code-review", "/simplify"])
  expect(due(newWork(skillRan(skillRan(v, "review"), "simplify")))).toEqual([])
  expect(measured(CLEAN, {}, {}, true)).toEqual(CLEAN)
  expect(due(measured(CLEAN, { f: "readable before" }, { f: undefined }, true))).toEqual(["/code-review", "/simplify"])
})

test("known edit targets normalize relative, Windows and nested paths", () => {
  expect(editPaths({ path: "f", edits: [{ old: "a", new: "b" }] }, "/repo")).toEqual(["/repo/f"])
  expect(editPaths({ items: [{ path: "./a/../f" }, { file_path: "/repo/f" }] }, "/repo")).toEqual(["/repo/f"])
  expect(editPaths({ file_path: "D:\\repo\\f" }, "D:\\repo")).toEqual(["D:/repo/f"])
})

test("bounded diff matches an independent LCS reference on short repeated lines", () => {
  const sequences: string[][] = [[]]
  for (let n = 1; n <= 4; n++) for (let bits = 0; bits < 2 ** n; bits++)
    sequences.push(Array.from({ length: n }, (_, i) => bits & (1 << i) ? "a\n" : "b\n"))
  for (const a of sequences) for (const b of sequences) {
    const lcs = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0))
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      lcs[i][j] = a[i - 1] === b[j - 1] ? lcs[i - 1][j - 1] + 1 : Math.max(lcs[i - 1][j], lcs[i][j - 1])
    expect(lineChanges(a.join(""), b.join(""))).toBe(Math.max(a.length, b.length) - lcs[a.length][b.length])
  }
})
