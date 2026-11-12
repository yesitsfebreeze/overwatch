// The PRD layer over the spec vault: one note per planned outcome under .overwatch/vault/02 PRDs.
// A PRD carries its own acceptance boxes, its needs (other PRDs), its footprint and its checks;
// its "## Specs" section links the units from 01 Specs that implement it. States are stored in the
// note (open, question, refine, specced, blocked, failed, done); `done` is written only by
// prdCollect, which refuses without a fresh review round of at least 90 and every linked unit
// implemented. Ported from pearde's board flow (scan, next, brief, refine, review, collect).
import { shellArgv, type Io } from "./io.ts"
import { CHECK_TIMEOUT_MS } from "./plan.ts"
import { frontmatter, gitState, patchFrontmatter, readVault, replaceSection, section, sha256, specsOf, vaultInit, vaultPath, vaultPlan, type Fields, type Spec } from "./vault.ts"

export const PRDS = "02 PRDs"
export const PRD_TEMPLATE = "00 Meta/PRD Template.md"
export const PRD_STATES = ["open", "question", "refine", "specced", "blocked", "failed", "done"] as const
export type PrdState = (typeof PRD_STATES)[number]
/** States a PRD can be set to by hand; `done` only through prdCollect. */
export const SET_STATES = ["open", "question", "refine", "specced", "blocked", "failed"] as const
/** States that still hold work; the rest are finished or parked for good. */
const LIVE = new Set<string>(["open", "question", "refine", "specced", "blocked", "failed"])
export const GATE_SCORE = 90
export const GATE_ROUNDS = 5

export type Box = { done: boolean; text: string }
export type Round = { round: number; score: number; digest: string; date: string; reviewer: string }

export type Prd = {
  name: string
  /** Relative to the vault. */
  path: string
  fields: Fields
  status: string
  priority: number
  parent: string
  owner: string
  needs: string[]
  footprint: string[]
  checks: string[]
  /** Names of the units in 01 Specs that implement this PRD. */
  specs: string[]
  acceptance: Box[]
  rounds: Round[]
  text: string
}

const strs = (v: Fields[string] | undefined): string[] => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map(String).filter(Boolean)
const str = (v: Fields[string] | undefined) => (v == null ? "" : String(v))

/** Template guidance lives in HTML comments; nothing inside one is a box, a unit link or a round. */
const comments = (t: string) => t.replace(/<!--[\s\S]*?-->/g, "")

const BOX = /^\s*- \[([ xX])\] (.+?)\s*$/
const boxes = (text: string): Box[] =>
  comments(section(text, "Acceptance") ?? "").split(/\r?\n/).flatMap((l) => { const m = BOX.exec(l); return m ? [{ done: m[1] !== " ", text: m[2] }] : [] })

/** `[[Unit]]` or `[[Unit|alias]]` in the "## Specs" section, one unit per link. */
const links = (text: string): string[] => [...comments(section(text, "Specs") ?? "").matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((m) => m[1].trim()).filter(Boolean)

/** `- round 2 · 91/100 · digest abcdef0123456789 · 2026-11-12 · agent reviewer`. */
const ROUND = /^-\s*round\s+(\d+)\s*·\s*(\d+)\/100\s*·\s*digest\s+([0-9a-f]+)\s*·\s*(\S+)\s*·\s*(.+?)\s*$/
const rounds = (text: string): Round[] =>
  comments(section(text, "Review") ?? "").split(/\r?\n/).flatMap((l) => {
    const m = ROUND.exec(l)
    return m ? [{ round: Number(m[1]), score: Number(m[2]), digest: m[3], date: m[4], reviewer: m[5] }] : []
  })

export function parsePrd(path: string, text: string): Prd {
  const { fields } = frontmatter(text)
  const priority = Number(fields.priority)
  return {
    name: path.split("/").pop()!.replace(/\.md$/, ""),
    path,
    fields,
    status: str(fields.status),
    priority: Number.isFinite(priority) ? priority : 50,
    parent: str(fields.parent),
    owner: str(fields.owner),
    needs: strs(fields.needs).map((d) => d.replace(/^\[\[|\]\]$/g, "")),
    footprint: strs(fields.footprint),
    checks: strs(fields.checks),
    specs: links(text),
    acceptance: boxes(text),
    rounds: rounds(text),
    text,
  }
}

async function readPrds(io: Io): Promise<Prd[]> {
  return [...(await readVault(io))].filter(([p]) => p.startsWith(PRDS + "/")).map(([p, text]) => parsePrd(p, text))
}

export async function findPrd(io: Io, name: string): Promise<Prd | string> {
  const all = await readPrds(io)
  const hit = all.find((p) => p.name === name) ?? all.find((p) => p.name.toLowerCase() === name.toLowerCase())
  return hit ?? (all.length ? `no PRD "${name}"; PRDs: ${all.map((p) => p.name).join(", ")}` : `no PRDs yet in ${vaultPath(io, PRDS)}; prd_add writes one`)
}

/**
 * The reviewed contract: the acceptance section and, for every linked unit that exists, its Plan
 * items and checks. A review round is bound to this digest, so editing any of them makes the round
 * stale; a unit added later changes the digest too.
 */
export async function contractDigest(io: Io, p: Prd, specs?: Spec[]): Promise<string> {
  const units = (specs ?? specsOf(await readVault(io))).filter((s) => p.specs.includes(s.name))
  const acceptance = (section(p.text, "Acceptance") ?? "").replace(/\s+/g, " ").trim()
  return (await sha256(JSON.stringify([acceptance, units.map((s) => [s.name, s.items.map((i) => i.text), s.checks])]))).slice(0, 16)
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

/** Why a PRD cannot start now (empty when it can), and the needs it waits on. */
export function held(p: Prd, all: Map<string, Prd>): string {
  if (p.status === "done") return "done"
  if (!LIVE.has(p.status)) return `state: ${p.status || "none"}`
  if (p.owner) return `claimed by ${p.owner}`
  const missing = p.needs.filter((n) => !all.has(n))
  if (missing.length) return `missing needs ${missing.join(", ")}`
  const open = p.needs.filter((n) => all.get(n)!.status !== "done")
  if (open.length) return `needs: ${open.join(", ")}`
  return ""
}

const openBoxes = (p: Prd) => p.acceptance.filter((b) => !b.done).length

/** The one-line state of a PRD, shared by scan, next and brief. */
function line(p: Prd, all: Map<string, Prd>, digest: string): string {
  const why = held(p, all)
  const g = gate(p, digest)
  return [
    `${p.name} · ${p.status}${p.owner ? ` (${p.owner})` : ""} · acceptance ${p.acceptance.length - openBoxes(p)}/${p.acceptance.length}`,
    `${p.specs.length} spec(s)`,
    g.line,
    why ? `held: ${why}` : "ready",
  ].join(" · ")
}

/** Every PRD, one line each; `next` lists the ready ones, most important first. */
export async function prdScan(io: Io): Promise<string> {
  const all = await readPrds(io)
  if (!all.length) return `no PRDs yet in ${vaultPath(io, PRDS)}; prd_add writes one`
  const byName = new Map(all.map((p) => [p.name, p]))
  const out: string[] = []
  for (const p of [...all].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name)))
    out.push(line(p, byName, await contractDigest(io, p)))
  const ready = all.filter((p) => !held(p, byName) && (p.status === "open" || p.status === "specced"))
  out.push("", `${all.length} PRD(s) · ${ready.length} ready · ${all.filter((p) => p.status === "done").length} done`)
  return out.join("\n")
}

export async function prdNext(io: Io, limit = 10): Promise<string> {
  const all = await readPrds(io)
  const byName = new Map(all.map((p) => [p.name, p]))
  const ready = all
    .filter((p) => !held(p, byName) && (p.status === "open" || p.status === "specced"))
    .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))
  if (!ready.length) return all.length ? "nothing ready: every live PRD is held, claimed or done (prd_scan says why)" : `no PRDs yet in ${vaultPath(io, PRDS)}; prd_add writes one`
  const take = ready.slice(0, Math.max(1, Math.min(50, limit)))
  return [`${ready.length} ready; showing ${take.length}`, ...take.map((p) => `- ${p.name} · ${p.status} · acceptance ${p.acceptance.length - openBoxes(p)}/${p.acceptance.length} · ${p.specs.length} spec(s) · priority ${p.priority}`)].join("\n")
}

/** Everything a worker needs for one PRD without reading the vault: contract, needs, specs, review. */
export async function prdBrief(io: Io, name: string): Promise<string> {
  const found = await findPrd(io, name)
  if (typeof found === "string") return found
  const p = found
  const all = new Map((await readPrds(io)).map((x) => [x.name, x]))
  const specs = specsOf(await readVault(io)).filter((s) => p.specs.includes(s.name))
  const missing = p.specs.filter((n) => !specs.some((s) => s.name === n))
  const digest = await contractDigest(io, p, specs)
  const g = gate(p, digest)
  const acceptance = p.acceptance.length ? p.acceptance.map((b) => `- [${b.done ? "x" : " "}] ${b.text}`) : ["(none: add acceptance boxes before specced)"]
  const specLines = specs.map((s) => {
    const open = s.items.filter((i) => !i.done).length
    return `- ${s.name} · ${s.status} · ${open} open Plan item(s)${s.checks.length ? ` · checks: ${s.checks.join("; ")}` : ""}`
  })
  return [
    `# ${p.name} · ${p.status} · priority ${p.priority}`,
    `${p.path}${p.parent ? ` · parent ${p.parent}` : ""}`,
    "",
    ...acceptance,
    "",
    `needs: ${p.needs.length ? p.needs.map((n) => `${n} (${all.get(n)?.status ?? "missing"})`).join(", ") : "none"}`,
    `footprint: ${p.footprint.length ? p.footprint.join(", ") : "unset"}`,
    `checks: ${p.checks.length ? p.checks.join("; ") : "none"}`,
    `specs: ${specLines.length ? "" : "none yet; write units in 01 Specs and link them under \"## Specs\""}`,
    ...specLines,
    ...(missing.length ? [`missing units: ${missing.join(", ")}`] : []),
    "",
    g.line,
    `held: ${held(p, all) || "no"}`,
    "",
    p.status === "open"
      ? `next: prd_set ${p.name} specced once the units exist, then prd_review; collect needs a fresh round >= ${GATE_SCORE}`
      : `next: work the linked units (unit_load), then prd_review and prd_collect`,
  ].join("\n")
}

const BAD_NAME = /[\\/:*?"<>|#^[\]]/
const list = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean)
const nonEmpty = (v: unknown) => (typeof v === "string" ? v.trim() : "")

/** Adds a PRD note from the template; the vault (and its template) is created first when missing. */
export async function prdAdd(io: Io, e: { title?: unknown; summary?: unknown; acceptance?: unknown; needs?: unknown; footprint?: unknown; checks?: unknown; parent?: unknown; priority?: unknown }): Promise<string> {
  const title = nonEmpty(e.title)
  if (!title || BAD_NAME.test(title) || /^[._]/.test(title)) throw new Error(`prd_add needs a title usable as a note name (none of \\ / : * ? " < > | # ^ [ ]; not starting with . or _)`)
  if (!(await io.exists(vaultPath(io, PRD_TEMPLATE)))) await vaultInit(io)
  const file = vaultPath(io, PRDS, `${title}.md`)
  if (await io.exists(file)) throw new Error(`${PRDS}/${title}.md exists; edit it instead`)
  const parent = nonEmpty(e.parent)
  if (parent) {
    const found = await findPrd(io, parent)
    if (typeof found === "string") throw new Error(found)
  }
  const priority = Number(e.priority)
  const template = (await io.read(vaultPath(io, PRD_TEMPLATE))) ?? ""
  const date = new Date().toISOString().slice(0, 10)
  let text = template.replaceAll("{{title}}", title).replaceAll("{{date}}", date)
  const acceptance = list(e.acceptance), needs = list(e.needs), footprint = list(e.footprint), checks = list(e.checks)
  text = patchFrontmatter(text, {
    priority: Number.isFinite(priority) && e.priority !== undefined ? priority : null,
    parent: parent || null,
    needs: needs.length ? needs : null,
    footprint: footprint.length ? footprint : null,
    checks: checks.length ? checks : null,
  })
  if (nonEmpty(e.summary)) text = replaceSection(text, "Summary", nonEmpty(e.summary))
  if (acceptance.length) text = replaceSection(text, "Acceptance", acceptance.map((a) => `- [ ] ${a}`).join("\n"))
  await io.write(file, text)
  return `Added ${PRDS}/${title}.md (status open${acceptance.length ? `, ${acceptance.length} acceptance box(es)` : ""}${needs.length ? `, needs ${needs.join(", ")}` : ""}). Link its units under "## Specs"; prd_next lists it when its needs are done.`
}

/** Splits an open PRD into child PRDs on the same board; the parent becomes `refine` and holds the index. */
export async function prdRefine(io: Io, e: { prd?: unknown; children?: unknown; summary?: unknown }): Promise<string> {
  const name = nonEmpty(e.prd)
  if (!name) throw new Error("prd_refine needs the PRD's note name")
  const found = await findPrd(io, name)
  if (typeof found === "string") throw new Error(found)
  if (found.status !== "open" && found.status !== "question") throw new Error(`prd_refine needs an open or question PRD; "${found.name}" is ${found.status}`)
  const children = list(e.children)
  if (!children.length) throw new Error("prd_refine needs children: one title per independent outcome")
  for (const c of children) if (!c || BAD_NAME.test(c)) throw new Error(`"${c}" is not usable as a note name`)
  const existing = (await readPrds(io)).map((p) => p.name)
  const clash = children.filter((c) => existing.includes(c) || c === found.name)
  if (clash.length) throw new Error(`already in ${PRDS}: ${clash.join(", ")}`)
  const added: string[] = []
  for (const c of children) added.push(await prdAdd(io, { title: c, parent: found.name, summary: nonEmpty(e.summary) }))
  const file = vaultPath(io, found.path)
  await io.write(file, patchFrontmatter(found.text, { status: "refine", updated: new Date().toISOString().slice(0, 10) }))
  return `Refined "${found.name}" into ${children.length} child PRD(s): ${children.join(", ")} (parent set to refine).\n${added.join("\n")}`
}

/** Sets a PRD's state by hand; `done` stays with prd_collect and `specced` needs at least one linked unit. */
export async function prdSet(io: Io, e: { prd?: unknown; state?: unknown; reason?: unknown }): Promise<string> {
  const name = nonEmpty(e.prd)
  const state = nonEmpty(e.state)
  if (!name) throw new Error("prd_set needs the PRD's note name")
  if (!(SET_STATES as readonly string[]).includes(state)) throw new Error(`state must be one of ${SET_STATES.join(", ")} (done is written by prd_collect)`)
  const found = await findPrd(io, name)
  if (typeof found === "string") throw new Error(found)
  if (found.status === "done") throw new Error(`"${found.name}" is done; its record is final`)
  if (state === "specced" && !found.specs.length) throw new Error(`"${found.name}" has no linked units; write them in 01 Specs and link them under "## Specs" first`)
  const reason = nonEmpty(e.reason)
  if (state === "blocked" && !reason) throw new Error("blocked needs a reason: what holds it and what would unblock it")
  const text = patchFrontmatter(found.text, { status: state, blocked: state === "blocked" ? reason : null, updated: new Date().toISOString().slice(0, 10) })
  await io.write(vaultPath(io, found.path), text)
  return `"${found.name}" is ${state}${reason ? `: ${reason}` : ""}`
}

const MAX_FINDINGS = 600

/**
 * Records one attributed review round against the current contract digest. The contract is the
 * acceptance section plus every linked unit's Plan items and checks, so any later edit makes the
 * round stale. At most five rounds per PRD; a sixth is refused, and an exhausted PRD stays failed.
 */
export async function prdReview(io: Io, e: { prd?: unknown; score?: unknown; reviewer?: unknown; findings?: unknown }): Promise<string> {
  const name = nonEmpty(e.prd)
  if (!name) throw new Error("prd_review needs the PRD's note name")
  const score = Number(e.score)
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error("score is 0 to 100")
  const reviewer = nonEmpty(e.reviewer)
  if (!reviewer) throw new Error("prd_review needs the reviewer: who scored it (an agent id or name)")
  const found = await findPrd(io, name)
  if (typeof found === "string") throw new Error(found)
  if (found.status === "done") throw new Error(`"${found.name}" is done; its record is final`)
  const last = found.rounds[found.rounds.length - 1]
  if (found.rounds.length >= GATE_ROUNDS && last.score < GATE_SCORE) throw new Error(`"${found.name}" used all ${GATE_ROUNDS} review rounds (last ${last.score}/100); the allowance is exhausted`)
  const digest = await contractDigest(io, found)
  const round = found.rounds.length + 1
  const date = new Date().toISOString().slice(0, 10)
  const findings = nonEmpty(e.findings)
  const line = `- round ${round} · ${Math.round(score)}/100 · digest ${digest} · ${date} · ${reviewer}`
  const kept = comments(section(found.text, "Review") ?? "").split(/\r?\n/).filter((l) => ROUND.test(l) || /^\s+- finding:/.test(l))
  const body = [...kept, line, ...(findings ? [`  - finding: ${findings.slice(0, MAX_FINDINGS)}`] : [])].join("\n")
  let text = replaceSection(found.text, "Review", body)
  const blocked = Math.round(score) < GATE_SCORE
  text = patchFrontmatter(text, { updated: date })
  await io.write(vaultPath(io, found.path), text)
  const verdict = blocked ? `below ${GATE_SCORE}: revise and review again (${GATE_ROUNDS - round} round(s) left)` : `passes the gate; prd_collect can run once the units are implemented`
  return `Recorded review round ${round}/${GATE_ROUNDS} for "${found.name}": ${Math.round(score)}/100 by ${reviewer} · ${verdict}`
}


/**
 * Collects a PRD as done against evidence: its needs done, no open acceptance box, every linked
 * unit implemented with its Plan items ticked, a fresh review round at or above the gate, a clean
 * tree outside .overwatch and every `checks` command passing at HEAD. Writes the proof and the
 * collection receipt into the note. Nothing is written before every gate holds.
 */
export async function prdCollect(io: Io, e: { prd?: unknown; summary?: unknown }): Promise<string> {
  const name = nonEmpty(e.prd)
  if (!name) throw new Error("prd_collect needs the PRD's note name")
  const found = await findPrd(io, name)
  if (typeof found === "string") throw new Error(found)
  const p = found
  if (p.status === "done") return `"${p.name}" is already collected.`
  const all = new Map((await readPrds(io)).map((x) => [x.name, x]))
  const why = held(p, all)
  if (why) throw new Error(`prd_collect: "${p.name}" is held: ${why}`)
  if (!p.acceptance.length) throw new Error(`prd_collect: "${p.name}" has no acceptance boxes; collect needs observed outcomes`)
  const open = p.acceptance.filter((b) => !b.done)
  if (open.length) throw new Error(`prd_collect: ${open.length} open acceptance box(es):\n${open.map((b) => `- [ ] ${b.text}`).join("\n")}`)
  if (!p.specs.length) throw new Error(`prd_collect: "${p.name}" links no units; prd_set specced needs them and collect verifies each`)
  const units = specsOf(await readVault(io))
  const byName = new Map(units.map((s) => [s.name, s]))
  const missing = p.specs.filter((n) => !byName.has(n))
  if (missing.length) throw new Error(`prd_collect: linked units not found in ${vaultPath(io, "01 Specs")}: ${missing.join(", ")}`)
  const linked = p.specs.map((n) => byName.get(n)!)
  const unfinished = linked.filter((s) => s.status !== "implemented" || s.items.some((i) => !i.done))
  if (unfinished.length) throw new Error(`prd_collect: units not implemented (or Plan items open):\n${unfinished.map((s) => `- ${s.name} · ${s.status} · ${s.items.filter((i) => !i.done).length} open item(s)`).join("\n")}`)
  const digest = await contractDigest(io, p, units)
  const g = gate(p, digest)
  if (!g.ok) throw new Error(`prd_collect: ${g.line}`)
  const git = await gitState(io)
  if (typeof git === "string") throw new Error(git)
  if (git.dirty.length) throw new Error(`prd_collect: commit the work first; uncommitted: ${git.dirty.slice(0, 8).join(", ")}${git.dirty.length > 8 ? " …" : ""}`)
  const decided: { check: string; ok: boolean; out: string }[] = []
  for (const check of p.checks) {
    const r = await io.run([...await shellArgv(io.run), "-c", check], { cwd: io.cwd, timeoutMs: CHECK_TIMEOUT_MS })
    decided.push({ check, ok: r.code === 0, out: (r.stdout + r.stderr).trim() })
  }
  const failed = decided.filter((d) => !d.ok)
  if (failed.length) throw new Error(`prd_collect: checks failing, nothing recorded:\n${failed.map((d) => `- \`${d.check}\` ${d.out ? `\n    ${d.out.split("\n").slice(-4).join("\n    ")}` : ""}`).join("\n")}`)
  const date = new Date().toISOString().slice(0, 10)
  const summary = nonEmpty(e.summary) || `Collected at ${git.commit.slice(0, 12)} with ${linked.length} implemented unit(s).`
  const proof = `${git.commit} · ${g.line} · ${decided.length} check(s) exit 0`
  const receipt = [
    `- collected ${date} at ${git.commit}`,
    `- ${g.line}`,
    `- units: ${linked.map((s) => `${s.name} (implemented)`).join(", ")}`,
    `- checks: ${decided.length ? decided.map((d) => `\`${d.check}\` exit 0`).join(", ") : "none declared"}`,
    `- digest ${digest}`,
  ].join("\n")
  let text = patchFrontmatter(p.text, { status: "done", proof, updated: date, blocked: null })
  text = replaceSection(text, "Status", summary)
  text = replaceSection(text, "Collection", receipt)
  await io.write(vaultPath(io, p.path), text)
  await vaultPlan(io)
  return `Collected "${p.name}" as done at ${git.commit.slice(0, 12)}; ${linked.length} unit(s), ${decided.length} check(s) exit 0. Commit the note: git add .overwatch/vault && git commit -m "prd: collect ${p.name}"`
}
