// The wave plan: spec notes to rows and waves (computePlan), the two projections (Plan Tasks.md
// and Plan Data.json's shape), and the report vault_plan prints. Pure over `Spec[]`: writing
// lives in vault.ts, so this module needs no `Io`.
import { cmp } from "./io.ts"
import { str, strings } from "./note.ts"
import type { Spec } from "./vault.ts"

/** A claim older than this is stale and may be taken over with an explicit takeover. */
const CLAIM_TTL_MS = 15 * 60_000
const PRIO_MARK: Record<string, string> = { highest: "🔺", high: "⏫", medium: "🔼", low: "🔽", lowest: "⏬" }
/** Friction units per status (kit Plan.md): proposed 3, partial 2, target or deferred 1. */
const STATUS_EFFORT: Record<string, number> = { proposed: 3, partial: 2, target: 1, deferred: 1 }

/** The path spelling comparisons start from: separators and trailing slashes normalize away, case is kept. */
export const slash = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "")
/** The one path rule scope checks share: `slash`, a leading `./`, and Windows' case fold. */
export const normPath = (p: string) => slash(p).replace(/^\.\//, "").toLowerCase()
/** A path covers itself and everything under it, so `src/a` and `src/a/lex.ts` overlap. */
const coversPath = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

export type Row = {
  name: string; path: string; category: string; status: string; owner: string; since: string; blocked: string
  effort: number; start: number; end: number; wave: number; after: string[]; paths: string[]
  held: string; mark: string; open: number; stale: boolean
}
type Done = { name: string; path: string; category: string; effort: number; proven: boolean; updated: string }
export type PlanData = {
  progress: Record<string, number>
  parallel: number
  critical: number
  clashes: string[][]
  rows: Row[]
  done: Done[]
  warnings: string[]
}

/** Whether an owner's claim is stale: undated claims cannot be waited out, so they are stale. */
export const claimStale = (since: string, now = Date.now()): boolean => {
  if (!since) return true
  const at = Date.parse(since)
  return !Number.isFinite(at) || now - at > CLAIM_TTL_MS
}

/** The open Plan items of a unit, in note order. */
export const openItems = (s: Spec) => s.items.filter((i) => !i.done).map((i) => i.text)

/** The first Plan item text that appears twice, or undefined. */
export const repeatedItem = (open: string[]) => open.find((t, i, all) => all.indexOf(t) !== i)

/** Friction units (kit Plan.md): each issue and open question 2, the status weight, more than one proposal 1; at least 1. */
function effort(s: Spec): number {
  const issues = strings(s.fields.issues).length, proposals = strings(s.fields.proposals).length
  return Math.max(1, 2 * issues + 2 * s.openQuestions + (STATUS_EFFORT[s.status] ?? 0) + (proposals > 1 ? 1 : 0))
}

/**
 * Waves from explicit `depends` only: a unit's wave is one more than the latest wave among its
 * unfinished prerequisites. Ceiling: the kit also inferred edges from historical unit ids and
 * Related links; add that here when a vault needs it. Cycles, missing prerequisites and
 * prerequisites left out of the plan hold the unit instead of guessing an order.
 */
export function computePlan(all: Spec[]): PlanData {
  const included = all.filter((s) => str(s.fields.plan) !== "skip")
  const byName = new Map(all.map((s) => [s.name, s]))
  const done = included.filter((s) => s.status === "implemented")
  const open = included.filter((s) => s.status !== "implemented")
  const openNames = new Set(open.map((s) => s.name))
  const warnings: string[] = []

  const wave = new Map<string, number>(), cyclic = new Set<string>()
  const visit = (s: Spec, stack: string[]): number => {
    if (wave.has(s.name)) return wave.get(s.name)!
    if (stack.includes(s.name)) { for (const n of stack.slice(stack.indexOf(s.name))) cyclic.add(n); return 0 }
    let w = 1
    for (const d of s.depends) {
      const dep = byName.get(d)
      if (dep && openNames.has(d)) w = Math.max(w, visit(dep, [...stack, s.name]) + 1)
    }
    wave.set(s.name, w)
    return w
  }
  for (const s of open) visit(s, [])
  if (cyclic.size) warnings.push(`dependency cycle held: ${[...cyclic].sort().join(", ")}`)

  const rows: Row[] = []
  const ends = new Map<string, number>()
  for (const s of [...open].sort((a, b) => wave.get(a.name)! - wave.get(b.name)! || cmp(a.name, b.name))) {
    const after: string[] = [], missing: string[] = [], excluded: string[] = []
    for (const d of s.depends) {
      if (openNames.has(d)) after.push(d)
      else if (!byName.has(d)) missing.push(d)
      else if (byName.get(d)!.status !== "implemented") excluded.push(d)
    }
    const owner = str(s.fields.owner), since = str(s.fields.since), blocked = str(s.fields.blocked)
    const open = openItems(s), rep = repeatedItem(open)
    const held = s.depends.includes(s.name) ? "self dependency" : cyclic.has(s.name) ? "cycle" : missing.length ? `missing ${missing.join(", ")}`
      : excluded.length ? `waiting on excluded ${excluded.join(", ")}` : s.status === "deferred" ? "deferred" : blocked ? "blocked" : after.length ? "waiting" : owner ? "claimed" : !open.length ? "no open Plan items" : rep ? `repeats the Plan item "${rep}"` : ""
    if (missing.length) warnings.push(`${s.name} depends on missing ${missing.join(", ")}`)
    const e = effort(s)
    const start = Math.max(0, ...after.map((d) => ends.get(d) ?? 0))
    ends.set(s.name, start + e)
    rows.push({
      name: s.name, path: s.path, category: s.category, status: s.status, owner, since, blocked,
      effort: e, start, end: start + e, wave: wave.get(s.name)!, after, paths: s.paths,
      held, mark: PRIO_MARK[str(s.fields.prio)] ?? "", open: open.length, stale: claimStale(since),
    })
  }

  // Scope clashes: two units of one wave that can start now and claim overlapping paths.
  const clashes: string[][] = []
  const free = rows.filter((r) => !r.held && r.paths.length).map((r) => ({ name: r.name, wave: r.wave, paths: r.paths.map(normPath) }))
  for (let i = 0; i < free.length; i++)
    for (let j = i + 1; j < free.length; j++) {
      if (free[i].wave === free[j].wave && free[i].paths.some((x) => free[j].paths.some((y) => coversPath(x, y)))) clashes.push([free[i].name, free[j].name])
    }

  // Dependency concurrency: the most units whose [start, end) spans overlap.
  const edges = rows.flatMap((r) => [[r.start, 1], [r.end, -1]] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let parallel = 0, live = 0
  for (const [, d] of edges) parallel = Math.max(parallel, (live += d))

  const statusCount: Record<string, number> = {}
  for (const s of included) statusCount[s.status] = (statusCount[s.status] ?? 0) + 1
  const progress: Record<string, number> = {
    implemented: done.length,
    proven: done.filter((s) => str(s.fields.proof)).length,
    ...Object.fromEntries(["partial", "target", "proposed", "deferred", "open-question"].map((st) => [st, statusCount[st] ?? 0])),
    total: included.length,
    open: open.length,
    ready: rows.filter((r) => !r.held).length,
    scoped: rows.filter((r) => !r.held && r.paths.length).length,
    effort: rows.reduce((n, r) => n + r.effort, 0),
  }
  return {
    progress,
    parallel,
    critical: Math.max(0, ...rows.map((r) => r.end)),
    clashes,
    rows,
    done: done.map((s) => ({
      name: s.name, path: s.path, category: s.category, effort: effort(s), proven: !!str(s.fields.proof), updated: str(s.fields.updated),
    })),
    warnings,
  }
}

/** The open rows by wave, with the wave's effort (its longest unit). */
const waveCache = new WeakMap<PlanData, { wave: number; effort: number; rows: Row[] }[]>()

function waves(d: PlanData): { wave: number; effort: number; rows: Row[] }[] {
  const hit = waveCache.get(d)
  if (hit) return hit
  const by = new Map<number, Row[]>()
  for (const r of d.rows) {
    const rows = by.get(r.wave) ?? []
    rows.push(r)
    by.set(r.wave, rows)
  }
  const out = [...by].sort((a, b) => a[0] - b[0]).map(([wave, rows]) => ({ wave, effort: Math.max(...rows.map((r) => r.effort)), rows }))
  waveCache.set(d, out)
  return out
}

/** Plan Tasks.md: the waves, the done units and the warnings, generated for the Plan View. */
export function renderTasks(d: PlanData): string {
  const p = d.progress
  const lines = [
    "---", "title: Plan Tasks", "category: Meta", "status: index", "generated: true", "tags: [meta, plan]",
    ...["implemented", "proven", "total", "open", "ready", "effort"].map((k) => `${k}: ${p[k] ?? 0}`), "---", "",
    "# Plan Tasks", "",
    "Generated by overwatch (`vault_plan`). Do not edit; change the specs instead. Waves are dependency depth, not days. Effort is in friction units.", "",
    `**${p.implemented} / ${p.total} implemented** · ${p.proven} with proof · ${p.open} open · ${p.effort}u remaining · ${p.ready} ready · ${d.parallel} dependency concurrency · ${d.critical}u critical chain`,
  ]
  for (const w of waves(d)) {
    lines.push("", `## Wave ${w.wave}`, "", `${w.rows.length} tasks · ${w.effort}u`, "")
    for (const r of w.rows)
      lines.push(`- [${r.owner ? "/" : " "}] ${r.mark ? r.mark + " " : ""}[[${r.name}]] · ${r.effort}u #plan/${r.category || "none"}${r.after.length ? ` · after ${r.after.join(", ")}` : ""}${r.owner ? ` %% ${r.owner} %%` : ""}${r.held ? ` %% held: ${r.held} %%` : ""}`)
  }
  lines.push("", "## Done", "")
  for (const x of d.done) lines.push(`- [x] [[${x.name}]]${x.proven ? "" : " · no proof"}`)
  if (d.warnings.length) lines.push("", "## Warnings", "", ...d.warnings.map((w) => `- ${w}`))
  return lines.join("\n") + "\n"
}

/** The one progress line every vault view prints. */
export const progressLine = (d: PlanData) => `${d.progress.implemented}/${d.progress.total} implemented (${d.progress.proven} with proof) · ${d.progress.open} open · ${d.progress.ready} ready · ${d.parallel} parallel · ${d.critical}u critical`

/** vault_plan's report: the progress line, then each wave's units and why each is held. */
export function planReport(d: PlanData, wrote: string[] = []): string {
  const out = [`${progressLine(d)}${wrote.length ? ` · wrote ${wrote.join(", ")}` : ""}`]
  for (const w of d.warnings) out.push(`warning: ${w}`)
  for (const w of waves(d)) {
    out.push(`wave ${w.wave} · ${w.rows.length} units · ${w.effort}u`)
    for (const r of w.rows)
      out.push(`  ${r.mark ? r.mark + " " : ""}${r.name} (${r.effort}u, ${r.open} open item(s))${r.held ? ` [${r.held}${r.stale ? ", stale claim" : ""}]` : " [start now]"}${r.after.length ? ` after ${r.after.join(", ")}` : ""}`)
  }
  return out.join("\n")
}
