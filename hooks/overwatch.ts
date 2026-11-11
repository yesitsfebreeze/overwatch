import type { Register } from "claude-code"
import { catalog, declareCatalog, guardCall, takeNotice, TOOL_PREFIX } from "./catalog.ts"
import { COMMAND_TOOLS, countCall, flushCalls, register as commands, takeEvaluation } from "./commands.ts"
import { COMPACTION_TOOLS, compactToolCall, compactTurnEnd, compactionEnabled, register as compaction } from "./compaction.ts"
import { register as followline } from "./followline.ts"
import { FULL_PERCENT, fullNotice } from "./gardener.ts"
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

/** How often the free space is read (one `df`), and whether this crossing of the threshold was already announced. */
const DISK_CHECK_MS = 5 * 60_000
let diskAt = 0
let diskTold = false
/** The gardener's ask to free space: once each time the disk crosses `full` percent, checked at most every DISK_CHECK_MS. */
async function takeDiskNotice($: any, full: number): Promise<string> {
  if (!(full > 0) || Date.now() - diskAt < DISK_CHECK_MS) return ""
  diskAt = Date.now()
  try {
    const notice = await fullNotice(await sessionIo($), full)
    const first = !!notice && !diskTold
    diskTold = !!notice
    return first ? notice : ""
  } catch { return "" } // never costs a prompt or a tool result
}

// Loaded from a watched folder (--plugin-dir, CLAUDE_CODE_PLUGIN_DIRS), a save reloads
// it: `register` runs again and so does `session.start`, which re-declares every tool
// through the catalog (catalog.ts).
export const register: Register = async (on, options) => {
  hinted = false
  diskAt = 0
  diskTold = false
  const full = typeof options.diskFullPercent === "number" ? options.diskFullPercent : FULL_PERCENT
  const compacting = compactionEnabled(options)
  const cat = catalog({ ...COMMAND_TOOLS, ...PLAN_TOOLS, ...(compacting ? COMPACTION_TOOLS : {}) })
  // Before everything else: a stale call is refused before any part sees it.
  for (const name of Object.keys(cat.specs)) on("tool.call", { tool: TOOL_PREFIX + name }, ($, e, next) => guardCall(cat, $, e, next))
  // followline first, so its $.followline.put exists before a part publishes a slot.
  await followline(on, options)

  // Every tool call: counted for the surface ledger, its result minified by compaction. A main-thread
  // result also carries the gardener's ask when the disk filled up mid-turn (a build, a download).
  on("tool.call", async ($, e, next) => {
    countCall(e as any)
    const r: any = await (compacting ? compactToolCall($, e, next as any) : next(e))
    const notice = (e as any).agentId || r?.deny !== undefined ? "" : await takeDiskNotice($, full)
    return notice ? { ...r, context: [...(r?.context ?? []), notice] } : r
  })

  // After a turn: the counts go to the ledger, compaction folds when it pays.
  on("turn.complete", async ($, e, next) => {
    void flushCalls($, e)
    if (compacting) await compactTurnEnd($, e)
    return next(e)
  })

  // Beside every prompt, each at most once where it is a one-off: the ask to gitignore
  // .overwatch/, the gardener's ask when the disk is nearly full, a tool-reload notice (catalog.ts), the surface ledger's rating question
  // (commands.ts), then the plan.
  on("prompt.submit", async ($, e: any, next) => {
    const parts = await Promise.all([takeIgnoreHint($), takeDiskNotice($, full), takeNotice($), takeEvaluation($), planReminder($, e)])
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
