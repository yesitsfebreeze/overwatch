import { test, expect } from "claude-code/testing"
import { session } from "./test-session.ts"
import { face, gauge, line, slotOrder } from "./followline.ts"

test("gauge: percent centred across fill and trough, base16 slots only", () => {
  expect(gauge(40)).toEqual([
    { text: "   4", color: "ansi256(0)", backgroundColor: "ansi256(8)" },
    { text: "0%    ", color: "ansi256(8)", backgroundColor: "ansi256(18)" },
  ])
  expect(gauge(0).map(s => s.text).join("")).toBe("    0%    ")
  expect(gauge(100).map(s => s.text)).toEqual(["   100%   "])
  // componion: 20% kept, 30% folded away, the rest free, 60% saved share as text
  expect(gauge(60, 10, 20, 30).map(s => [s.text, s.backgroundColor])).toEqual([["  ", "ansi256(8)"], [" 60", "ansi256(3)"], ["%    ", "ansi256(18)"]])
})

test("five faces by mean, slots in setting order, unlisted left out", () => {
  expect([0, 20, 40, 60, 80, 100].map(face)).toEqual([":(", ":/", ":|", ":)", ":D", ":D"])
  const slots = { orly: { id: "orly", pct: 100 }, kern: { id: "kern", pct: 40, color: "yellow" as const }, x: { id: "x", pct: 0 } }
  const segs = line(slots, ["componion", "kern", "orly"])
  expect(segs.map(s => s.text).join("")).toBe(":) kern    40%     orly    100%   ")
  expect(segs[1]).toEqual({ text: " kern ", color: "yellow" })
  expect(line({}, ["kern"])).toEqual([])
  const d = line({ orly: { id: "orly", pct: 100, detail: "✓ compiles" } }, ["orly"])
  expect(d.at(-1)).toEqual({ text: " ✓ compiles", dimColor: true })
})

// A producer: publishes its slots on turn.complete, as kern, componion and orly do.
const producer = {
  name: "producer",
  register(on: any) {
    on("turn.complete", async ($: any, e: any, next: any) => {
      await $.followline.put({ id: "kern", pct: 60 })
      await $.followline.put({ id: "plan", pct: 100 })
      await $.followline.put({ id: "kern", pct: 80 })
      return next(e)
    })
  },
}

session("a producer's put draws the line above the prompt", { plugins: [producer] }, async ($, on) => {
  on("turn.complete", async () => ({ text: "" }))
  on("clock.after", async () => ({ value: { cancel() {} } }) as any)
  on("session.usage", async () => ({ value: { context: { tokens: 0 } } }) as any)
  await $.turn.complete({ turnId: "t1", answer: "", reason: "end_turn" } as any)
  const tree = JSON.stringify(await $.ui.render({ surface: "terminal", component: "AbovePrompt", props: { hasSurvey: false, bodyColumns: 80 } } as any))
  for (const t of [":D", " kern ", " plan ", "80%", "100%"]) expect(tree).toContain(t)
  expect(tree).not.toContain("60%")
})

