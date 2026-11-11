import type { Register } from "claude-code"
import { catalog, declareCatalog, guardCall, takeNotice, TOOL_PREFIX } from "./catalog.ts"
import { COMMAND_TOOLS, countCall, flushCalls, register as commands, takeEvaluation } from "./commands.ts"
import { COMPACTION_TOOLS, compactToolCall, compactTurnEnd, compactionEnabled, register as compaction } from "./compaction.ts"
import { register as followline } from "./followline.ts"
import { ignoreHint, sessionIo } from "./io.ts"
import { PLAN_TOOLS } from "./plan.ts"
import { planReminder, register as plan, startPlan } from "./plan-hooks.ts"

// The plugin's one hooks module. Each part (followline, compaction, commands, plan)
// registers the hooks only it cares about, all matched or on an event of its own. The
// engine takes one unmatched hook per event from a plugin, so the four events several
// parts share (tool.call, turn.complete, prompt.submit, session.start) are hooked here,
// once, and call each part's handler: no part reaches into another.
//
/** Whether this session was already asked to gitignore the state folder (a reload asks again while it still is not). */
let hinted = false
async function takeIgnoreHint($: any): Promise<string> {
  if (hinted) return ""
  hinted = true
  try { return await ignoreHint(await sessionIo($)) } catch { return "" } // never costs the prompt its reminder
}

// Loaded from a watched folder (--plugin-dir, CLAUDE_CODE_PLUGIN_DIRS), a save reloads
// it: `register` runs again and so does `session.start`, which re-declares every tool
// through the catalog (catalog.ts).
export const register: Register = async (on, options) => {
  hinted = false
  const compacting = compactionEnabled(options)
  const cat = catalog({ ...COMMAND_TOOLS, ...PLAN_TOOLS, ...(compacting ? COMPACTION_TOOLS : {}) })
  // Before everything else: a stale call is refused before any part sees it.
  for (const name of Object.keys(cat.specs)) on("tool.call", { tool: TOOL_PREFIX + name }, ($, e, next) => guardCall(cat, $, e, next))
  // followline first, so its $.followline.put exists before a part publishes a slot.
  await followline(on, options)

  // Every tool call: counted for the surface ledger, its result minified by compaction.
  on("tool.call", async ($, e, next) => {
    countCall(e as any)
    return compacting ? compactToolCall($, e, next as any) : next(e)
  })

  // After a turn: the counts go to the ledger, compaction folds when it pays.
  on("turn.complete", async ($, e, next) => {
    void flushCalls($, e)
    if (compacting) await compactTurnEnd($, e)
    return next(e)
  })

  // Beside every prompt, each at most once where it is a one-off: the ask to gitignore
  // .overwatch/, a tool-reload notice (catalog.ts), the surface ledger's rating question
  // (commands.ts), then the plan.
  on("prompt.submit", async ($, e: any, next) => {
    const parts = await Promise.all([takeIgnoreHint($), takeNotice($), takeEvaluation($), planReminder($, e)])
    return next({ ...e, context: [...(e.context ?? []), ...parts.filter(Boolean)] })
  })

  await compaction(on, options)
  await commands(on, options)
  await plan(on, options)

  // Session start, which a reload runs again: declare every part's tools, set up the plan.
  on("session.start", async ($, e, next) => {
    await Promise.all([declareCatalog($, cat), startPlan($, e)])
    return next(e)
  })
}
