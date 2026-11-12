import type { ToolSpec } from "./catalog.ts"

export const TOOL_GROUPS = {
  vault: ["vault_init", "vault_plan", "unit_new", "unit_load", "unit_record", "unit_claim", "unit_release", "unit_next", "unit_verify", "vault_status"],
  prd: ["prd_scan", "prd_next", "prd_brief", "prd_add", "prd_refine", "prd_set", "prd_review", "prd_collect"],
  maintenance: ["loadout", "hygiene_ledger", "disk", "disk_clean"],
  background: ["launch", "launched"],
  changelog: ["changelog"],
} as const
export const TOOL_GROUPS_SPEC: ToolSpec = { description: "List enabled and optional tool groups, their tool names, and how to enable them. Core planning, checks and feedback stay available. Configuration takes effect after restarting the host; no dynamic tool loading." }
const setup = "Set native userConfig.toolGroups or portable OVERWATCH_TOOL_GROUPS to comma-separated groups (or all), then restart the host."
const owner = (name: string) => Object.entries(TOOL_GROUPS).find(([, names]) => (names as readonly string[]).includes(name))?.[0]

/** Static selection. Invalid config leaves core enforcement available and reports the error. */
export function selectTools<T>(all: Record<string, T>, raw?: unknown) {
  const names = Object.keys(TOOL_GROUPS)
  const requested = typeof raw === "string" ? raw.split(",").map((s) => s.trim()).filter(Boolean) : []
  const invalid = requested.filter((n) => !names.includes(n) && n !== "all" && n !== "core")
  const error = raw !== undefined && typeof raw !== "string" || invalid.length
    ? `Invalid tool groups${invalid.length ? ": " + invalid.join(", ").slice(0, 120) : "; expected a comma-separated string"}. Allowed: ${names.join(", ")}, all. ${setup}` : undefined
  const wanted = new Set(error ? [] : requested.includes("all") ? names : requested)
  if (wanted.has("prd")) wanted.add("vault")
  const enabled = names.filter((n) => wanted.has(n))
  const specs = Object.fromEntries(Object.entries(all).filter(([name]) => !owner(name) || wanted.has(owner(name)!))) as Record<string, T>
  const refusal = (name: string) => name in all && !(name in specs)
    ? `${name} is disabled; enable group ${owner(name)}. ${setup}${error ? " " + error : ""}` : undefined
  const report = () => [error, `Enabled: core${enabled.length ? ", " + enabled.join(", ") : ""}.`,
    ...Object.entries(TOOL_GROUPS).map(([group, tools]) => `${wanted.has(group) ? "enabled" : "optional"} ${group}${group === "prd" ? " (includes vault)" : ""}: ${tools.join(", ")}`), setup].filter(Boolean).join("\n")
  return { specs, enabled, error, refusal, report }
}
