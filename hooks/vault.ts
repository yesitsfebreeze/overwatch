// The spec vault: an Obsidian vault under .overwatch/vault that git tracks. One note per unit of
// work in "01 Specs"; its frontmatter is the unit row (status, category, depends, prio, plan,
// owner, blocked, proof, checks) and its "## Plan" checklist is the unit's tasks. A session loads
// a unit's open Plan items as overwatch tasks (unit_load) and writes proof back (unit_record).
// The wave plan is computed here and projected to "00 Meta/Plan Data.json" (the Plan View
// plugin's data) and "00 Meta/Plan Tasks.md". Ported from the workflow kit's vault and plan note.
import type { Plan } from "../types/index.d.ts"
import { checkTier } from "./guards.ts"
import { checkReport, PLAN_TOOLS, refuse, runCheck, runChecks, trimmed, type PlanTool, type Result } from "./plan.ts"
import { cmp, join, readJson, state, STATE_DIR, VAULT_DIR, type Io } from "./io.ts"

const SPECS = "01 Specs"
/** The path spelling comparisons start from: separators and trailing slashes normalize away, case is kept. */
const slash = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "")
/** The one path rule scope checks share: `slash`, a leading `./`, and Windows' case fold. */
const normPath = (p: string) => slash(p).replace(/^\.\//, "").toLowerCase()
/** A path covers itself and everything under it, so `src/a` and `src/a/lex.ts` overlap. */
const coversPath = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
export const PLAN_DATA = "00 Meta/Plan Data.json"
export const PLAN_TASKS = "00 Meta/Plan Tasks.md"
const TEMPLATE = "00 Meta/Spec Template.md"
/** The scaffold shipped in the plugin, copied by vaultInit. */
const SCAFFOLD = "data/vault"
/** A claim older than this is stale and may be taken over with an explicit takeover. */
const CLAIM_TTL_MS = 15 * 60_000
/** Recorded unit_record runs: what was checked, at which commit, with what output. */
const EVIDENCE_DIR = "evidence"

/** Statuses that make a note a unit of work; the rest are navigation or provenance. */
const UNIT_STATUSES = new Set(["implemented", "partial", "target", "proposed", "deferred", "open-question"])
export const CATEGORIES = ["documentation", "behavior", "protocol", "build", "acceptance"]
const PRIO_MARK: Record<string, string> = { highest: "🔺", high: "⏫", medium: "🔼", low: "🔽", lowest: "⏬" }
/** Friction units per status (kit Plan.md): proposed 3, partial 2, target or deferred 1. */
const STATUS_EFFORT: Record<string, number> = { proposed: 3, partial: 2, target: 1, deferred: 1 }

export const vaultPath = (io: Io, ...parts: string[]) => state(io, VAULT_DIR, ...parts)

// --- frontmatter: the YAML subset the vault uses (scalars, inline and block lists) ---

const FRONT = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
type Value = string | number | boolean | null | Value[]
export type Fields = Record<string, Value>

function splitList(inner: string): string[] {
  const items: string[] = []
  let current = "", quote: string | null = null
  for (const c of inner) {
    if (quote) { current += c; if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") { quote = c; current += c; continue }
    if (c === ",") { items.push(current); current = ""; continue }
    current += c
  }
  items.push(current)
  return items.map((s) => s.trim()).filter(Boolean)
}

function scalar(value: string): Value {
  const v = value.trim()
  if (v.startsWith("[") && v.endsWith("]")) return splitList(v.slice(1, -1)).map(scalar)
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v) } catch { return v.slice(1, -1) }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  if (/^-?\d+$/.test(v)) return Number(v)
  if (v === "true") return true
  if (v === "false") return false
  if (v === "" || v === "null" || v === "~") return null
  return v
}

export function serialize(value: Value | undefined): string {
  if (Array.isArray(value)) return `[${value.map(serialize).join(", ")}]`
  if (value === null || value === undefined) return ""
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  const s = String(value)
  const plain = s !== "" && !/^[\s\-?:,\[\]{}#&*!|>'"%@`]/.test(s) && !/[:#]\s|:$/.test(s) && !/\s$/.test(s) &&
    !/^(?:true|false|null|~|-?\d+(?:\.\d+)?)$/.test(s) && !/[\r\n,]/.test(s)
  return plain ? s : JSON.stringify(s)
}

export function frontmatter(text: string): { fields: Fields; end: number } {
  const m = FRONT.exec(text)
  if (!m) return { fields: {}, end: 0 }
  const lines = m[1].split(/\r?\n/)
  const fields: Fields = {}
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(lines[i])
    if (!kv) continue
    const value = (kv[2] ?? "").trim()
    if (value === "") {
      const items: Value[] = []
      while (i + 1 < lines.length && /^\s*-\s/.test(lines[i + 1])) items.push(scalar(lines[++i].replace(/^\s*-\s/, "")))
      fields[kv[1]] = items.length ? items : null
    } else fields[kv[1]] = scalar(value)
  }
  return { fields, end: m[0].length }
}

/** Replace, add (value) or remove (null) frontmatter keys; everything else is kept byte for byte. */
export function patchFrontmatter(text: string, changes: Record<string, Value | undefined>): string {
  const nl = text.includes("\r\n") ? "\r\n" : "\n"
  const m = FRONT.exec(text)
  const bom = text.startsWith("﻿") ? "﻿" : ""
  const lines = m ? m[1].split(/\r?\n/) : []
  const body = m ? text.slice(m[0].length) : text.replace(/^﻿/, "")
  for (const [key, value] of Object.entries(changes)) {
    const index = lines.findIndex((line) => new RegExp(`^${key}:(?:\\s|$)`).test(line))
    if (index >= 0) {
      let end = index + 1
      while (end < lines.length && /^\s*-\s/.test(lines[end])) end++
      if (value === null || value === undefined) lines.splice(index, end - index)
      else lines.splice(index, end - index, `${key}: ${serialize(value)}`)
    } else if (value !== null && value !== undefined) lines.push(`${key}: ${serialize(value)}`)
  }
  return `${bom}---${nl}${lines.join(nl)}${nl}---${nl}${body}`
}

// --- sections ---

const heading = (name: string) => new RegExp(`^## ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "m")

/** The body of `## name` up to the next `## ` heading, or undefined when the note has none. */
export function section(text: string, name: string): string | undefined {
  const m = heading(name).exec(text)
  if (!m) return undefined
  const rest = text.slice(m.index + m[0].length)
  const next = /^## /m.exec(rest)
  return (next ? rest.slice(0, next.index) : rest).replace(/^\r?\n/, "").replace(/\s+$/, "")
}

/** Replaces the body of `## name`, or appends the section when the note has none. */
export function replaceSection(text: string, name: string, body: string): string {
  const nl = text.includes("\r\n") ? "\r\n" : "\n"
  const m = heading(name).exec(text)
  if (!m) return `${text.replace(/\s+$/, "")}${nl}${nl}## ${name}${nl}${nl}${body}${nl}`
  const start = m.index + m[0].length
  const next = /^## /m.exec(text.slice(start))
  const end = next ? start + next.index : text.length
  return `${text.slice(0, start)}${nl}${nl}${body}${nl}${next ? nl : ""}${text.slice(end)}`
}

export type PlanItem = { done: boolean; text: string }
const ITEM = /^\s*- \[([ xX])\] (.+?)\s*$/

export const planItems = (text: string): PlanItem[] =>
  (section(text, "Plan") ?? "").split(/\r?\n/).flatMap((l) => { const m = ITEM.exec(l); return m ? [{ done: m[1] !== " ", text: m[2].trim() }] : [] })

/** Ticks the open Plan items whose text is in `done`; other lines stay byte for byte. */
export function tickItems(text: string, done: ReadonlySet<string>): string {
  const body = section(text, "Plan")
  if (body === undefined) return text
  const ticked = body.split(/(\r?\n)/).map((l) => { const m = ITEM.exec(l); return m && m[1] === " " && done.has(m[2].trim()) ? l.replace("- [ ]", "- [x]") : l }).join("")
  return replaceSection(text, "Plan", ticked)
}

/** Real list entries of a section: `-` alone (the template's placeholder) does not count. */
const entries = (body: string | undefined) => (body ?? "").split(/\r?\n/).filter((l) => /^\s*-\s+\S/.test(l)).length

// --- specs ---

export type Spec = {
  name: string
  /** Relative to the vault. */
  path: string
  fields: Fields
  status: string
  category: string
  depends: string[]
  checks: string[]
  paths: string[]
  items: PlanItem[]
  openQuestions: number
  text: string
}

export const strings = (v: Value | undefined): string[] => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map(String).filter(Boolean)
export const str = (v: Value | undefined) => (v == null ? "" : String(v))
/** Note names from a frontmatter value: `[[A]]` wiki links, inline lists and nested lists all flatten to plain names. */
export const noteRefs = (v: Value | undefined): string[] =>
  (Array.isArray(v) ? (v.flat(Infinity) as Value[]) : [v]).map((x) => str(x).replace(/[[\]]/g, "").trim()).filter(Boolean)

export function parseSpec(path: string, text: string): Spec {
  const { fields } = frontmatter(text)
  return {
    name: path.split("/").pop()!.replace(/\.md$/, ""),
    path,
    fields,
    status: str(fields.status),
    category: str(fields.category),
    depends: noteRefs(fields.depends),
    checks: strings(fields.checks),
    paths: strings(fields.paths),
    items: planItems(text),
    openQuestions: entries(section(text, "Open questions")),
    text,
  }
}

/** Every Markdown file under `dir`, relative to it, skipping dot and underscore folders. */
async function markdown(io: Io, dir: string, prefix = ""): Promise<string[]> {
  const nested = await Promise.all((await io.list(join(dir, prefix))).map(async (e): Promise<string[]> => {
    if (e.name.startsWith(".") || e.name.startsWith("_")) return []
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.kind === "dir") return markdown(io, dir, rel)
    return e.kind === "file" && e.name.endsWith(".md") ? [rel] : []
  }))
  return nested.flat().sort(cmp)
}

/** Every note of the vault by path relative to it, read once per call. */
export async function readVault(io: Io): Promise<Map<string, string>> {
  const root = vaultPath(io)
  const paths = await markdown(io, root)
  const texts = await Promise.all(paths.map((p) => io.read(join(root, p))))
  return new Map(paths.flatMap((p, i) => (texts[i] === undefined ? [] : [[p, texts[i]!] as [string, string]])))
}

export function specsOf(notes: Map<string, string>): Spec[] {
  return [...notes].filter(([p]) => p.startsWith(SPECS + "/")).map(([p, t]) => parseSpec(p, t)).filter((s) => UNIT_STATUSES.has(s.status))
}

// --- plan ---

type Row = {
  name: string; path: string; category: string; status: string; owner: string; since: string; blocked: string
  effort: number; start: number; end: number; wave: number; after: string[]; paths: string[]
  held: string; mark: string; open: number; stale: boolean
}
type Done = { name: string; path: string; category: string; effort: number; proven: boolean; updated: string }
type PlanData = {
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
    const after = s.depends.filter((d) => openNames.has(d))
    const missing = s.depends.filter((d) => !byName.has(d))
    const excluded = s.depends.filter((d) => byName.has(d) && byName.get(d)!.status !== "implemented" && !openNames.has(d))
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
  const free = rows.filter((r) => !r.held).map((r) => ({ ...r, paths: r.paths.map(normPath) }))
  for (let i = 0; i < free.length; i++)
    for (let j = i + 1; j < free.length; j++) {
      if (free[i].wave === free[j].wave && free[i].paths.some((x) => free[j].paths.some((y) => coversPath(x, y)))) clashes.push([free[i].name, free[j].name])
    }

  // Dependency concurrency: the most units whose [start, end) spans overlap.
  const edges = rows.flatMap((r) => [[r.start, 1], [r.end, -1]] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let parallel = 0, live = 0
  for (const [, d] of edges) parallel = Math.max(parallel, (live += d))

  const count = (st: string) => included.filter((s) => s.status === st).length
  const progress: Record<string, number> = {
    implemented: done.length,
    proven: done.filter((s) => str(s.fields.proof)).length,
    ...Object.fromEntries(["partial", "target", "proposed", "deferred", "open-question"].map((st) => [st, count(st)])),
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
function waves(d: PlanData): { wave: number; effort: number; rows: Row[] }[] {
  const by = new Map<number, Row[]>()
  for (const r of d.rows) by.set(r.wave, [...(by.get(r.wave) ?? []), r])
  return [...by].sort((a, b) => a[0] - b[0]).map(([wave, rows]) => ({ wave, effort: Math.max(...rows.map((r) => r.effort)), rows }))
}

function renderTasks(d: PlanData): string {
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

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** Writes a file only when its bytes change, so a regenerated projection leaves git clean. */
async function writeChanged(io: Io, path: string, text: string): Promise<boolean> {
  if ((await io.read(path)) === text) return false
  await io.write(path, text)
  return true
}

/**
 * Computes the plan and writes the projections. Plan Data.json carries a hash of every vault note
 * (except Plan Tasks.md, which it generates), so the Plan View marks it stale when a note changes.
 */
export async function writePlan(io: Io): Promise<{ data: PlanData; wrote: string[] }> {
  const root = vaultPath(io)
  const notes = await readVault(io)
  const data = computePlan(specsOf(notes))
  const wrote: string[] = []
  if (await writeChanged(io, join(root, PLAN_TASKS), renderTasks(data))) wrote.push(PLAN_TASKS)
  const kept = [...notes].filter(([p]) => p !== PLAN_TASKS)
  const files = await Promise.all(kept.map(async ([path, text]) => ({ path, sha256: await sha256(text) })))
  const source = { version: 1, algorithm: "sha256", excluded: [PLAN_TASKS], files }
  if (await writeChanged(io, join(root, PLAN_DATA), JSON.stringify({ source, ...data }, null, 2) + "\n")) wrote.push(PLAN_DATA)
  return { data, wrote }
}

/** vault_plan: writes the projections and reports the waves. */
export async function vaultPlan(io: Io): Promise<string> {
  const { data, wrote } = await writePlan(io)
  return planReport(data, wrote)
}

/** The one progress line every vault view prints. */
const progressLine = (d: PlanData) => `${d.progress.implemented}/${d.progress.total} implemented (${d.progress.proven} with proof) · ${d.progress.open} open · ${d.progress.ready} ready · ${d.parallel} parallel · ${d.critical}u critical`

function planReport(d: PlanData, wrote: string[] = []): string {
  const out = [`${progressLine(d)}${wrote.length ? ` · wrote ${wrote.join(", ")}` : ""}`]
  for (const w of d.warnings) out.push(`warning: ${w}`)
  for (const w of waves(d)) {
    out.push(`wave ${w.wave} · ${w.rows.length} units · ${w.effort}u`)
    for (const r of w.rows)
      out.push(`  ${r.mark ? r.mark + " " : ""}${r.name} (${r.effort}u, ${r.open} open item(s))${r.held ? ` [${r.held}${r.stale ? ", stale claim" : ""}]` : " [start now]"}${r.after.length ? ` after ${r.after.join(", ")}` : ""}`)
  }
  return out.join("\n")
}

// --- scaffold and unit notes ---

async function copyTree(io: Io, from: string, to: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await io.list(from)) {
    const src = join(from, e.name), dst = join(to, e.name)
    if (e.kind === "dir") out.push(...(await copyTree(io, src, dst)))
    else if (e.kind === "file" && !(await io.exists(dst))) {
      await io.write(dst, (await io.read(src)) ?? "")
      out.push(dst)
    }
  }
  return out
}

const copyScaffold = (io: Io) => copyTree(io, join(io.root, SCAFFOLD), vaultPath(io))

/** Copies the scaffold into .overwatch/vault; an existing file is never overwritten. */
export async function vaultInit(io: Io): Promise<string> {
  const root = vaultPath(io)
  const added = await copyScaffold(io)
  const { wrote } = await writePlan(io)
  const rel = (p: string) => p.slice(root.length + 1)
  return added.length || wrote.length
    ? `vault at ${root}: added ${added.length} file(s)${added.length ? ` (${added.map(rel).join(", ")})` : ""}${wrote.length ? `; wrote ${wrote.join(", ")}` : ""}. Open the folder as an Obsidian vault; Plan View and Dataview ship enabled, and 00 Meta/Dashboard renders the overview.`
    : `vault at ${root} is complete; nothing added`
}

export const BAD_NAME = /[\\/:*?"<>|#^[\]]/

function findSpec(io: Io, specs: Spec[], name: string): Spec | string {
  const hit = specs.find((s) => s.name === name) ?? specs.find((s) => s.name.toLowerCase() === name.toLowerCase())
  if (hit) return hit
  return specs.length ? `no unit "${name}"; units: ${specs.map((s) => s.name).join(", ")}` : `no units yet in ${vaultPath(io, SPECS)}; unit_new adds one`
}

export async function unitNew(io: Io, e: { title?: unknown; category?: unknown; summary?: unknown; tasks?: unknown; depends?: unknown; checks?: unknown; paths?: unknown }): Promise<string> {
  const title = trimmed(e.title)
  if (!title || BAD_NAME.test(title) || /^[._]/.test(title)) throw new Error(`unit_new needs a title usable as a note name (none of \\ / : * ? " < > | # ^ [ ]; not starting with . or _)`)
  const category = trimmed(e.category)
  if (!CATEGORIES.includes(category)) throw new Error(`category must be one of ${CATEGORIES.join(", ")}`)
  const list = (v: unknown) => (Array.isArray(v) ? v : []).map(trimmed).filter(Boolean)
  const tasks = list(e.tasks)
  if (!tasks.length) throw new Error("unit_new needs tasks: one test-sized Plan item each")
  if (!(await io.exists(vaultPath(io, TEMPLATE)))) await copyScaffold(io)
  const file = vaultPath(io, SPECS, `${title}.md`)
  if (await io.exists(file)) throw new Error(`${SPECS}/${title}.md exists; edit it instead`)
  const template = (await io.read(vaultPath(io, TEMPLATE))) ?? ""
  const date = new Date().toISOString().slice(0, 10)
  let text = template.replaceAll("{{title}}", title).replaceAll("{{date}}", date)
  const depends = list(e.depends), checks = list(e.checks), paths = list(e.paths)
  text = patchFrontmatter(text, { category, depends: depends.length ? depends : null, checks: checks.length ? checks : null, paths: paths.length ? paths : null })
  if (trimmed(e.summary)) text = replaceSection(text, "Summary", trimmed(e.summary))
  text = replaceSection(text, "Plan", tasks.map((t) => `- [ ] ${t}`).join("\n"))
  await io.write(file, text)
  const { data } = await writePlan(io)
  const row = data.rows.find((r) => r.name === title)
  return `Added ${SPECS}/${title}.md (${tasks.length} Plan item(s), wave ${row?.wave ?? "?"}${row?.held ? `, held: ${row.held}` : ""}). unit_load loads it into the session plan.`
}

type Closeout = { done: string[]; commit: string; guards: string[]; summary: string; limitations: string; run?: string }

/**
 * Writes a unit's closeout into its note: ticks the finished Plan items, sets status
 * implemented (partial while an item stays open), the proof line and the Status section.
 */
export function closeNote(text: string, c: Closeout): { text: string; status: string } {
  let next = tickItems(text, new Set(c.done))
  const status = planItems(next).some((i) => !i.done) ? "partial" : "implemented"
  const proof = `${c.commit} guards: ${c.guards.join("; ") || "none"}; limitations: ${c.limitations || "none"}`
  next = patchFrontmatter(next, { status, proof, evidence: c.run, updated: new Date().toISOString().slice(0, 10), owner: null, since: null })
  if (c.summary) next = replaceSection(next, "Status", c.summary)
  return { text: next, status }
}

// --- the unit in the session plan (unit_load, unit_record) ---

/** Why this owner cannot claim the unit, or undefined when it can. One rule set for every claim path. */
const claimBlock = (row: Row, owner: string, takeover = false): string | undefined => {
  if (row.held && row.held !== "claimed") return `"${row.name}" is held: ${row.held}`
  if (!row.owner || row.owner === owner) return undefined
  const age = row.since ? ` since ${row.since}` : ""
  if (!row.stale) return `"${row.name}" is held: claimed by ${row.owner}${age}; release it there or wait for the claim to go stale`
  if (!takeover) return `"${row.name}" is held: claimed by ${row.owner}${age} (stale); pass takeover: true to take it`
  return undefined
}

/** Writes an owner's claim into the note when the unit can be taken; the plan is passed in, never recomputed. */
async function takeClaim(io: Io, data: PlanData, spec: Spec, owner: string, takeover = false): Promise<Row | string> {
  const row = data.rows.find((r) => r.name === spec.name)
  if (!row) return `"${spec.name}" cannot be claimed: it is not in the plan`
  const why = claimBlock(row, owner, takeover)
  if (why) return why
  const shared = data.rows.filter((r) => r.name !== spec.name && r.owner && !r.stale && r.paths.some((p) => row.paths.includes(p)))
  if (shared.length) return `"${spec.name}" shares paths with claimed unit(s) ${shared.map((r) => r.name).join(", ")}; release one first`
  await io.write(vaultPath(io, spec.path), patchFrontmatter(spec.text, { owner, since: new Date().toISOString() }))
  // Not a lock: a read-back catches the common race where another session wrote between read and write.
  const back = str(frontmatter((await io.read(vaultPath(io, spec.path))) ?? "").fields.owner)
  return back === owner ? row : `"${spec.name}" was claimed by ${back || "another session"} while writing; retry`

}

/** A unit's spec and every spec beside it, read once. */
async function unitSpec(io: Io, name: string): Promise<{ spec: Spec; specs: Spec[] } | string> {
  const specs = specsOf(await readVault(io))
  const spec = findSpec(io, specs, name)
  return typeof spec === "string" ? spec : { spec, specs }
}

/** Adds a unit's open Plan items as tasks and its `checks` as guards; with `owner`, claims it. Loading it again adds only new items. */
async function loadUnit(io: Io, s: Plan, spec: Spec, specs: Spec[], data: PlanData, owner: string): Promise<Result> {
  if (s.unit && s.unit.name !== spec.name) return refuse(s, `unit "${s.unit.name}" is loaded; unit_record closes it first`)
  const row = data.rows.find((r) => r.name === spec.name)
  if (!row) return refuse(s, `"${spec.name}" is ${spec.status === "implemented" ? "implemented" : "left out of the plan"}; nothing to load`)
  if (row.held && !(owner && row.owner === owner)) {
    const why = claimBlock(row, owner)
    return refuse(s, why ?? `"${spec.name}" is held: ${row.held}`)
  }
  const open = openItems(spec)
  if (!open.length) return refuse(s, `${spec.path} has no open "## Plan" items; add test-sized ones first`)
  const unit = { name: spec.name, tasks: { ...(s.unit?.tasks ?? {}) }, guards: [...(s.unit?.guards ?? [])], checks: [...new Set([...(s.unit?.checks ?? []), ...spec.checks])] }
  const loaded = new Set(Object.values(unit.tasks))
  const titles = open.filter((i) => !loaded.has(i))
  const lines = [`Loaded unit "${spec.name}" (${spec.category || "no category"}, wave ${row.wave})`]
  let next = s
  // Tasks and guards go through task_add and guard_add, so a unit's are built like any other.
  if (titles.length) {
    const r = PLAN_TOOLS.task_add.run!(next, { titles })
    if (r.warn) return refuse(s, r.text)
    for (const t of r.state.tasks.slice(next.tasks.length)) unit.tasks[t.id] = t.title
    next = r.state
    lines.push(r.text)
  }
  for (const c of spec.checks) {
    const same = next.guards.find((g) => g.check === c)
    if (same) { if (!unit.guards.includes(same.id)) unit.guards.push(same.id); continue }
    const r = PLAN_TOOLS.guard_add.run!(next, { question: `Does \`${c}\` pass for unit ${spec.name}?`, check: c, tier: checkTier(c) })
    if (r.warn) return refuse(s, `${spec.path} checks: ${r.text}`)
    next = r.state
    unit.guards.push(next.guards[next.guards.length - 1].id)
    lines.push(r.text)
  }
  if (next === s && s.unit) return refuse(s, `"${spec.name}" is loaded and has nothing new`)
  if (owner) {
    const claimed = await takeClaim(io, data, spec, owner)
    if (typeof claimed === "string") return refuse(s, claimed)
    lines.push(`Claimed "${spec.name}" as ${owner} (wave ${claimed.wave})`)
  }
  if (!spec.checks.length) lines.push("The note has no `checks`; add guards for what the unit must deliver.")
  return { state: { ...next, unit }, text: lines.join("\n"), work: true }
}

/** This session's state folder as a pathspec from the repository root, or its bare name when it sits outside. */
const stateSpec = (root: string, io: Io) => {
  const r = slash(root), d = slash(state(io))
  return normPath(d).startsWith(`${normPath(r)}/`) ? d.slice(r.length + 1) : STATE_DIR
}

/** The spec's open Plan item texts, in note order. */
const openItems = (s: Spec) => s.items.filter((i) => !i.done).map((i) => i.text)

/** The first open Plan item text that appears twice, or undefined. */
const repeatedItem = (open: string[]) => open.find((t, i, all) => all.indexOf(t) !== i)

/** unit_load: read the vault once, then load the named unit. */
export async function unitLoad(io: Io, s: Plan, e: { unit?: unknown; owner?: unknown }): Promise<Result> {
  const name = trimmed(e.unit)
  if (!name) return refuse(s, "unit_load needs the unit's note name; vault_plan lists them")
  const found = await unitSpec(io, name)
  if (typeof found === "string") return refuse(s, found)
  return loadUnit(io, s, found.spec, found.specs, computePlan(found.specs), trimmed(e.owner))
}

/** Git's view of the work: HEAD and the changed paths outside .overwatch. */
export async function gitState(io: Io): Promise<{ commit: string; dirty: string[] } | string> {
  const [head, top] = await Promise.all([
    io.run(["git", "rev-parse", "HEAD"], { cwd: io.cwd, timeoutMs: 10_000 }),
    io.run(["git", "rev-parse", "--show-toplevel"], { cwd: io.cwd, timeoutMs: 10_000 }),
  ])
  if (head.code !== 0) return `unit_record needs a git repository with a commit: ${head.stderr.trim() || "git rev-parse HEAD failed"}`
  // Run from the repository root so work outside the session's cwd still counts; the state dir never does.
  if (top.code !== 0) return `unit_record needs a git work tree: ${top.stderr.trim() || "git rev-parse --show-toplevel failed"}`
  const root = top.stdout.trim()
  // The state folder sits under the session's cwd, so exclude its path from the root, not a literal name.
  const st = await io.run(["git", "status", "--porcelain", "--untracked-files=all", "--", ".", `:(exclude,literal)${stateSpec(root, io)}`], { cwd: root, timeoutMs: 20_000 })
  if (st.code !== 0) return `git status failed: ${st.stderr.trim()}`
  const dirty = st.stdout.split("\n").map((l) => l.slice(3).replace(/^"|"$/g, "")).filter(Boolean)
  return { commit: head.stdout.trim(), dirty }
}

/**
 * Closes the loaded unit against evidence: its tasks done (or `partial`), its check guards
 * re-run and upheld, the work committed. Writes the proof into the note and regenerates the plan.
 */
export async function unitRecord(io: Io, s: Plan, e: { summary?: unknown; limitations?: unknown; partial?: unknown }): Promise<Result> {
  const unit = s.unit
  if (!unit) return refuse(s, "no unit loaded; unit_load brings one in")
  const summary = trimmed(e.summary)
  const limitations = trimmed(e.limitations)
  if (!summary) return refuse(s, "unit_record needs a summary: what the unit does now, for the note's Status section")
  if (!limitations) return refuse(s, "unit_record needs limitations: what is left or unverified, or \"none\"")
  const spec = findSpec(io, specsOf(await readVault(io)), unit.name)
  if (typeof spec === "string") return refuse(s, spec)
  const byId = new Map(s.tasks.map((t) => [t.id, t]))
  const open = Object.keys(unit.tasks).map(Number).filter((id) => byId.has(id) && byId.get(id)!.status !== "done") // a removed or replaced task no longer holds the unit
  if (open.length && e.partial !== true) return refuse(s, `unit tasks still open: ${open.map((id) => `#${id}`).join(", ")}; finish them, or pass partial: true to record what is done`)
  const git = await gitState(io)
  if (typeof git === "string") return refuse(s, git)
  if (git.dirty.length) return refuse(s, `commit the unit's work first; uncommitted: ${git.dirty.slice(0, 8).join(", ")}${git.dirty.length > 8 ? " …" : ""}`)
  // The unit's checks are re-run from the commands unit_load kept, so a plan whose guards were
  // dropped or re-added still cannot record the unit without them passing.
  const checks = [...new Set([...(unit.checks ?? []), ...spec.checks])]
  const decided = await runChecks(io.run, checks, io.cwd)
  // The plan's guards learn the outcome when their command is one of the unit's checks.
  const decidedPlan: Plan = { ...s, guards: s.guards.map((g) => decided.find((d) => d.check === g.check) ?? g) }
  const failing = decided.filter((g) => !g.met)
  if (failing.length) return refuse(decidedPlan, `unit checks failing, nothing recorded:
${checkReport(failing)}`)
  const done = Object.entries(unit.tasks).filter(([id]) => byId.get(Number(id))?.status === "done").map(([, text]) => text)
  const guards = decided.map((g) => ({ id: g.id, question: g.question, check: g.check ?? "", tier: g.tier ?? "", met: g.met === true, exit: g.last?.exit ?? null, out: g.last?.out ?? "" }))
  // The run id names exactly what was checked: the commit and each guard's command and outcome.
  const run = (await sha256(JSON.stringify({ unit: spec.name, commit: git.commit, guards: guards.map((g) => [g.id, g.check, g.exit]) }))).slice(0, 16)
  const { text, status } = closeNote(spec.text, {
    done,
    commit: git.commit,
    guards: decided.map((g) => `\`${g.check ?? g.id}\` exit 0`),
    summary,
    limitations,
    run,
  })
  await io.write(vaultPath(io, spec.path), text)
  await io.write(state(io, EVIDENCE_DIR, `${spec.name}.json`), JSON.stringify({ run, unit: spec.name, commit: git.commit, recorded: new Date().toISOString(), status, summary, limitations, guards }, null, 2) + "\n")
  const { wrote } = await writePlan(io)
  const { unit: _, ...rest } = decidedPlan
  return {
    state: rest,
    text: `Recorded "${spec.name}" as ${status} at ${git.commit.slice(0, 12)} (run ${run}); ${done.length} Plan item(s) ticked${wrote.length ? `; wrote ${wrote.join(", ")}` : ""}. Commit the note: git add .overwatch/vault && git commit -m "spec: record ${spec.name}"`,
  }
}

/** Claims a unit for an owner; a live claim is refused, a stale one needs takeover. */
export async function unitClaim(io: Io, s: Plan, e: { unit?: unknown; owner?: unknown; takeover?: unknown }): Promise<Result> {
  const name = trimmed(e.unit)
  if (!name) return refuse(s, "unit_claim needs the unit's note name; vault_plan lists them")
  const owner = trimmed(e.owner)
  if (!owner) return refuse(s, "unit_claim needs owner: who holds it")
  const found = await unitSpec(io, name)
  if (typeof found === "string") return refuse(s, found)
  if (found.spec.status === "implemented") return refuse(s, `"${found.spec.name}" is implemented; nothing to claim`)
  const row = await takeClaim(io, computePlan(found.specs), found.spec, owner, e.takeover === true)
  if (typeof row === "string") return refuse(s, row)
  return { state: s, text: `Claimed "${found.spec.name}" as ${owner} (wave ${row.wave}, ${row.open} open item(s))`, work: true }
}

/** Releases a unit's claim; only the recording owner may release it. */
export async function unitRelease(io: Io, s: Plan, e: { unit?: unknown; owner?: unknown }): Promise<Result> {
  const name = trimmed(e.unit)
  if (!name) return refuse(s, "unit_release needs the unit's note name")
  const owner = trimmed(e.owner)
  if (!owner) return refuse(s, "unit_release needs owner: the claim holder releasing it")
  const found = await unitSpec(io, name)
  if (typeof found === "string") return refuse(s, found)
  const spec = found.spec
  const current = str(spec.fields.owner)
  if (!current) return refuse(s, `"${spec.name}" is not claimed`)
  if (current !== owner) return refuse(s, `"${spec.name}" is claimed by ${current}; pass owner: "${current}" to release it`)
  await io.write(vaultPath(io, spec.path), patchFrontmatter(spec.text, { owner: null, since: null }))
  return { state: s, text: `Released "${spec.name}" (was ${current})`, work: true }
}

/** Loads the first unit that can start now (lowest wave, no live claim), claiming it for the owner. */
export async function unitNext(io: Io, s: Plan, e: { owner?: unknown }): Promise<Result> {
  const owner = trimmed(e.owner)
  if (!owner) return refuse(s, "unit_next needs owner: who takes the claim")
  const specs = specsOf(await readVault(io))
  const data = computePlan(specs)
  const ready = data.rows.filter((r) => !r.held)
  if (!ready.length) {
    const held = data.rows.filter((r) => r.held).map((r) => `${r.name} (${r.held}${r.stale ? ", stale claim" : ""})`)
    return refuse(s, `no unit can start now${held.length ? `; held: ${held.join(", ")}` : ""}`)
  }
  const spec = findSpec(io, specs, ready[0].name)
  if (typeof spec === "string") return refuse(s, spec)
  return loadUnit(io, s, spec, specs, data, owner)
}

type Evidence = {
  run?: string; unit?: string; commit?: string; recorded?: string; status?: string; summary?: string; limitations?: string
  guards?: { id: string; question?: string; check?: string; tier?: string; met?: boolean; exit?: number | null; out?: string }[]
}

/** Reads the recorded run for a unit and compares it with HEAD; rerun re-runs its checks. */
export async function unitVerify(io: Io, s: Plan, e: { unit?: unknown; rerun?: unknown }): Promise<Result> {
  const name = trimmed(e.unit) || s.unit?.name
  if (!name) return refuse(s, "unit_verify needs a unit; unit_load loads one or pass unit")
  const specs = specsOf(await readVault(io))
  const spec = findSpec(io, specs, name)
  if (typeof spec === "string") return refuse(s, spec)
  const ev = await readJson<Evidence | undefined>(io, state(io, EVIDENCE_DIR, `${spec.name}.json`), undefined)
  if (!ev?.run) return refuse(s, `no recorded run for "${spec.name}"; unit_record writes one`)
  const git = await gitState(io)
  if (typeof git === "string") return refuse(s, git)
  const guards = Array.isArray(ev.guards) ? ev.guards : []
  // Current means the recorded commit plus no code changes: a later note-only commit still covers the tree.
  let current = ev.commit === git.commit && !git.dirty.length
  let noteOnly = false
  if (!current && ev.commit && !git.dirty.length) {
    const diff = await io.run(["git", "diff", "--name-only", `${ev.commit}..HEAD`, "--", ".", ":(exclude).overwatch"], { cwd: io.cwd, timeoutMs: 20_000 })
    noteOnly = diff.code === 0 && !diff.stdout.trim()
    current = noteOnly
  }
  const known = guards.filter((g) => typeof g.met === "boolean").length
  const upheld = guards.filter((g) => g.met === true).length
  const unknown = guards.length - known
  const lines = [
    `unit "${spec.name}" run ${ev.run}: ${current ? `current${noteOnly ? " (notes only since)" : ""}` : "stale"} — recorded at ${String(ev.commit ?? "?").slice(0, 12)}${ev.recorded ? ` on ${ev.recorded}` : ""}, HEAD ${git.commit.slice(0, 12)}${git.dirty.length ? `; ${git.dirty.length} uncommitted path(s)` : ""}`,
    `${upheld}/${guards.length} guard(s) upheld when recorded${unknown ? `; ${unknown} unknown` : ""}${ev.status ? `; status ${ev.status}` : ""}`,
  ]
  if (ev.summary) lines.push(`summary: ${ev.summary}`)
  if (ev.limitations) lines.push(`limitations: ${ev.limitations}`)
  if (e.rerun === true) {
    const checks = guards.filter((g) => g.check)
    if (!checks.length) lines.push("no recorded checks to re-run")
    else {
      const decided = await Promise.all(checks.map((g) => runCheck(io.run, { id: g.id, question: g.question ?? g.id, check: g.check! }, io.cwd)))
      lines.push(checkReport(decided))
    }
  } else if (!current) {
    lines.push("record it again with unit_record after the work, or pass rerun: true to re-run the recorded checks")
  }
  return { state: s, text: lines.join("\n") }
}

/** The vault ledger: progress, live and stale claims, ready units, clashes and warnings. Read-only. */
export async function vaultStatus(io: Io): Promise<string> {
  const data = computePlan(specsOf(await readVault(io)))
  const p = data.progress
  const lines = [`${p.implemented}/${p.total} implemented (${p.proven} with proof) · ${p.open} open · ${p.ready} ready · ${data.parallel} parallel · ${data.critical}u critical`]
  const claims = data.rows.filter((r) => r.owner)
  lines.push(...(claims.length ? ["claims:", ...claims.map((r) => `  ${r.name} by ${r.owner}${r.since ? ` since ${r.since}` : ""}${r.stale ? " (stale)" : ""}`)] : ["claims: none"]))
  const ready = data.rows.filter((r) => !r.held)
  lines.push(ready.length ? `ready: ${ready.map((r) => r.name).join(", ")}` : "ready: none")
  if (data.clashes.length) lines.push(`path clashes: ${data.clashes.map((c) => c.join(" / ")).join("; ")}`)
  for (const w of data.warnings) lines.push(`warning: ${w}`)
  return lines.join("\n")
}

/** The plan tools that read and write the vault; each host merges them with PLAN_TOOLS. */
export const VAULT_TOOLS: Record<string, PlanTool> = {
  unit_load: {
    description: "Bring a vault unit (a spec note in .overwatch/vault/01 Specs) into the session plan: each open item of its \"## Plan\" checklist becomes a task, each command in its `checks` frontmatter a guard. Refused while the unit is held (waiting on unfinished units, a cycle, blocked, deferred, claimed) or another unit is loaded. vault_plan lists the units and which can start now.",
    properties: {
      unit: { type: "string", description: "The spec note's name, e.g. \"Parser Recovery\"." },
      owner: { type: "string", description: "Claim the unit for this owner as it loads; unit_record releases it." },
    },
    required: ["unit"],
    act: unitLoad,
  },
  unit_record: {
    description: "Close the loaded unit against evidence once its work is committed: its tasks must be done (or pass partial), its check guards are re-run and must pass, and the tree outside .overwatch must be clean. Ticks the finished Plan items, sets status implemented (partial while items stay open), writes the proof line (commit, guard outcomes, limitations) and the Status section, and regenerates the plan.",
    properties: {
      summary: { type: "string", description: "What the unit does now, stated as fact; replaces the note's Status section." },
      limitations: { type: "string", description: "What is left, unverified or out of scope; \"none\" when nothing is." },
      partial: { type: "boolean", description: "Record with some unit tasks still open; the note stays partial." },
    },
    required: ["summary", "limitations"],
    act: unitRecord,
  },
  unit_claim: {
    description: "Claim a unit for an owner so two sessions cannot take it: writes owner and since into the note. Refused while a live claim or a waiting prerequisite holds it; a claim older than 15 minutes is stale and needs takeover: true. Refused when the unit shares paths with another live claim.",
    properties: {
      unit: { type: "string", description: "The spec note's name." },
      owner: { type: "string", description: "Who holds the claim, e.g. \"claude@session\"." },
      takeover: { type: "boolean", description: "Take over a stale claim from another owner; refused for a live one." },
    },
    required: ["unit", "owner"],
    act: unitClaim,
  },
  unit_release: {
    description: "Release a unit's claim, clearing owner and since. Only the recording owner may release it; unit_record releases it itself.",
    properties: {
      unit: { type: "string", description: "The spec note's name." },
      owner: { type: "string", description: "The owner releasing it; must match the recorded owner." },
    },
    required: ["unit", "owner"],
    act: unitRelease,
  },
  unit_next: {
    description: "Load the first unit that can start now (lowest wave, not held), claiming it for the owner. A stale claim is not taken automatically: unit_claim takeover: true is explicit. One call replaces reading vault_plan and naming the unit: its Plan items become tasks and its checks guards.",
    properties: { owner: { type: "string", description: "Who takes the claim, e.g. \"claude@session\"." } },
    required: ["owner"],
    act: unitNext,
  },
  unit_verify: {
    description: "Read a unit's recorded run and compare it with HEAD: current means the evidence covers the tree, stale means the commit moved. rerun: true re-runs the recorded checks now, without writing a new run. Read-only.",
    properties: {
      unit: { type: "string", description: "The spec note's name; the loaded unit when omitted." },
      rerun: { type: "boolean", description: "Re-run the recorded check commands and report their outcomes." },
    },
    act: unitVerify,
  },
  vault_status: {
    description: "The vault ledger in one read: progress counts, live and stale claims, units ready to start, path clashes and dependency warnings. Read-only.",
    act: async (io: Io, s: Plan) => ({ state: s, text: await vaultStatus(io) }),
  },
}
