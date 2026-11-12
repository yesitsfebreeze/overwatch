import { test, expect } from "claude-code/testing"
import { memIo } from "./io.ts"
import { learned, checklist, mistake, mistakesPage, status } from "./surface.ts"
import { session } from "./test-session.ts"

test("mistakes: routine lessons and checks have total budgets and whole commands", async () => {
  const raw = "# History\n" + Array.from({ length: 100 }, (_, i) => `- lesson ${i} ${'"\\'.repeat(1000)} (2026-11-01)\n`).join("")
  const huge = "npm run test -- " + "argument ".repeat(3000)
  const io = memIo({ "/repo/.overwatch/mistakes.md": raw, "/repo/.overwatch/checks.json": JSON.stringify({ checks: [huge, "bun test"], tiers: { [huge]: "milestone", "bun test": "unit" } }) }, "/repo")
  expect(JSON.stringify(await learned(io)).length).toBeLessThanOrEqual(4096)
  const out = await checklist(io)
  expect(JSON.stringify({ result: out }).length).toBeLessThanOrEqual(8000)
  expect(out).toContain("bun test")
  expect(out).not.toContain("npm run test --")
  expect(out).toContain(".overwatch/checks.json")
  for (const cap of [496, 984]) {
    const small = await checklist(io, undefined, cap)
    expect(JSON.stringify({ result: small }).length).toBeLessThanOrEqual(cap)
    expect(small).not.toContain("npm run test --")
  }
  expect(await checklist(io, "fast")).not.toContain("bun test")
  expect(io.files["/repo/.overwatch/mistakes.md"]).toBe(raw)
})

test("mistakes: exact pages reconstruct legacy history and reject stale continuation", async () => {
  const raw = '# Legacy 😀\n' + '- repeated "\\ lesson (2020-01-01)\n'.repeat(300)
  const io = memIo({ "/repo/.overwatch/mistakes.md": raw }, "/repo")
  for (const cap of [496, 984, 7800]) {
    let page = await mistakesPage(io, {}, cap), joined = ""
    while (true) {
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(cap)
      joined += page.text
      if (page.next_offset === null) break
      page = await mistakesPage(io, { id: page.id, offset: page.next_offset }, cap)
    }
    expect(joined).toBe(raw)
  }
  expect(io.files["/repo/.overwatch/mistakes.md"]).toBe(raw)
  await expect(mistakesPage(io, { offset: -1 })).rejects.toThrow()
  await expect(mistakesPage(io, { limit: 0 })).rejects.toThrow()
  const first = await mistakesPage(io)
  await mistake(io, "new lesson")
  await expect(mistakesPage(io, { id: first.id, offset: 1 })).rejects.toThrow("changed")
})

session("native mistakes reader returns structured exact history pages", async ($, on) => {
  const raw = "# Legacy\n- native repeated line\n".repeat(500)
  on("session.cwd", async () => ({ value: "/repo" }) as any)
  on("fs.read", async (_: any, e: any) => String(e.path ?? e).endsWith("mistakes.md") ? { value: raw } as any : { deny: "ENOENT" } as any)
  let joined = "", args: any = {}
  while (true) {
    const result: any = await $.tool.call({ tool: "mcp__overwatch__mistakes", ...args } as any)
    const page = result.result
    expect(typeof page).toBe("object")
    joined += page.text
    if (page.next_offset === null) break
    args = { id: page.id, offset: page.next_offset }
  }
  expect(joined).toBe(raw)
})

test("mistakes: normalized duplicate writes preserve every existing byte", async () => {
  const raw = "# Legacy\n- use   the built binary (2020-01-01)\n- use the built binary (2021-01-01)\n"
  const io = memIo({ "/repo/.overwatch/mistakes.md": raw }, "/repo")
  expect(await mistake(io, "  use\n the\t built binary ")).toContain("already recorded")
  expect(io.files["/repo/.overwatch/mistakes.md"]).toBe(raw)
  await mistake(io, "different\n lesson")
  expect(io.files["/repo/.overwatch/mistakes.md"]).toStartWith(raw)
  expect((await learned(io)).match(/use\s+the built binary/g)?.length).toBe(1)
})

test("mistakes: legacy multiline instructions are omitted whole and remain retrievable", async () => {
  const raw = "# Legacy\n- Never run this without\n  a fresh review (2020-01-01)\n- ordinary lesson (2020-01-01)\n"
  const io = memIo({ "/repo/.overwatch/mistakes.md": raw }, "/repo")
  const out = await learned(io)
  expect(out).not.toContain("Never run this without")
  expect(out).toContain("Some records omitted")
  expect((await mistakesPage(io)).text).toBe(raw)
  expect(await mistake(io, "Never run this without a fresh review")).toContain("already recorded")
  expect(io.files["/repo/.overwatch/mistakes.md"]).toBe(raw)
  expect(await status(io)).toContain("mistakes: 2 recorded")
})
