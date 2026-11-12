// The spec vault: an Obsidian vault under .overwatch/vault that git tracks. One note per unit of
// work in "01 Specs"; its frontmatter is the unit row (status, category, depends, prio, plan,
// owner, blocked, proof, checks) and its "## Plan" checklist is the unit's tasks. A session loads
// a unit's open Plan items as overwatch tasks (unit_load) and writes proof back (unit_record).
// The wave plan is computed here and projected to "00 Meta/Plan Data.json" (the Plan View
// plugin's data) and "00 Meta/Plan Tasks.md". Ported from the workflow kit's vault and plan note.
import type { Plan } from "../types/index.d.ts"
import { checkReport, PLAN_TOOLS, refuse, runCheck, trimmed, withDecided, type PlanTool, type Result } from "./plan.ts"
import { cmp, join, state, VAULT_DIR, type Io } from "./io.ts"

const SPECS = "01 Specs"
export const PLAN_DATA = "00 Meta/Plan Data.json"
export const PLAN_TASKS = "00 Meta/Plan Tasks.md"
const TEMPLATE = "00 Meta/Spec Template.md"
/** The scaffold shipped in the plugin, copied by vaultInit. */
const SCAFFOLD = "data/vault"

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
  (section(text, "Plan") ?? "").split(/\r?\n/).flatMap((l) => { const m = ITEM.exec(l); return m ? [{ done: m[1] !== " ", text: m[2] }] : [] })

/** Ticks the open Plan items whose text is in `done`; other lines stay byte for byte. */
export function tickItems(text: string, done: ReadonlySet<string>): string {
  const body = section(text, "Plan")
  if (body === undefined) return text
  const ticked = body.split(/(\r?\n)/).map((l) => { const m = ITEM.exec(l); return m && m[1] === " " && done.has(m[2]) ? l.replace("- [ ]", "- [x]") : l }).join("")
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

const strings = (v: Value | undefined): string[] => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map(String).filter(Boolean)
const str = (v: Value | undefined) => (v == null ? "" : String(v))
/** Note names from a frontmatter value: `[[A]]` wiki links, inline lists and nested lists all flatten to plain names. */
const noteRefs = (v: Value | undefined): string[] =>
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
  held: string; mark: string; open: number
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
    const owner = str(s.fields.owner), blocked = str(s.fields.blocked)
    const held = s.depends.includes(s.name) ? "self dependency" : cyclic.has(s.name) ? "cycle" : missing.length ? `missing ${missing.join(", ")}`
      : excluded.length ? `waiting on excluded ${excluded.join(", ")}` : s.status === "deferred" ? "deferred" : blocked ? "blocked" : after.length ? "waiting" : owner ? "claimed" : ""
    if (missing.length) warnings.push(`${s.name} depends on missing ${missing.join(", ")}`)
    const e = effort(s)
    const start = Math.max(0, ...after.map((d) => ends.get(d) ?? 0))
    ends.set(s.name, start + e)
    rows.push({
      name: s.name, path: s.path, category: s.category, status: s.status, owner, since: str(s.fields.since), blocked,
      effort: e, start, end: start + e, wave: wave.get(s.name)!, after, paths: s.paths,
      held, mark: PRIO_MARK[str(s.fields.prio)] ?? "", open: s.items.filter((i) => !i.done).length,
    })
  }

  // Scope clashes: two open units of one wave that claim a common path cannot run together.
  const clashes: string[][] = []
  for (let i = 0; i < rows.length; i++)
    for (let j = i + 1; j < rows.length; j++)
      if (rows[i].wave === rows[j].wave && rows[i].paths.some((p) => rows[j].paths.includes(p))) clashes.push([rows[i].name, rows[j].name])

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
async function writePlan(io: Io): Promise<{ data: PlanData; wrote: string[] }> {
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

function planReport(d: PlanData, wrote: string[] = []): string {
  const p = d.progress
  const out = [`${p.implemented}/${p.total} implemented (${p.proven} with proof) · ${p.open} open · ${p.ready} ready · ${d.critical}u critical${wrote.length ? ` · wrote ${wrote.join(", ")}` : ""}`]
  for (const w of d.warnings) out.push(`warning: ${w}`)
  for (const w of waves(d)) {
    out.push(`wave ${w.wave} · ${w.rows.length} units · ${w.effort}u`)
    for (const r of w.rows)
      out.push(`  ${r.mark ? r.mark + " " : ""}${r.name} (${r.effort}u, ${r.open} open item(s))${r.held ? ` [${r.held}]` : " [start now]"}${r.after.length ? ` after ${r.after.join(", ")}` : ""}`)
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
    ? `vault at ${root}: added ${added.length} file(s)${added.length ? ` (${added.map(rel).join(", ")})` : ""}${wrote.length ? `; wrote ${wrote.join(", ")}` : ""}. Open the folder as an Obsidian vault; the Plan View plugin renders the plan.`
    : `vault at ${root} is complete; nothing added`
}

const BAD_NAME = /[\\/:*?"<>|#^[\]]/

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

type Closeout = { done: string[]; commit: string; guards: string[]; summary: string; limitations: string }

/**
 * Writes a unit's closeout into its note: ticks the finished Plan items, sets status
 * implemented (partial while an item stays open), the proof line and the Status section.
 */
export function closeNote(text: string, c: Closeout): { text: string; status: string } {
  let next = tickItems(text, new Set(c.done))
  const status = planItems(next).some((i) => !i.done) ? "partial" : "implemented"
  const proof = `${c.commit} guards: ${c.guards.join("; ") || "none"}; limitations: ${c.limitations || "none"}`
  next = patchFrontmatter(next, { status, proof, updated: new Date().toISOString().slice(0, 10), owner: null, since: null })
  if (c.summary) next = replaceSection(next, "Status", c.summary)
  return { text: next, status }
}

// --- the unit in the session plan (unit_load, unit_record) ---

/** Adds a unit's open Plan items as tasks and its `checks` as guards; loading it again adds only new items. */
export async function unitLoad(io: Io, s: Plan, e: { unit?: unknown }): Promise<Result> {
  const name = trimmed(e.unit)
  if (!name) return refuse(s, "unit_load needs the unit's note name; vault_plan lists them")
  const specs = specsOf(await readVault(io))
  const spec = findSpec(io, specs, name)
  if (typeof spec === "string") return refuse(s, spec)
  if (s.unit && s.unit.name !== spec.name) return refuse(s, `unit "${s.unit.name}" is loaded; unit_record closes it first`)
  const row = computePlan(specs).rows.find((r) => r.name === spec.name)
  if (!row) return refuse(s, `"${spec.name}" is ${spec.status === "implemented" ? "implemented" : "left out of the plan"}; nothing to load`)
  if (row.held) return refuse(s, `"${spec.name}" is held: ${row.held}${row.held === "claimed" ? ` by ${row.owner}; clear its owner to take it` : ""}`)
  if (!spec.items.some((i) => !i.done)) return refuse(s, `${spec.path} has no open "## Plan" items; add test-sized ones first`)
  const unit = { name: spec.name, tasks: { ...(s.unit?.tasks ?? {}) }, guards: [...(s.unit?.guards ?? [])] }
  const loaded = new Set(Object.values(unit.tasks))
  const titles = spec.items.filter((i) => !i.done && !loaded.has(i.text)).map((i) => i.text)
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
    const r = PLAN_TOOLS.guard_add.run!(next, { question: `Does \`${c}\` pass for unit ${spec.name}?`, check: c })
    if (r.warn) return refuse(s, `${spec.path} checks: ${r.text}`)
    next = r.state
    unit.guards.push(next.guards[next.guards.length - 1].id)
    lines.push(r.text)
  }
  if (next === s && s.unit) return refuse(s, `"${spec.name}" is loaded and has nothing new`)
  if (!spec.checks.length) lines.push("The note has no `checks`; add guards for what the unit must deliver.")
  return { state: { ...next, unit }, text: lines.join("\n"), work: true }
}

/** Git's view of the work: HEAD and the changed paths outside .overwatch. */
export async function gitState(io: Io): Promise<{ commit: string; dirty: string[] } | string> {
  const head = await io.run(["git", "rev-parse", "HEAD"], { cwd: io.cwd, timeoutMs: 10_000 })
  if (head.code !== 0) return `unit_record needs a git repository with a commit: ${head.stderr.trim() || "git rev-parse HEAD failed"}`
  // Porcelain paths are relative to the repo root, the pathspec to cwd: let git exclude the state dir.
  const st = await io.run(["git", "status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).overwatch"], { cwd: io.cwd, timeoutMs: 20_000 })
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
  const mine = s.guards.filter((g) => unit.guards.includes(g.id))
  const decided = await Promise.all(mine.filter((g) => g.check).map((g) => runCheck(io.run, g, io.cwd)))
  const state = withDecided(s, decided)
  const failing = decided.filter((g) => !g.met)
  if (failing.length) return refuse(state, `unit guards failing, nothing recorded:\n${checkReport(failing)}`)
  const done = Object.entries(unit.tasks).filter(([id]) => byId.get(Number(id))?.status === "done").map(([, text]) => text)
  const { text, status } = closeNote(spec.text, {
    done,
    commit: git.commit,
    guards: decided.map((g) => `${g.id} exit 0`),
    summary,
    limitations,
  })
  await io.write(vaultPath(io, spec.path), text)
  const { wrote } = await writePlan(io)
  const { unit: _, ...rest } = state
  return {
    state: rest,
    text: `Recorded "${spec.name}" as ${status} at ${git.commit.slice(0, 12)}; ${done.length} Plan item(s) ticked${wrote.length ? `; wrote ${wrote.join(", ")}` : ""}. Commit the note: git add .overwatch/vault && git commit -m "spec: record ${spec.name}"`,
  }
}

/** The plan tools that read and write the vault; each host merges them with PLAN_TOOLS. */
export const VAULT_TOOLS: Record<string, PlanTool> = {
  unit_load: {
    description: "Bring a vault unit (a spec note in .overwatch/vault/01 Specs) into the session plan: each open item of its \"## Plan\" checklist becomes a task, each command in its `checks` frontmatter a guard. Refused while the unit is held (waiting on unfinished units, a cycle, blocked, deferred, claimed) or another unit is loaded. vault_plan lists the units and which can start now.",
    properties: { unit: { type: "string", description: "The spec note's name, e.g. \"Parser Recovery\"." } },
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
}
