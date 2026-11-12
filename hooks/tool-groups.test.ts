import { test, expect } from "claude-code/testing"
import { session } from "./test-session.ts"
import { selectTools, TOOL_GROUPS_SPEC, TOOL_GROUPS } from "./tool-groups.ts"
import { COMMAND_TOOLS } from "./commands.ts"
import { PLAN_TOOLS, EMPTY, CLEAN, FRESH, gateReason, stopVerdict } from "./plan.ts"
import { VAULT_TOOLS } from "./vault.ts"
import { CHANGELOG_TOOLS } from "./changelog.ts"

const all = { ...COMMAND_TOOLS, ...PLAN_TOOLS, ...VAULT_TOOLS, ...CHANGELOG_TOOLS, tool_groups: TOOL_GROUPS_SPEC }
test("tool groups: core by default, all restores everything, PRD includes vault, invalid config keeps enforcement", () => {
  const core = selectTools(all)
  expect(core.specs.mistakes).toBeDefined()
  expect(Object.keys(PLAN_TOOLS).every((n) => n in core.specs)).toBe(true)
  for (const names of Object.values(TOOL_GROUPS)) for (const n of names) expect(core.specs[n]).toBeUndefined()
  expect(Object.keys(selectTools(all, "all").specs)).toEqual(Object.keys(all))
  expect(selectTools(all, "prd").enabled).toEqual(["vault", "prd"])
  expect(selectTools(all, "background,background").enabled).toEqual(["background"])
  expect(selectTools(all, "wrong").error).toContain("Invalid tool groups")
  expect(selectTools(all, 1).specs.guard_add).toBeDefined()
  expect(core.refusal("disk")).toContain("enable group maintenance")
  expect(core.report()).toContain("restart")
})

test("three-tool small task has identical core enforcement with default and full catalogs", () => {
  const outputs: unknown[] = []
  for (const setting of ["", "all"]) {
    const selected = selectTools(all, setting).specs as typeof all
    let plan = selected.task_add.run!(EMPTY, { titles: ["Finish a small task"] }).state
    expect(gateReason(plan)).toBeTruthy()
    plan = selected.guard_add.run!(plan, { question: "Does the finished task satisfy the request?", check: "bun test" }).state
    expect(gateReason(plan)).toBeUndefined()
    plan = selected.task_complete.run!(plan, { task_id: 1 }).state
    outputs.push(stopVerdict(plan, [{ ...plan.guards[0], met: true }], CLEAN, FRESH).verdict)
  }
  expect(outputs[0]).toEqual(outputs[1])
})

session("native default catalog explains optional groups and refuses disabled stale calls", async ($) => {
  const result: any = await $.tool.call({ tool: "mcp__overwatch__tool_groups" } as any)
  expect(JSON.stringify(result)).toContain("optional maintenance")
  const disabled: any = await $.tool.call({ tool: "mcp__overwatch__disk" } as any)
  expect(JSON.stringify(disabled)).toContain("enable group maintenance")
})
