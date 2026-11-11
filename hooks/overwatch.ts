import type { Register } from "claude-code"
import { COMPONION_TOOLS, componionEnabled, register as componion } from "./componion.ts"
import { register as followline } from "./followline.ts"
import { PLAN_TOOLS, register as tasksitter, startTasksitter } from "./tasksitter.ts"
import { COMMAND_TOOLS, register as tools } from "./tools.ts"
import { catalog, declareCatalog, guardCall, TOOL_PREFIX } from "./version.ts"

// One hooks module per plugin. Loaded from a watched folder (--plugin-dir,
// CLAUDE_CODE_PLUGIN_DIRS), a save reloads it: `register` runs again and so does
// `session.start`, which re-declares every tool through the catalog (version.ts).
export const register: Register = async (on, options) => {
  const cat = catalog({ ...COMMAND_TOOLS, ...PLAN_TOOLS, ...(componionEnabled(options) ? COMPONION_TOOLS : {}) })
  // Before the parts' own hooks: a stale call is refused before any part sees it.
  for (const name of Object.keys(cat.specs)) on("tool.call", { tool: TOOL_PREFIX + name }, ($, e, next) => guardCall(cat, $, e, next))
  // followline first, so its $.followline.put exists before componion publishes a slot.
  await followline(on, options)
  await componion(on, options)
  await tools(on, options)
  await tasksitter(on, options)
  // The engine allows one unmatched session.start per plugin: it declares every part's tools.
  on("session.start", async ($, e, next) => {
    await Promise.all([declareCatalog($, cat), startTasksitter($, e)])
    return next(e)
  })
}
