// The PRD layer over the spec vault: one note per planned outcome under .overwatch/vault/02 PRDs.
// A PRD carries its own acceptance boxes, its needs (other PRDs), its footprint and its checks;
// its "## Specs" section links the units from 01 Specs that implement it. States are stored in the
// note (open, question, refine, specced, blocked, failed, done); `done` is written only by
// prdCollect, which refuses without a fresh review round of at least 90 and every linked unit
// implemented. A need is resolved when it is done, or refined and all of its children are done.
// Ported from pearde's board flow (scan, next, brief, refine, review, collect).
import { type Io } from "./io.ts"
import { checkReport, runChecks } from "./plan.ts"
import { BAD_NAME, frontmatter, gitState, patchFrontmatter, readVault, replaceSection, section, sha256, specsOf, str, strings, vaultInit, vaultPath, vaultPlan, writePlan, type Fields, type Spec } from "./vault.ts"
import type { Guard } from "../types/index.d.ts"

export const PRDS = "02 PRDs"
export const PRD_TEMPLATE = "00 Meta/PRD Template.md"
export const PRD_STATES = ["open", "question", "refine", "specced", "blocked", "failed", "done"] as const
export type PrdState = (typeof PRD_STATES)[number]
/** States a PRD can be set to by hand; `done` only through prdCollect. */
export const SET_STATES = ["open", "question", "refine", "specced", "blocked", "failed"] as const
/** States work can start from; every other state is held with its reason. */
const STARTABLE = new Set<string>(["open", "specced"])
const PARKED: Record<string, string> = {
  question: "state: question (answer it, then prd_set open)",
  refine: "state: refine (prd_refine splits it into children)",
  failed: "state: failed (review rounds are spent; split it or set it open again)",
}
export const GATE_SCORE = 90
export const GATE_ROUNDS = 5

export type Box = { done: boolean; text: string }
export type Round = { round: number; score: number; digest: string; date: string; reviewer: string }

export type Prd = {
  name: string
  /** Relative to the vault. */
  path: string
  status: string
  priority: number
  parent: string
  owner: string
  /** Why it was blocked, as stored in the note. */
  blocked: string
  needs: string[]
  footprint: string[]
  checks: string[]
  /** Names of the units in 01 Specs that implement this PRD. */
  specs: string[]
  acceptance: Box[]
  rounds: Round[]
  /** How many of `rounds` belong to an earlier attempt, before the last reopen. */
  attemptStart: number
  text: string
}

/** One note line from user text: whitespace collapsed, so no value can split a section. */
const nonEmpty = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "")
const list = (v: unknown) => strings(Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean)

/** Template guidance lives in HTML comments; nothing inside one is a box, a unit link or a round. */
const comments = (t: string) => t.replace(/<!--[\s\S]*?-->/g, "")

const BOX = /^\s*- \[([ xX])\] (.+?)\s*$/
const boxes = (text: string): Box[] =>
  comments(section(text, "Acceptance") ?? "").split(/\r?\n/).flatMap((l) => { const m = BOX.exec(l); return m ? [{ done: m[1] !== " ", text: m[2] }] : [] })

/** `[[Unit]]` or `[[Unit|alias]]` in the "## Specs" section, one unit per link. */
const links = (text: string): string[] => [...comments(section(text, "Specs") ?? "").matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((m) => m[1].trim()).filter(Boolean)

/** `- round 2 · 91/100 · digest abcdef0123456789 · 2026-11-12 · agent reviewer`. */
const ROUND = /^-\s*round\s+(\d+)\s*·\s*(\d+)\/100\s*·\s*digest\s+([0-9a-f]+)\s*·\s*(\S+)\s*·\s*(.+?)\s*$/
/** `- reopened 2026-11-12 · rounds reset` starts a fresh review allowance. */
const REOPEN = /^-\s*reopened\b/
function rounds(text: string): { list: Round[]; attemptStart: number } {
  const list: Round[] = []
  let attemptStart = 0
  for (const l of comments(section(text, "Review") ?? "").split(/\r?\n/)) {
    if (REOPEN.test(l)) { attemptStart = list.length; continue }
    const m = ROUND.exec(l)
    if (m) list.push({ round: Number(m[1]), score: Number(m[2]), digest: m[3], date: m[4], reviewer: m[5] })
  }
  return { list, attemptStart }
}

export function parsePrd(path: string, text: string): Prd {
  const { fields } = frontmatter(text)
  const priority = Number(fields.priority)
  const attempt = rounds(text)
  return {
    name: path.split("/").pop()!.replace(/\.md$/, ""),
    path,
    status: str(fields.status),
    priority: Number.isFinite(priority) ? priority : 50,
    parent: str(fields.parent),
    owner: str(fields.owner),
    blocked: str(fields.blocked),
    needs: strings(fields.needs).map((d) => d.replace(/^\[\[|\]\]$/g, "")),
    footprint: strings(fields.footprint),
    checks: strings(fields.checks),
    specs: links(text),
    acceptance: boxes(text),
    rounds: attempt.list,
    attemptStart: attempt.attemptStart,
    text,
  }
}

type Board = { prds: Prd[]; all: Map<string, Prd>; specs: Spec[] }

/** The PRD a need or a parent names, matched the way pick() matches a request. */
const at = (all: Map<string, Prd>, name: string) => all.get(name.toLowerCase())
const key = (p: Prd) => p.name.toLowerCase()

/** One read of the vault for every view: the PRD board, by name, and the units it links. */
async function board(io: Io): Promise<Board> {
  const notes = await readVault(io)
  const prds = [...notes].filter(([p]) => p.startsWith(PRDS + "/")).map(([p, text]) => parsePrd(p, text))
  return { prds, all: new Map(prds.map((p) => [key(p), p])), specs: specsOf(notes) }
}

const none = (io: Io) => `no PRDs yet in ${vaultPath(io, PRDS)}; prd_add writes one`

function pick(b: Board, name: string): Prd | string {
  const hit = b.prds.find((p) => p.name === name) ?? b.prds.find((p) => p.name.toLowerCase() === name.toLowerCase())
  return hit ?? (b.prds.length ? `no PRD "${name}"; PRDs: ${b.prds.map((p) => p.name).join(", ")}` : "no PRDs yet; prd_add writes one")
}

export async function findPrd(io: Io, name: string): Promise<Prd | string> {
  return pick(await board(io), name)
}

async function requirePrd(io: Io, name: string): Promise<Prd> {
  const found = await findPrd(io, name)
  if (typeof found === "string") throw new Error(found)
  return found
}

/**
 * The reviewed contract: the acceptance text, the PRD's own checks and, for every linked unit that
 * exists, its Plan items and checks. A review round is bound to this digest, so editing any of them
 * makes the round stale; a unit added later changes the digest too. Template comments and the note's
 * layout stay out of it.
 */
export async function contractDigest(io: Io, p: Prd, specs?: Spec[]): Promise<string> {
  const units = (specs ?? specsOf(await readVault(io))).filter((s) => p.specs.includes(s.name))
  const contract = [p.acceptance.map((b) => b.text), p.checks, units.map((s) => [s.name, s.items.map((i) => i.text), s.checks])]
  return (await sha256(JSON.stringify(contract))).slice(0, 16)
}

export type Gate = { ok: boolean; line: string }

/** Whether the last review round accepts the current contract. */
export function gate(p: Prd, digest: string): Gate {
  const last = p.rounds[p.rounds.length - 1]
  if (!last) return { ok: false, line: "review: none yet; prd_review records a round" }
  if (last.digest !== digest) return { ok: false, line: `review: stale — round ${last.round} reviewed a different contract; review again` }
  if (last.score < GATE_SCORE) return { ok: false, line: `review: round ${last.round} scored ${last.score} < ${GATE_SCORE}; revise and review again` }
  return { ok: true, line: `review: round ${last.round} · ${last.score}/100 · ${last.reviewer}` }
}

/** A need is resolved when it is done, or refined and every child it was split into is done. */
function resolved(name: string, all: Map<string, Prd>): boolean {
  const p = at(all, name)
  if (!p) return false
  if (p.status === "done") return true
  if (p.status !== "refine") return false
  const children = [...all.values()].filter((c) => c.parent && c.parent.toLowerCase() === key(p))
  return children.length > 0 && children.every((c) => c.status === "done")
}

/** Why a PRD cannot start now (empty when it can). The one rule scan, next, brief and collect share. */
export function held(p: Prd, all: Map<string, Prd>): string {
  if (p.status === "done") return "done"
  if (!STARTABLE.has(p.status)) return p.status === "blocked" && p.blocked ? `state: blocked — ${p.blocked}` : PARKED[p.status] ?? `state: ${p.status || "none"}`
  if (p.owner) return `claimed by ${p.owner}`
  const missing = p.needs.filter((n) => !at(all, n))
  if (missing.length) return `missing needs ${missing.join(", ")}`
  const open = p.needs.filter((n) => !resolved(n, all))
  if (open.length) return `needs: ${open.join(", ")}`
  return ""
}

/** Whether work on this PRD can start now; `held` says why not. */
export const ready = (p: Prd, all: Map<string, Prd>) => held(p, all) === ""

const openBoxes = (p: Prd) => p.acceptance.filter((b) => !b.done).length

/** The one-line state of a PRD, shared by scan, next and brief. */
function line(p: Prd, all: Map<string, Prd>, digest: string): string {
  const why = held(p, all)
  return [
    `${p.name} · ${p.status}${p.owner ? ` (${p.owner})` : ""} · acceptance ${p.acceptance.length - openBoxes(p)}/${p.acceptance.length}`,
    `${p.specs.length} spec(s)`,
    gate(p, digest).line,
    why ? `held: ${why}` : "ready",
  ].join(" · ")
}

/** Every PRD, one line each; `next` lists the ready ones, most important first. */
export async function prdScan(io: Io): Promise<string> {
  const b = await board(io)
  if (!b.prds.length) return none(io)
  const sorted = [...b.prds].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))
  const lines = await Promise.all(sorted.map(async (p) => line(p, b.all, await contractDigest(io, p, b.specs))))
  const readyCount = b.prds.filter((p) => ready(p, b.all)).length
  const done = b.prds.filter((p) => p.status === "done").length
  return [...lines, "", `${b.prds.length} PRD(s) · ${readyCount} ready · ${done} done`].join("\n")
}

export async function prdNext(io: Io, limit = 10): Promise<string> {
  const b = await board(io)
  const startable = b.prds
    .filter((p) => ready(p, b.all))
    .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))
  if (!startable.length) return b.prds.length ? "nothing ready: every live PRD is held, claimed or done (prd_scan says why)" : none(io)
  const take = startable.slice(0, Math.max(1, Math.min(50, limit)))
  return [`${startable.length} ready; showing ${take.length}`, ...take.map((p) => `- ${p.name} · ${p.status} · acceptance ${p.acceptance.length - openBoxes(p)}/${p.acceptance.length} · ${p.specs.length} spec(s) · priority ${p.priority}`)].join("\n")
}

/** Everything a worker needs for one PRD without reading the vault: contract, needs, specs, review. */
export async function prdBrief(io: Io, name: string): Promise<string> {
  const b = await board(io)
  const found = pick(b, name)
  if (typeof found === "string") return found
  const p = found
  const specs = b.specs.filter((s) => p.specs.includes(s.name))
  const missing = p.specs.filter((n) => !specs.some((s) => s.name === n))
  const g = gate(p, await contractDigest(io, p, b.specs))
  const why = held(p, b.all)
  const acceptance = p.acceptance.length ? p.acceptance.map((x) => `- [${x.done ? "x" : " "}] ${x.text}`) : ["(none: add acceptance boxes before specced)"]
  const specLines = specs.map((s) => {
    const open = s.items.filter((i) => !i.done).length
    return `- ${s.name} · ${s.status} · ${open} open Plan item(s)${s.checks.length ? ` · checks: ${s.checks.join("; ")}` : ""}`
  })
  let next = `next: work the linked units (unit_load), then prd_collect ${p.name}`
  if (why) next = `next: ${why}`
  else if (!p.specs.length) next = `next: write the units in 01 Specs and link them under "## Specs", then prd_set ${p.name} specced`
  else if (!g.ok) next = `next: prd_review ${p.name} once the units are written: an independent reviewer scores the contract, ${GATE_SCORE} passes`
  return [
    `# ${p.name} · ${p.status} · priority ${p.priority}`,
    `${p.path}${p.parent ? ` · parent ${p.parent}` : ""}`,
    "",
    ...acceptance,
    "",
    `needs: ${p.needs.length ? p.needs.map((n) => `${n} (${at(b.all, n)?.status ?? "missing"})`).join(", ") : "none"}`,
    `footprint: ${p.footprint.length ? p.footprint.join(", ") : "unset"}`,
    `checks: ${p.checks.length ? p.checks.join("; ") : "none"}`,
    `specs: ${specLines.length ? "" : "none yet; write units in 01 Specs and link them under \"## Specs\""}`,
    ...specLines,
    ...(missing.length ? [`missing units: ${missing.join(", ")}`] : []),
    "",
    g.line,
    `held: ${why || "no"}`,
    "",
    next,
  ].join("\n")
}

type Note = { title: string; parent?: string; summary?: string; priority?: unknown; acceptance?: string[]; needs?: string[]; footprint?: string[]; checks?: string[] }

/** Writes one PRD note from the template; the vault (and its template) is created first when missing. */
async function addNote(io: Io, e: Note): Promise<string> {
  if (!(await io.exists(vaultPath(io, PRD_TEMPLATE)))) await vaultInit(io)
  const file = vaultPath(io, PRDS, `${e.title}.md`)
  if (await io.exists(file)) throw new Error(`${PRDS}/${e.title}.md exists; edit it instead`)
  const template = (await io.read(vaultPath(io, PRD_TEMPLATE))) ?? ""
  const date = new Date().toISOString().slice(0, 10)
  const priority = Number(e.priority)
  const changes: Fields = {}
  if (e.priority !== undefined && Number.isFinite(priority)) changes.priority = priority
  if (e.parent) changes.parent = e.parent
  if (e.needs?.length) changes.needs = e.needs
  if (e.footprint?.length) changes.footprint = e.footprint
  if (e.checks?.length) changes.checks = e.checks
  let text = template.replaceAll("{{title}}", e.title).replaceAll("{{date}}", date)
  if (Object.keys(changes).length) text = patchFrontmatter(text, changes)
  if (e.summary) text = replaceSection(text, "Summary", e.summary)
  if (e.acceptance?.length) text = replaceSection(text, "Acceptance", e.acceptance.map((a) => `- [ ] ${a}`).join("\n"))
  await io.write(file, text)
  return `${PRDS}/${e.title}.md`
}

const nameProblem = (title: string) => !title || BAD_NAME.test(title) || /^[._]/.test(title)

/** Adds a PRD note from the template; the vault (and its template) is created first when missing. */
export async function prdAdd(io: Io, e: { title?: unknown; summary?: unknown; acceptance?: unknown; needs?: unknown; footprint?: unknown; checks?: unknown; parent?: unknown; priority?: unknown }): Promise<string> {
  const title = nonEmpty(e.title)
  if (nameProblem(title)) throw new Error(`prd_add needs a title usable as a note name (none of ${`\\ / : * ? " < > | # ^ [ ]`}; not starting with . or _)`)
  const name = nonEmpty(e.parent), needsIn = list(e.needs)
  const b = name || needsIn.length ? await board(io) : undefined
  let parent = name
  if (name && b) {
    const found = pick(b, name)
    if (typeof found === "string") throw new Error(found)
    parent = found.name
  }
  const acceptance = list(e.acceptance), footprint = list(e.footprint), checks = list(e.checks)
  // A need that names no PRD is kept as written: it holds the PRD until that note exists.
  const needs = needsIn.map((n) => { const found = b && pick(b, n); return typeof found === "string" || !found ? n : found.name })
  await addNote(io, { title, parent, summary: nonEmpty(e.summary), priority: e.priority, acceptance, needs, footprint, checks })
  await writePlan(io)
  return `Added ${PRDS}/${title}.md (status open${acceptance.length ? `, ${acceptance.length} acceptance box(es)` : ""}${needs.length ? `, needs ${needs.join(", ")}` : ""}). Link its units under "## Specs"; prd_next lists it when its needs are done.`
}

/** Splits an open PRD into child PRDs on the same board; the parent becomes `refine` and holds the index. */
export async function prdRefine(io: Io, e: { prd?: unknown; children?: unknown; summary?: unknown }): Promise<string> {
  const name = nonEmpty(e.prd)
  if (!name) throw new Error("prd_refine needs the PRD's note name")
  const b = await board(io)
  const found = pick(b, name)
  if (typeof found === "string") throw new Error(found)
  if (found.status !== "open" && found.status !== "question") throw new Error(`prd_refine needs an open or question PRD; "${found.name}" is ${found.status}`)
  const children = list(e.children)
  if (!children.length) throw new Error("prd_refine needs children: one title per independent outcome")
  for (const c of children) if (nameProblem(c)) throw new Error(`"${c}" is not usable as a note name`)
  const taken = new Set(b.prds.map((p) => p.name.toLowerCase()))
  const seen = new Set<string>()
  const clash = children.filter((c) => { const k = c.toLowerCase(); const hit = taken.has(k) || seen.has(k); seen.add(k); return hit })
  if (clash.length) throw new Error(`already in ${PRDS}: ${clash.join(", ")}`)
  const summary = nonEmpty(e.summary)
  const added = await Promise.all(children.map(async (c) => `Added ${await addNote(io, { title: c, parent: found.name, summary })} (parent ${found.name})`))
  await io.write(vaultPath(io, found.path), patchFrontmatter(found.text, { status: "refine", updated: new Date().toISOString().slice(0, 10) }))
  await writePlan(io)
  return `Refined "${found.name}" into ${children.length} child PRD(s): ${children.join(", ")} (parent set to refine).\n${added.join("\n")}`
}

/** Sets a PRD's state by hand; `done` stays with prd_collect and `specced` needs at least one linked unit. */
export async function prdSet(io: Io, e: { prd?: unknown; state?: unknown; reason?: unknown }): Promise<string> {
  const name = nonEmpty(e.prd)
  const state = nonEmpty(e.state)
  if (!name) throw new Error("prd_set needs the PRD's note name")
  if (!(SET_STATES as readonly string[]).includes(state)) throw new Error(`state must be one of ${SET_STATES.join(", ")} (done is written by prd_collect)`)
  const found = await requirePrd(io, name)
  if (found.status === "done") throw new Error(`"${found.name}" is done; its record is final`)
  if (state === "specced" && !found.specs.length) throw new Error(`"${found.name}" has no linked units; write them in 01 Specs and link them under "## Specs" first`)
  const reason = nonEmpty(e.reason)
  if (state === "blocked" && !reason) throw new Error("blocked needs a reason: what holds it and what would unblock it")
  const date = new Date().toISOString().slice(0, 10)
  let text = patchFrontmatter(found.text, { status: state, blocked: state === "blocked" ? reason : null, updated: date })
  // Reopening a failed PRD is the advertised recovery, so it starts a fresh review allowance.
  const reopened = found.status === "failed" && STARTABLE.has(state)
  if (reopened) {
    text = appendReview(text, `- reopened ${date} · rounds reset`)
  }
  await io.write(vaultPath(io, found.path), text)
  await writePlan(io)
  return `"${found.name}" is ${state}${reopened ? " (review rounds reset)" : ""}${reason ? `: ${reason}` : ""}`
}

/** The note with one more line at the end of its Review section, the format every review writer shares. */
const appendReview = (text: string, line: string) => {
  const kept = (section(text, "Review") ?? "").trim()
  return replaceSection(text, "Review", kept ? `${kept}\n${line}` : line)
}

const MAX_FINDINGS = 600

/**
 * Records one attributed review round against the current contract digest. The contract is the
 * acceptance text, the PRD's checks and every linked unit's Plan items and checks, so any later
 * edit makes the round stale. At most five rounds per PRD; a sixth is refused, and a PRD still
 * below the gate on its fifth round is set failed.
 */
export async function prdReview(io: Io, e: { prd?: unknown; score?: unknown; reviewer?: unknown; findings?: unknown }): Promise<string> {
  const name = nonEmpty(e.prd)
  if (!name) throw new Error("prd_review needs the PRD's note name")
  const score = Number(e.score)
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error("score is 0 to 100")
  const reviewer = nonEmpty(e.reviewer)
  if (!reviewer) throw new Error("prd_review needs the reviewer: who scored it (an agent id or name)")
  const b = await board(io)
  const found = pick(b, name)
  if (typeof found === "string") throw new Error(found)
  if (found.status === "done") throw new Error(`"${found.name}" is done; its record is final`)
  const used = found.rounds.length - found.attemptStart
  if (used >= GATE_ROUNDS) throw new Error(`"${found.name}" used all ${GATE_ROUNDS} review rounds since it was opened; the allowance is exhausted`)
  const digest = await contractDigest(io, found, b.specs)
  const round = found.rounds.length + 1
  const date = new Date().toISOString().slice(0, 10)
  const findings = nonEmpty(e.findings)
  const blocked = Math.round(score) < GATE_SCORE
  const spent = blocked && used + 1 >= GATE_ROUNDS
  const entry = [`- round ${round} · ${Math.round(score)}/100 · digest ${digest} · ${date} · ${reviewer}`, ...(findings ? [`  - finding: ${findings.slice(0, MAX_FINDINGS)}`] : [])].join("\n")
  let text = appendReview(found.text, entry)
  text = patchFrontmatter(text, { updated: date, ...(spent ? { status: "failed" } : {}) })
  await io.write(vaultPath(io, found.path), text)
  await writePlan(io)
  const verdict = spent
    ? `below ${GATE_SCORE} on the last allowed round: the PRD is failed; split it or prd_set it open again`
    : blocked
      ? `below ${GATE_SCORE}: revise and review again (${GATE_ROUNDS - used - 1} round(s) left)`
      : `passes the gate; prd_collect can run once the units are implemented`
  return `Recorded review round ${round}/${GATE_ROUNDS} for "${found.name}": ${Math.round(score)}/100 by ${reviewer} · ${verdict}`
}

/**
 * Collects a PRD as done against evidence: its needs resolved, no open acceptance box, every linked
 * unit implemented with its Plan items ticked, a fresh review round at or above the gate, every
 * `checks` command passing at HEAD and a clean tree outside .overwatch afterwards. Writes the proof
 * and the collection receipt into the note. Nothing is written before every gate holds.
 */
export async function prdCollect(io: Io, e: { prd?: unknown; summary?: unknown }): Promise<string> {
  const name = nonEmpty(e.prd)
  if (!name) throw new Error("prd_collect needs the PRD's note name")
  const b = await board(io)
  const found = pick(b, name)
  if (typeof found === "string") throw new Error(found)
  const p = found
  if (p.status === "done") return `"${p.name}" is already collected.`
  const why = held(p, b.all)
  if (why) throw new Error(`prd_collect: "${p.name}" is held: ${why}`)
  if (!p.acceptance.length) throw new Error(`prd_collect: "${p.name}" has no acceptance boxes; collect needs observed outcomes`)
  const open = p.acceptance.filter((x) => !x.done)
  if (open.length) throw new Error(`prd_collect: ${open.length} open acceptance box(es):\n${open.map((x) => `- [ ] ${x.text}`).join("\n")}`)
  if (!p.specs.length) throw new Error(`prd_collect: "${p.name}" links no units; prd_set specced needs them and collect verifies each`)
  const byName = new Map(b.specs.map((s) => [s.name, s]))
  const missing = p.specs.filter((n) => !byName.has(n))
  if (missing.length) throw new Error(`prd_collect: linked units not found in ${vaultPath(io, "01 Specs")}: ${missing.join(", ")}`)
  const linked = p.specs.map((n) => byName.get(n)!)
  const unfinished = linked.filter((s) => s.status !== "implemented" || s.items.some((i) => !i.done))
  if (unfinished.length) throw new Error(`prd_collect: units not implemented (or Plan items open):\n${unfinished.map((s) => `- ${s.name} · ${s.status} · ${s.items.filter((i) => !i.done).length} open item(s)`).join("\n")}`)
  const digest = await contractDigest(io, p, b.specs)
  const g = gate(p, digest)
  if (!g.ok) throw new Error(`prd_collect: ${g.line}`)
  const decided = await runChecks(io.run, p.checks, io.cwd, "prd check")
  const failed = decided.filter((x) => !x.met)
  if (failed.length) throw new Error(`prd_collect: checks failing, nothing recorded:\n${checkReport(failed)}`)
  const git = await gitState(io)
  if (typeof git === "string") throw new Error(git)
  if (git.dirty.length) throw new Error(`prd_collect: commit the work first; uncommitted: ${git.dirty.slice(0, 8).join(", ")}${git.dirty.length > 8 ? " …" : ""}`)
  const date = new Date().toISOString().slice(0, 10)
  const summary = nonEmpty(e.summary) || `Collected at ${git.commit.slice(0, 12)} with ${linked.length} implemented unit(s).`
  const proof = `${git.commit} · ${g.line} · ${decided.length} check(s) exit 0`
  const receipt = [
    `- collected ${date} at ${git.commit}`,
    `- ${g.line}`,
    `- units: ${linked.map((s) => `${s.name} (implemented)`).join(", ")}`,
    `- checks: ${decided.length ? decided.map((x) => `\`${x.check}\` exit 0`).join(", ") : "none declared"}`,
    `- digest ${digest}`,
  ].join("\n")
  let text = patchFrontmatter(p.text, { status: "done", proof, updated: date, blocked: null })
  text = replaceSection(text, "Status", summary)
  text = replaceSection(text, "Collection", receipt)
  await io.write(vaultPath(io, p.path), text)
  await vaultPlan(io)
  return `Collected "${p.name}" as done at ${git.commit.slice(0, 12)}; ${linked.length} unit(s), ${decided.length} check(s) exit 0. Commit the note: git add .overwatch/vault && git commit -m "prd: collect ${p.name}"`
}
