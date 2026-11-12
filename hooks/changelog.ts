// The changelog: one CHANGELOG.md section per version, newest first, so a project can see
// which version it runs, which one is LTS, and what each version added. `changelog <what
// changed>` records a change under the current version (package.json, else VERSION);
// `backfill` groups every commit under the version that commit saw, so a fresh repo gets a
// full history and a re-run only adds what is missing.
import type { Plan } from "../types/index.d.ts"
import { abs, cmp, readJson, type Io } from "./io.ts"
import { today } from "./io.ts"
import { checkbox } from "./note.ts"
import { EMPTY, refuse, trimmed, type PlanTool, type Result } from "./plan.ts"

export const DEFAULT_FILE = "CHANGELOG.md"
const HEADER = "# Changelog\n\nAll notable changes to this project, one section per version, newest first."
/** `## [0.2.0] - 2026-11-12 (LTS)`; the date and the LTS mark are optional. */
const HEADING = /^## \[([^\]]+)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?(?:\s+\((LTS)\))?\s*$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const UNIT = "\u001f"
const BULLET = /^[-*]\s+/

export type ChangelogEntry = { version: string; date?: string; lts: boolean; body: string[] }
export type ChangelogFile = { preamble: string; entries: ChangelogEntry[] }
type Commit = { sha: string; date: string; subject: string }

const trimBlank = (lines: string[]): string[] => {
  let a = 0
  let b = lines.length
  while (a < b && !lines[a]!.trim()) a++
  while (b > a && !lines[b - 1]!.trim()) b--
  return lines.slice(a, b)
}

/** Version order, newest first; a core version beats its own prerelease (`1.0.0` > `1.0.0-rc`). */
export function versionCmp(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.replace(/^v/, "").split("-", 2)
    return { nums: core.split(".").map((x) => Number.parseInt(x, 10) || 0), pre: pre ?? "" }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d) return d
  }
  if (x.pre === y.pre) return cmp(a, b)
  if (!x.pre) return 1
  if (!y.pre) return -1
  // Semver prerelease order: numeric identifiers compare as numbers and rank below text.
  const xp = x.pre.split(".")
  const yp = y.pre.split(".")
  for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
    const a1 = xp[i]
    const b1 = yp[i]
    if (a1 === undefined) return -1
    if (b1 === undefined) return 1
    const an = /^\d+$/.test(a1) ? Number(a1) : undefined
    const bn = /^\d+$/.test(b1) ? Number(b1) : undefined
    if (an !== undefined && bn !== undefined) {
      if (an !== bn) return an - bn
      continue
    }
    if (an !== undefined) return -1
    if (bn !== undefined) return 1
    const d = cmp(a1, b1)
    if (d) return d
  }
  return 0
}

export function parseChangelog(text: string): ChangelogFile {
  const lines = text.split(/\r?\n/)
  let i = 0
  const preamble: string[] = []
  while (i < lines.length && !HEADING.test(lines[i]!)) preamble.push(lines[i++]!)
  const entries: ChangelogEntry[] = []
  while (i < lines.length) {
    const m = HEADING.exec(lines[i]!)
    if (!m) { i++; continue }
    const body: string[] = []
    i++
    while (i < lines.length && !HEADING.test(lines[i]!)) body.push(lines[i++]!)
    entries.push({ version: m[1]!, date: m[2], lts: m[3] !== undefined, body: trimBlank(body) })
  }
  return { preamble: preamble.join("\n").trimEnd(), entries }
}

export function renderChangelog(f: ChangelogFile): string {
  const head = f.preamble.trim() || HEADER
  const out = [head]
  for (const e of [...f.entries].sort(newestFirst)) {
    out.push(`## [${e.version}]${e.date ? ` - ${e.date}` : ""}${e.lts ? " (LTS)" : ""}`)
    const body = trimBlank(e.body)
    if (body.length) out.push(body.join("\n"))
  }
  return out.join("\n\n") + "\n"
}

/** One bullet line: an already-bulleted or checklist line loses its marker, never repeats it. */
export function bulletLine(text: string): string {
  const bare = text.trim().replace(BULLET, "").trim()
  const box = checkbox(`- ${bare}`)
  return `- ${(box ? box.text : bare).trim()}`
}

/** One change per line from a tool argument, blanks dropped. */
const changeLines = (v: unknown): string[] => (typeof v === "string" ? v.split(/\r?\n/).map(trimmed).filter(Boolean) : [])

const countBullets = (e: ChangelogEntry) => e.body.filter((l) => BULLET.test(l.trim())).length

/** Newest version first: the one ordering rule for rendered sections and status listings. */
const newestFirst = (a: ChangelogEntry, b: ChangelogEntry) => versionCmp(b.version, a.version)

/** Adds each change as a bullet under `version`, creating the section (dated, newest first on render). */
export function addChange(f: ChangelogFile, version: string, changes: string[], date?: string, lts = false, replaceDate = false): { added: string[]; skipped: string[] } {
  let e = f.entries.find((x) => x.version === version)
  if (!e) {
    e = { version, date, lts, body: [] }
    f.entries.push(e)
  } else if (date && (replaceDate || !e.date)) e.date = date
  if (lts) e.lts = true
  const added: string[] = []
  const skipped: string[] = []
  const seen = new Set(e.body.map(bulletLine))
  for (const change of changes) {
    const line = bulletLine(change)
    if (seen.has(line)) skipped.push(change.trim())
    else { e.body.push(line); seen.add(line); added.push(change.trim()) }
  }
  e.body = trimBlank(e.body)
  return { added, skipped }
}

/** The version the project declares now: package.json, then a VERSION file. */
export async function currentVersion(io: Io): Promise<{ version?: string; source: string }> {
  const pkg = await readJson<{ version?: unknown }>(io, abs(io, "package.json"), {})
  const v = typeof pkg?.version === "string" ? pkg.version.trim() : ""
  if (v) return { version: v, source: "package.json" }
  const bare = (await io.read(abs(io, "VERSION")))?.trim()
  if (bare) return { version: bare, source: "VERSION" }
  return { source: "no package.json version or VERSION file" }
}

const firstLine = (s: string) => s.split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? ""

/** The one git failure line both history reads report. */
const gitError = (r: { code: number; stderr: string }) => `git log failed (${r.code})${firstLine(r.stderr) ? `: ${firstLine(r.stderr)}` : ""}`

/** The changelog at `file`; a non-empty file that is not one is refused before it can be rewritten. */
const readChangelog = async (io: Io, file: string): Promise<{ f: ChangelogFile; raw: string } | string> => {
  const raw = (await io.read(abs(io, file))) ?? ""
  const title = firstLine(raw)
  if (raw.trim() && !/^#\s+changelog\b/i.test(title))
    return `${file} exists but is not a changelog (first line: "${title.slice(0, 60)}"); point file at a changelog or remove it`
  return { f: parseChangelog(raw), raw }
}

/** Every commit, newest first, or why git could not list them. */
async function commits(io: Io): Promise<Commit[] | string> {
  const r = await io.run(["git", "log", "--no-merges", `--format=%H${UNIT}%cI${UNIT}%s`], { cwd: io.cwd, timeoutMs: 60_000 })
  if (r.code !== 0) return `${gitError(r)}; backfill needs a git repository at ${io.cwd}`
  return r.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [sha = "", at = "", ...subject] = line.split(UNIT)
    return { sha, date: at.slice(0, 10), subject: subject.join(UNIT) }
  })
}

/**
 * The version each commit saw, newest first: walk commits newest to oldest and switch at each
 * package.json (or VERSION) change. Ceiling: one version per branch position, so a merge-heavy
 * history can put a commit under the version of its newer parent.
 */
async function versionsAt(io: Io): Promise<Map<string, string> | string> {
  const head = await io.run(["git", "log", "--no-merges", "--format=%H", "--", "package.json", "VERSION"], { cwd: io.cwd, timeoutMs: 60_000 })
  if (head.code !== 0) return gitError(head)
  const shas = head.stdout.split(/\r?\n/).filter(Boolean)
  // Batches of 8: one git process per version-touching commit, capped so a long history cannot
  // spawn hundreds at once and lose a version boundary to a resource error.
  const found: [string, string][] = []
  for (let i = 0; i < shas.length; i += 8) {
    const batch = await Promise.all(shas.slice(i, i + 8).map(async (sha) => {
      const pkg = await io.run(["git", "show", `${sha}:package.json`], { cwd: io.cwd, timeoutMs: 10_000 })
      if (pkg.code === 0) {
        try {
          const v = JSON.parse(pkg.stdout)?.version
          if (typeof v === "string" && v.trim()) return [sha, v.trim()] as [string, string]
        } catch {}
      }
      const bare = await io.run(["git", "show", `${sha}:VERSION`], { cwd: io.cwd, timeoutMs: 10_000 })
      return [sha, bare.code === 0 ? bare.stdout.trim() : ""] as [string, string]
    }))
    found.push(...batch)
  }
  return new Map(found.filter(([, v]) => v))
}

/** Commits grouped by the version they saw, newest version first. */
export async function groupCommits(io: Io): Promise<{ groups: [string, Commit[]][]; total: number } | string> {
  const list = await commits(io)
  if (typeof list === "string") return list
  if (!list.length) return "no commits found"
  const versions = await versionsAt(io)
  if (typeof versions === "string") return versions
  if (!versions.size) return "no commit changed package.json or VERSION; pass version, or add a version to package.json or VERSION"
  // Newest bump first. A commit is filed under the version it saw, so the bucket drops to the
  // previous known version only after the bump commit itself, never before it.
  const bumps = [...versions]
  let current = bumps[0]![1]
  let next = 1
  const groups = new Map<string, Commit[]>()
  for (const c of list) {
    const bucket = groups.get(current)
    if (bucket) bucket.push(c)
    else groups.set(current, [c])
    if (c.sha === bumps[next - 1]?.[0]) current = bumps[next++]?.[1] ?? current
  }
  return { groups: [...groups], total: list.length }
}

/** The current version, the LTS version and each section's change count; read-only. */
export async function changelogStatus(io: Io, file: string): Promise<string> {
  const [{ version, source }, text] = await Promise.all([currentVersion(io), io.read(abs(io, file))])
  const entries = text ? parseChangelog(text).entries : []
  const lts = entries.filter((e) => e.lts).map((e) => e.version)
  const versions = [...entries].sort(newestFirst)
  const described = versions.map((e) => {
    const n = countBullets(e)
    return `${e.version} (${n} change${n === 1 ? "" : "s"})`
  })
  return [
    `current version: ${version ?? "unknown"} (${source})`,
    `lts: ${lts.length ? lts.join(", ") : "none"}`,
    `versions: ${described.length ? described.join(", ") : "none"}`,
    `${file}: ${text ? "present" : "missing"}`,
  ].join("\n")
}

/** Rebuilds every version's bullets from git history, keeping bullets already written by hand. */
async function backfill(io: Io, s: Plan, file: string, e: any): Promise<Result> {
  const [grouped, loaded] = await Promise.all([groupCommits(io), readChangelog(io, file)])
  if (typeof grouped === "string") return refuse(s, grouped)
  if (typeof loaded === "string") return refuse(s, loaded)
  const { f, raw } = loaded
  const explicit = trimmed(e.version)
  const date = trimmed(e.date)
  const dateError = badDate(date)
  if (dateError) return refuse(s, dateError)
  const text = changeLines(e.what_changed)
  let added = 0
  let skipped = 0
  for (const [version, list] of grouped.groups) {
    const changes = list.map((c) => `${c.subject} (${c.sha.slice(0, 7)})`)
    const r = addChange(f, version, changes, list[0]?.date)
    added += r.added.length
    skipped += r.skipped.length
  }
  // version, date, lts and text still apply when the history adds no bullet, so a flag never
  // reports a write that did not happen.
  if (text.length || e.lts === true || date) {
    const target = explicit || (await currentVersion(io)).version
    if (!target) return refuse(s, NO_VERSION)
    const r = addChange(f, target, text, date, e.lts === true, !!date)
    added += r.added.length
    skipped += r.skipped.length
  }
  const out = renderChangelog(f)
  const wrote = out !== raw
  if (wrote) await io.write(abs(io, file), out)
  return {
    state: s,
    text: `Backfilled ${file}: ${grouped.groups.length} version(s), ${grouped.total} commit(s), ${added} bullet(s) added${skipped ? `, ${skipped} already present` : ""}${wrote ? "" : "; nothing to change"}.`,
  }
}

/** The changelog tool and CLI: add a change, backfill from git, or report the version state. */
export async function changelog(io: Io, s: Plan, e: any): Promise<Result> {
  const file = trimmed(e.file) || DEFAULT_FILE
  if (e.backfill === true) return backfill(io, s, file, e)
  const changes = changeLines(e.what_changed)
  const date = trimmed(e.date)
  const dateError = badDate(date)
  if (dateError) return refuse(s, dateError)
  const lts = e.lts === true
  if (!changes.length && !lts && !date) return { state: s, text: await changelogStatus(io, file) }
  const { version: current, source } = await currentVersion(io)
  const version = trimmed(e.version) || current
  if (!version) return refuse(s, NO_VERSION)
  const loaded = await readChangelog(io, file)
  if (typeof loaded === "string") return refuse(s, loaded)
  const { f, raw: before } = loaded
  const { added, skipped } = addChange(f, version, changes, date || today(), lts, !!date)
  const out = renderChangelog(f)
  if (out !== before) await io.write(abs(io, file), out)
  const from = trimmed(e.version) ? "" : ` (current ${source})`
  const lines: string[] = []
  if (added.length) lines.push(`Added ${added.length} change(s) to ${file} under ${version}${from}: ${added.join("; ")}`)
  else if (skipped.length) lines.push(`Already in ${file} under ${version}${from}: ${skipped.join("; ")}`)
  else lines.push(`Updated ${file} under ${version}${from}`)
  if (added.length && skipped.length) lines.push(`Already present: ${skipped.join("; ")}`)
  if (lts) lines.push(`${version} is marked LTS`)
  if (date) lines.push(`${version} dated ${date}`)
  return { state: s, text: lines.join("\n") }
}

/** `overwatch changelog [what changed] [--version v] [--file path] [--date YYYY-MM-DD] [--lts] [--backfill]`. */
export const CHANGELOG_USAGE = "usage: changelog [what changed] [--version v] [--file path] [--date YYYY-MM-DD] [--lts] [--backfill]"

/** A bad date, or "" when the date is fine. */
const badDate = (date: string) => (date && !DATE.test(date) ? `date must be YYYY-MM-DD, got "${date}"` : "")
const NO_VERSION = "no version to write under: pass version, or add a version to package.json or VERSION"

export async function changelogCommand(io: Io, argv: string[]): Promise<{ text: string; code: number }> {
  const args: string[] = []
  const e: Record<string, unknown> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--version" || a === "--file" || a === "--date") {
      const v = argv[++i]
      if (v === undefined) return { text: `usage: ${a} needs a value`, code: 2 }
      e[a.slice(2)] = v
    } else if (a === "--lts") e.lts = true
    else if (a === "--backfill") e.backfill = true
    else if (a === "--help" || a === "-h") return { text: CHANGELOG_USAGE, code: 0 }
    else if (a.startsWith("--")) return { text: `unknown flag ${a}` + "\n" + CHANGELOG_USAGE, code: 2 }
    else args.push(a)
  }
  if (args.length) e.what_changed = args.join(" ")
  const r = await changelog(io, EMPTY, e)
  return { text: r.text, code: r.warn ? 1 : 0 }
}

/** The plan tool wrapper: stateless, so the plan comes back unchanged. */
export const CHANGELOG_TOOLS: Record<string, PlanTool> = {
  changelog: {
    description: "Keep CHANGELOG.md, one section per version, newest first. Call with what_changed after a change lands: it writes a bullet under the project's current version (package.json, else VERSION) and creates that version's section when missing. Call with no arguments to see the current version, the LTS version and each version's change count. backfill: true rebuilds every version's bullets from git history, grouped by the version each commit saw, keeping bullets already written. Point file at another changelog; version and date override the defaults; lts marks the section as the long-term-support one.",
    properties: {
      what_changed: { type: "string", description: "One change per line; each becomes a bullet under the current version. Omit to report the version state instead." },
      version: { type: "string", description: "Version to write under; default is the current package.json version." },
      backfill: { type: "boolean", description: "Rebuild every version's bullets from git history, grouped by the version each commit saw; existing bullets are kept." },
      file: { type: "string", description: `Changelog path relative to the project root; default ${DEFAULT_FILE}.` },
      date: { type: "string", description: "Section date as YYYY-MM-DD; default today (UTC)." },
      lts: { type: "boolean", description: "Mark the section as LTS; with version, mark that section." },
    },
    act: changelog,
  },
}
