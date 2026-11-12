import { test, expect } from "claude-code/testing"
import { catalog, declareCatalog, guardCall, hash, misfit, TOOL_PREFIX } from "./catalog.ts"

const V1 = { rate: { description: "Rate a tool.", properties: { name: { type: "string" }, verdict: { type: "string", enum: ["useful", "dead"] } }, required: ["name", "verdict"] } }

test("version: a fingerprint ignores key order, a changed schema changes the version", () => {
  const swapped = { rate: { required: ["name", "verdict"], properties: { verdict: { enum: ["useful", "dead"], type: "string" }, name: { type: "string" } }, description: "Rate a tool." } }
  expect(catalog(V1).version).toBe(catalog(swapped).version)
  const v2 = catalog({ rate: { ...V1.rate, properties: { ...V1.rate.properties, reason: { type: "string" } }, required: ["name", "verdict", "reason"] } })
  expect(v2.version).not.toBe(catalog(V1).version)
  expect(hash("a")).toMatch(/^[0-9a-f]{8}$/)
})

test("stale calls: missing, unknown, mistyped or out-of-enum arguments are refused with the current schema", () => {
  const c = catalog(V1)
  const call = (e: Record<string, unknown>) => c.refusal({ tool: TOOL_PREFIX + "rate", tool_use_id: "t", agentId: "a", ...e })
  expect(call({ name: "x", verdict: "dead" })).toBeUndefined()
  expect(call({ verdict: "dead" })).toContain("missing required `name`")
  expect(call({ name: "x", verdict: "dead", why: "old arg" })).toContain("unknown argument `why`")
  expect(call({ name: 3, verdict: "dead" })).toContain("`name` must be string")
  expect(call({ name: "x", verdict: "meh" })).toContain("must be one of useful | dead")
  expect(call({ verdict: "dead" })).toContain('"required":["name","verdict"]')
  expect(c.refusal({ tool: TOOL_PREFIX + "gone" })).toContain("is gone")
  expect(misfit(V1.rate, { name: "x", verdict: "dead", consent: "y" })).toBeUndefined()
})

test("reload: the diff names changed, added and removed tools; nothing when unchanged", () => {
  const c1 = catalog({ ...V1, keep: { description: "Same." }, old: { description: "Old." } })
  const c2 = catalog({ rate: { ...V1.rate, description: "Rate a tool, now with reasons." }, keep: { description: "Same." }, fresh: { description: "New." } })
  const notice = c2.diff({ version: c1.version, tools: c1.tools })!
  expect(notice).toContain(`v${c1.version} → v${c2.version}`)
  expect(notice).toContain(`changed ${TOOL_PREFIX}rate`)
  expect(notice).toContain(`added ${TOOL_PREFIX}fresh`)
  expect(notice).toContain(`removed ${TOOL_PREFIX}old`)
  expect(notice).not.toContain("keep")
  expect(c2.diff({ version: c2.version, tools: c2.tools })).toBeUndefined()
  expect(c2.diff(undefined)).toBeUndefined()
})

/** A `$` with just the state and tool registry the catalog touches. */
function fake$() {
  const state = new Map<string, unknown>()
  const registered: any[] = []
  return {
    registered,
    state: { get: async (k: any) => ({ value: state.get(k.key) }), set: async (k: any, v: unknown) => void state.set(k.key, v) },
    tool: { register: async (t: any) => (registered.push(t), { tool: TOOL_PREFIX + t.name }) },
  }
}

test("reload in a session: re-declaring a changed catalog re-registers every tool and leaves one notice, then the stamp only", async () => {
  const $ = fake$()
  const before = catalog({ ...V1, gone_tool: { description: "Old." } })
  expect(await declareCatalog($, before)).toBeUndefined() // the first start has nothing to compare with
  const after = catalog({ rate: { ...V1.rate, description: "Rate a tool, now with reasons." } })
  const notice = await declareCatalog($, after) // the reload
  expect(notice).toContain(`changed ${TOOL_PREFIX}rate`)
  expect(notice).toContain(`removed ${TOOL_PREFIX}gone_tool`)
  expect($.registered.at(-1).description).toContain(`(v${after.tools.rate})`)
  const answer = async () => ({ result: "done" })
  const call = { tool: TOOL_PREFIX + "rate", name: "x", verdict: "dead" }
  const first: any = await guardCall(after, $, call, answer)
  const second: any = await guardCall(after, $, call, answer)
  expect(first.result).toBe("done") // the result itself is never touched
  expect(first.context).toEqual([notice, after.stamp])
  expect(second.context).toEqual([after.stamp])
  // A refused call does not swallow a pending notice.
  await declareCatalog($, before)
  await declareCatalog($, after)
  expect(await guardCall(after, $, call, async () => ({ deny: "no" }))).toEqual({ deny: "no" })
  expect((await guardCall(after, $, call, answer) as any).context[0]).toContain("reloaded")
  const stale: any = await guardCall(after, $, { tool: TOOL_PREFIX + "rate", name: "x" }, answer)
  expect(stale.deny).toContain("stale or invalid call")
})

test("session: an overwatch tool result carries the stamp; a stale call never reaches the tool", async ($, on) => {
  on("session.cwd" as any, async () => ({ value: "/nonexistent-overwatch-test" }) as any)
  const ok: any = await $.tool.call({ tool: TOOL_PREFIX + "checks" } as any)
  expect(JSON.stringify(ok.context)).toContain("overwatch tools v")
  const stale: any = await $.tool.call({ tool: TOOL_PREFIX + "rate", name: "x" } as any)
  expect(JSON.stringify(stale)).toContain("stale or invalid call")
})
