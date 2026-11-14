import type { Register } from "claude-code"
import { catalog, declareCatalog, guardCall, takeNotice, TOOL_PREFIX } from "./catalog.ts"
import { COMMAND_TOOLS, countCall, flushCalls, register as commands, takeEvaluation } from "./commands.ts"
import { COMPACTION_TOOLS, compactToolCall, compactTurnEnd, compactionEnabled, register as compaction } from "./compaction.ts"
import { register as followline } from "./followline.ts"
import { FULL_PERCENT, fullNotice } from "./gardener.ts"
import { ignoreHint, sessionIo } from "./io.ts"
import { PLAN_TOOLS } from "./plan.ts"
import { VAULT_TOOLS } from "./vault.ts"
import { CHANGELOG_TOOLS } from "./changelog.ts"
import { planReminder, register as plan, startPlan } from "./plan-hooks.ts"
import { syncAutomatic, syncNotice } from "./sync.ts"

let syncHint = ""
const takeSyncHint = () => { const hint = syncHint; syncHint = ""; return hint }

// The plugin's one hooks module. Each part (followline, compaction, commands, plan)
// registers its own hooks, all matched or on an event of its own. The engine takes one
// unmatched hook per event from a plugin, so the four shared events (tool.call,
// turn.complete, prompt.submit, session.start) are hooked here, once, and call each
// part's handler: no part reaches into another.

/** Whether this session was already asked to gitignore the state folder; a reload asks again. */
let hinted = false
async function takeIgnoreHint($: any): Promise<string> {
  if (hinted) return ""
  hinted = true
  try { return await ignoreHint(await sessionIo($)) } catch { return "" } // never costs the prompt its reminder
}

const DISK_CHECK_MS = 5 * 60_000
let diskAt = 0
let diskTold = false
/** The gardener's ask to free space: once each time the disk crosses `full` percent, one `df` at most every DISK_CHECK_MS. */
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

// From a watched folder (--plugin-dir, CLAUDE_CODE_PLUGIN_DIRS) a save reruns `register`
// and `session.start`, which re-declares every tool (catalog.ts).
export const register: Register = async (on, options) => {
  hinted = false
  syncHint = ""
  diskAt = 0
  diskTold = false
  const compacting = compactionEnabled(options)
  const all = { ...COMMAND_TOOLS, ...PLAN_TOOLS, ...VAULT_TOOLS, ...CHANGELOG_TOOLS, ...(compacting ? COMPACTION_TOOLS : {}) }
  const full = typeof options.diskFullPercent === "number" ? options.diskFullPercent : FULL_PERCENT
  const cat = catalog(all)
  // First: a stale call is refused before any part sees it.
  for (const name of Object.keys(all)) on("tool.call", { tool: TOOL_PREFIX + name }, ($, e, next) => {
    return guardCall(cat, $, e, next)
  })
  // followline before the other parts, so its $.followline.put exists before a part publishes a slot.
  await followline(on, options)

  // Every call is counted for the surface ledger and its result minified. A main-thread
  // result also carries the gardener's ask when the disk filled up mid-turn.
  on("tool.call", async ($, e, next) => {
    countCall(e as any)
    let r: any = await (compacting ? compactToolCall($, e, next as any) : next(e))
    // An MCP result is text or content blocks; overwatch's paged tools build objects.
    if (String((e as any).tool).startsWith(TOOL_PREFIX) && r?.result && typeof r.result === "object" && !Array.isArray(r.result))
      r = { ...r, result: JSON.stringify(r.result) }
    const notice = (e as any).agentId || r?.deny !== undefined ? "" : await takeDiskNotice($, full)
    return notice ? { ...r, context: [...(r?.context ?? []), notice] } : r
  })

  on("turn.complete", async ($, e, next) => {
    void flushCalls($, e)
    if (compacting) await compactTurnEnd($, e)
    return next(e)
  })

  // Beside every prompt: the one-off notices, then the plan.
  on("prompt.submit", async ($, e: any, next) => {
    const parts = await Promise.all([takeSyncHint(), takeIgnoreHint($), takeDiskNotice($, full), takeNotice($), takeEvaluation($), planReminder($, e)])
    return next({ ...e, context: [...(e.context ?? []), ...parts.filter(Boolean)] })
  })

  await compaction(on, options)
  await commands(on, options)
  await plan(on, options)

  on("session.start", async ($, e, next) => {
    await Promise.all([declareCatalog($, cat), startPlan($, e), sessionIo($).then((at) => syncAutomatic(at, { reason: "session.start" })).then((r) => { syncHint = syncNotice(r) }, (err) => { syncHint = "[overwatch] synchronization failed: " + String(err?.message ?? err) })])
    return next(e)
  })
}
