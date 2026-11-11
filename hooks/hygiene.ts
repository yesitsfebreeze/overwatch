import { abs, cmp, join, memIo, type Entry, type Io } from "./io.ts"

/**
 * hygiene — rate, review and cross-check every skill under a repo's skills/.
 *
 *   overwatch hygiene [repo]            write <repo>/LEDGER.md; repo defaults to cwd, then this plugin
 *   overwatch hygiene [repo] --issues   also sync GitHub issues of <repo> (needs gh)
 *   overwatch hygiene --selftest
 *
 * Usage counts come from local Claude Code transcripts when present
 * (~/.claude/projects, override with HYGIENE_TRANSCRIPTS); without them the column is blank.
 */

type Severity = "high" | "medium" | "low"
export type Finding = { skill: string; rule: string; severity: Severity; detail: string }
export type Skill = {
  name: string; files: number; words: number; description: string; requires: string[]
  internal: string[]; external: string[]; lines: number; score: number
}
type Meta = Record<string, string | string[]>

const WEIGHT: Record<Severity, number> = { high: 25, medium: 10, low: 5 }
const SEVERITIES = Object.keys(WEIGHT) as Severity[]
const DUP_JACCARD = 0.35 // shared trigger vocabulary
const DUP_RATIO = 0.6 // SequenceMatcher ratio over the two descriptions
const MAX_LINES = 500 // Anthropic's own ceiling for a SKILL.md
const STOP = new Set(
  ("a an the and or of to in on for is it its this that with when use used using " +
    "skill skills before after every any all one which what how who into from by as at " +
    "be are was not no if then than so do does load read say says").split(" "),
)

/** Exactly what Python's str.split() splits on (str.isspace): JS's \s lacks \x1c-\x1f and NEL and adds U+FEFF. */
const PY_SPACE = /[\t\n\v\f\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/
const len = (s: string) => [...s].length
const stripChars = (s: string, chars: string) => {
  let i = 0, j = s.length
  while (i < j && chars.includes(s[i])) i++
  while (j > i && chars.includes(s[j - 1])) j--
  return s.slice(i, j)
}

/** Python's repr for the values a detail quotes; issue titles cut on its single quotes. */
export function repr(v: unknown): string {
  if (v === undefined || v === null) return "None"
  if (Array.isArray(v)) return `[${v.map(repr).join(", ")}]`
  const s = String(v)
  const q = s.includes("'") && !s.includes('"') ? '"' : "'"
  return q + s.replace(/\\/g, "\\\\").replaceAll(q, "\\" + q).replace(/\n/g, "\\n").replace(/\t/g, "\\t") + q
}
const str = (v: unknown) => (Array.isArray(v) ? repr(v) : String(v ?? ""))

/** Python's `f"{x:.2f}"`: round half to even on exact ties (k/8), which toFixed rounds up. */
export function fixed2(x: number): string {
  if (Number.isInteger(x * 8) && !Number.isInteger(x * 4)) {
    const lo = Math.floor(x * 100)
    return ((lo % 2 === 0 ? lo : lo + 1) / 100).toFixed(2)
  }
  return x.toFixed(2)
}

/** Frontmatter as a record; lists ([a, b] or - a) flattened. No YAML dependency. */
export function fm(text: string): [Meta, string] {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return [{}, text]
  const meta: Meta = {}
  let key: string | null = null, block: string | null = null
  for (const line of m[1].split(/\r\n|\r|\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/)
    if (kv) {
      key = kv[1]
      let val: string | string[] = kv[2].trim()
      block = [">", "|", ">-", "|-"].includes(val) ? val : null
      if (block) val = ""
      else if (val.startsWith("[") && val.endsWith("]"))
        val = val.slice(1, -1).split(",").filter((v) => v.trim()).map((v) => stripChars(v.trim(), "'\""))
      meta[key] = val
    } else if (key && block && line.startsWith(" ")) {
      meta[key] = (String(meta[key]) + (block[0] === ">" ? " " : "\n") + line.trim()).trim()
    } else if (key && line.trim().startsWith("- ")) {
      meta[key] = [...(Array.isArray(meta[key]) ? meta[key] : []), stripChars(line.trim().slice(2), "'\"")]
    }
  }
  return [meta, m[2]]
}

const vocab = (desc: string) => new Set([...desc.toLowerCase().matchAll(/[a-z][a-z0-9-]{2,}/g)].map((m) => m[0]).filter((w) => !STOP.has(w)))

/**
 * difflib.SequenceMatcher(None, a, b).ratio(), autojunk included: in a `b` of 200+ items an
 * element seen more than 1% + 1 times is "popular" and never seeds a match, as in Python, so
 * DUP_RATIO keeps the meaning it was tuned with.
 */
export function ratio(sa: string, sb: string): number {
  const a = [...sa], b = [...sb]
  const b2j = new Map<string, number[]>()
  b.forEach((ch, j) => (b2j.get(ch) ?? b2j.set(ch, []).get(ch)!).push(j))
  if (b.length >= 200) {
    const ntest = Math.floor(b.length / 100) + 1
    for (const [ch, idx] of [...b2j]) if (idx.length > ntest) b2j.delete(ch)
  }
  const longest = (alo: number, ahi: number, blo: number, bhi: number): [number, number, number] => {
    let besti = alo, bestj = blo, bestsize = 0
    let j2len = new Map<number, number>()
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>()
      for (const j of b2j.get(a[i]) ?? []) {
        if (j < blo) continue
        if (j >= bhi) break
        const k = (j2len.get(j - 1) ?? 0) + 1
        next.set(j, k)
        if (k > bestsize) (besti = i - k + 1), (bestj = j - k + 1), (bestsize = k)
      }
      j2len = next
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) besti--, bestj--, bestsize++
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++
    return [besti, bestj, bestsize]
  }
  let matched = 0
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]]
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!
    const [i, j, k] = longest(alo, ahi, blo, bhi)
    if (!k) continue
    matched += k
    if (alo < i && blo < j) queue.push([alo, i, blo, j])
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi])
  }
  const total = a.length + b.length
  return total ? (2 * matched) / total : 1
}

/** Every file under `dir` whose name does not start with a dot, relative to `dir`. */
async function walk(io: Io, dir: string, rel = ""): Promise<string[]> {
  const out: string[] = []
  const entries = (await io.list(rel ? join(dir, rel) : dir)).sort((x: Entry, y: Entry) => cmp(x.name, y.name))
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.kind === "dir") out.push(...(await walk(io, dir, r)))
    else if (e.kind === "file" && !e.name.startsWith(".")) out.push(r)
  }
  return out
}

const SKILL_CALL = /"name":"Skill","input":\{"skill":"([^"]+)"/g

/**
 * Skill-tool invocations per skill in local transcripts. rg when it is on PATH (seconds over
 * gigabytes); otherwise every *.jsonl is read here, as the Python script did. Not BSD grep:
 * its -o over large files is an order of magnitude slower than either.
 */
async function usageCounts(io: Io): Promise<Record<string, number>> {
  const base = (await io.env("HYGIENE_TRANSCRIPTS")) ?? join((await io.env("HOME")) ?? "", ".claude/projects")
  if (!(await io.exists(base))) return {}
  const counts: Record<string, number> = {}
  const count = (text: string) => {
    for (const m of text.matchAll(SKILL_CALL)) {
      const name = m[1].split(":").at(-1)!
      counts[name] = (counts[name] ?? 0) + 1
    }
  }
  const rg = await io.run(["rg", "-oIN", "--no-filename", "-g", "*.jsonl", SKILL_CALL.source, base], { timeoutMs: 120_000 })
  if (rg.code === 0 || rg.code === 1) count(rg.stdout)
  else for (const f of (await walk(io, base)).filter((f) => f.endsWith(".jsonl"))) count((await io.read(join(base, f))) ?? "")
  return counts
}

export async function scan(io: Io, skillsDir: string): Promise<[Record<string, Skill>, Finding[]]> {
  const names = (await io.list(skillsDir)).filter((e) => e.kind === "dir" && !e.name.startsWith(".")).map((e) => e.name).sort(cmp)
  const parent = skillsDir.replace(/\/[^/]+\/?$/, "")
  const skills: Record<string, Skill> = {}
  const findings: Finding[] = []
  const flag = (skill: string, rule: string, severity: Severity, detail: string) => findings.push({ skill, rule, severity, detail })

  for (const name of names) {
    const d = join(skillsDir, name)
    const files = await walk(io, d)
    let words = 0
    for (const f of files) words += ((await io.read(join(d, f))) ?? "").split(PY_SPACE).filter(Boolean).length
    const s: Skill = { name, files: files.length, words, description: "", requires: [], internal: [], external: [], lines: 0, score: 0 }
    skills[name] = s
    const text = await io.read(join(d, "SKILL.md"))
    if (text === undefined) {
      flag(name, "missing-skill-md", "high", "directory has no SKILL.md; the skill cannot load")
      continue
    }
    const [meta, body] = fm(text)
    s.lines = text.split("\n").length
    s.description = str(meta.description).trim()
    const req = meta.requires ?? []
    s.requires = Array.isArray(req) ? req : [req]

    if (meta.name !== name) flag(name, "name-mismatch", "high", `frontmatter name is ${repr(meta.name)}, directory is ${repr(name)}`)
    const desc = s.description
    if (!desc) flag(name, "description-missing", "high", "no description; Claude has nothing to route on")
    else if (len(desc) < 80) flag(name, "description-short", "medium", `${len(desc)} chars; say what it does and when to reach for it`)
    else if (len(desc) > 1024) flag(name, "description-long", "medium", `${len(desc)} chars; over the 1024 limit, the tail is cut`)
    if (desc && !/"[^"]+"|\b(when(ever)?|wenn|use (this skill )?for|nutze|triggers?|keywords?)\b/i.test(desc))
      flag(name, "no-triggers", "medium", "description names no trigger phrases; routing is guesswork")
    if (s.lines > MAX_LINES) flag(name, "oversize", "low", `SKILL.md is ${s.lines} lines; split rarely-read parts into companions`)

    // dependencies: requires:, prose "requires the X skill", another repo skill named in the body,
    // and path references into a directory that is not this skill
    const deps = new Set(s.requires)
    for (const m of body.matchAll(/[Rr]equires (?:the )?(?:`([a-z][a-z0-9-]+)`|([a-z][a-z0-9-]+) skill)/g)) deps.add(m[1] || m[2])
    for (const m of body.matchAll(/`\/([a-z][a-z0-9-]+)`/g)) deps.add(m[1])
    for (const m of body.matchAll(/(?:skills\/)?\b([a-z][a-z0-9-]+)\/[\w./-]+\.md/g)) if (names.includes(m[1])) deps.add(m[1])
    for (const other of names) if (other !== name && body.includes(`\`${other}\``)) deps.add(other) // a bare word is not a dependency
    deps.delete(name)
    for (const dep of [...deps].sort(cmp)) {
      const kind = names.includes(dep) ? "internal" : "external"
      s[kind].push(dep)
      flag(name, `dependency-${kind}`, kind === "internal" ? "medium" : "high", `depends on ${repr(dep)} (${kind}); an interchangeable skill carries its own weight`)
    }

    // references to companion files that do not exist
    const refs = new Set([...body.matchAll(/`@?([\w./-]+\.md)`|@([\w./-]+\.md)/g)].map((m) => (m[1] || m[2]).replace(/^skills\//, "")))
    for (const ref of [...refs].sort(cmp)) {
      if (ref === "LEDGER.md") continue // the file this command writes; absent until the first run
      if (ref.includes("/") && deps.has(ref.split("/")[0])) continue // path into another skill, already a dependency finding
      if (!(await io.exists(join(d, ref))) && !(await io.exists(join(parent, ref))))
        flag(name, "dead-reference", "high", `SKILL.md points at ${repr(ref)} which does not exist`)
    }
    for (const rel of files) {
      if (rel !== "SKILL.md" && !text.includes(rel) && !text.includes(rel.split("/").at(-1)!))
        flag(name, "orphan-file", "low", `${repr(rel)} is never referenced from SKILL.md`)
    }
  }

  // duplicates: pairwise on description vocabulary and on the text itself
  const have = names.filter((n) => skills[n].description)
  for (let i = 0; i < have.length; i++) {
    for (const b of have.slice(i + 1)) {
      const a = have[i]
      const va = vocab(skills[a].description), vb = vocab(skills[b].description)
      const union = new Set([...va, ...vb])
      const jac = union.size ? [...va].filter((w) => vb.has(w)).length / union.size : 0
      const r = ratio(skills[a].description, skills[b].description)
      if (jac >= DUP_JACCARD || r >= DUP_RATIO) // near-identical text is an issue; shared vocabulary is a pointer for review
        flag(a, "duplicate", r >= DUP_RATIO ? "medium" : "low", `overlaps with ${repr(b)} (vocabulary ${fixed2(jac)}, text ${fixed2(r)}); merge or sharpen both descriptions`)
    }
  }

  for (const s of Object.values(skills))
    s.score = Math.max(0, 100 - findings.filter((f) => f.skill === s.name).reduce((t, f) => t + WEIGHT[f.severity], 0))
  return [skills, findings]
}

function why(desc: string): string {
  if (!desc) return "-"
  const t = desc.trim()
  const m = t.match(/(?<=[.!?])\s/)
  const first = m ? t.slice(0, m.index) : t
  return len(first) > 113 ? [...first].slice(0, 110).join("") + "..." : first
}

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export function ledger(skills: Record<string, Skill>, findings: Finding[], usage: Record<string, number>): string {
  const hasUsage = Object.keys(usage).length > 0
  const order = Object.values(skills).sort((x, y) => y.score - x.score || (usage[y.name] ?? 0) - (usage[x.name] ?? 0) || cmp(x.name, y.name))
  const out = [
    "# Skill ledger", "",
    `Generated ${today()} by the hygiene skill. ${Object.keys(skills).length} skills, ${findings.length} findings. Score starts at 100; ` +
      `high finding -${WEIGHT.high}, medium -${WEIGHT.medium}, low -${WEIGHT.low}. ` +
      "`used` is Skill-tool invocations found in local transcripts (blank without them).", "",
    "## Ranking", "", "| # | skill | score | used | why it exists | files | words | depends on |", "|---|---|---|---|---|---|---|---|",
  ]
  order.forEach((s, i) => {
    const deps = [...s.internal, ...s.external.map((d) => `${d} (ext)`)].join(", ") || "-"
    const used = hasUsage ? (usage[s.name] ?? 0) : ""
    out.push(`| ${i + 1} | ${s.name} | ${s.score} | ${used} | ${why(s.description)} | ${s.files} | ${s.words} | ${deps} |`)
  })
  const dups = findings.filter((f) => f.rule === "duplicate")
  out.push("", "## Duplicates", "")
  out.push(...(dups.length ? ["| skill | overlaps with |", "|---|---|", ...dups.map((f) => `| ${f.skill} | ${f.detail} |`)] : ["none"]))
  const deps = findings.filter((f) => f.rule.startsWith("dependency-"))
  out.push("", "## Dependencies", "")
  out.push(...(deps.length ? ["| skill | kind | detail |", "|---|---|---|", ...deps.map((f) => `| ${f.skill} | ${f.rule.slice(11)} | ${f.detail} |`)] : ["none - every skill stands alone"]))
  out.push("", "## Findings", "")
  if (findings.length) {
    const sorted = [...findings].sort((x, y) => SEVERITIES.indexOf(x.severity) - SEVERITIES.indexOf(y.severity) || cmp(x.skill, y.skill))
    out.push("| skill | rule | severity | detail |", "|---|---|---|---|", ...sorted.map((f) => `| ${f.skill} | ${f.rule} | ${f.severity} | ${f.detail} |`))
  } else out.push("none")
  return out.join("\n") + "\n"
}

/** A stable issue title, so reruns do not duplicate. */
export function title(f: Finding): string {
  const named = ["duplicate", "dead-reference", "orphan-file"].includes(f.rule) || f.rule.startsWith("dependency")
  return `[hygiene] ${f.skill}: ${f.rule}` + (named ? ` (${f.detail.split("'")[1]})` : "")
}

/** One open issue per medium/high finding, titled stably so reruns do not duplicate; close what healed. */
async function syncIssues(io: Io, root: string, findings: Finding[]): Promise<string[]> {
  const gh = async (...args: string[]) => {
    const r = await io.run(["gh", ...args], { cwd: root, timeoutMs: 60_000 })
    if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed (${r.code}): ${r.stderr.trim()}`)
    return r.stdout
  }
  await io.run(["gh", "label", "create", "hygiene", "--force", "-c", "C5DEF5", "-d", "opened by the hygiene skill"], { cwd: root })
  const open = new Map<string, number>(
    JSON.parse(await gh("issue", "list", "--label", "hygiene", "--state", "open", "--limit", "500", "--json", "number,title")).map((i: any) => [i.title, i.number]),
  )
  const wanted = new Map(findings.filter((f) => f.severity !== "low").map((f) => [title(f), f]))
  const log: string[] = []
  for (const [t, f] of wanted) {
    if (open.has(t)) continue
    const body = `**Skill:** \`${f.skill}\`\n**Rule:** \`${f.rule}\` (${f.severity})\n\n${f.detail}\n\n` +
      "Opened by the hygiene skill; see `LEDGER.md`. It closes on its own once the finding is gone."
    await gh("issue", "create", "--title", t, "--label", "hygiene", "--body", body)
    log.push(`opened  ${t}`)
  }
  for (const [t, n] of open) {
    if (wanted.has(t)) continue
    await gh("issue", "close", String(n), "-c", "No longer reported by the hygiene run.")
    log.push(`closed  ${t}`)
  }
  return log
}


/** The fixture the selftest scans; every rule it checks fires on it. */
export const FIXTURE: Record<string, string> = {
  "/t/skills/alpha/SKILL.md": '---\nname: alpha\ndescription: >\n  Review Vue components for style and conventions.\n  Use for "vue review", "check my component".\nrequires: [beta]\n---\nRequires the omega skill. See `missing.md`, `LEDGER.md`, `/gamma` and `skills/beta/SKILL.md`. Path docs/x.md is not a skill.\n',
  "/t/skills/alpha/extra.md": "orphan",
  "/t/skills/beta/SKILL.md": '---\nname: wrong\ndescription: Review Vue components for conventions, naming and style. Use for "vue review", "lint my vue".\n---\nbody\n',
  "/t/skills/empty/.keep": "",
}

/** Scans FIXTURE and checks each expectation; the failures, empty when all hold. */
export async function selftest(): Promise<string[]> {
  const [skills, findings] = await scan(memIo({ ...FIXTURE }), "/t/skills")
  const fail: string[] = []
  const rules = new Set(findings.map((f) => `${f.skill}/${f.rule}`))
  for (const want of ["empty/missing-skill-md", "beta/name-mismatch", "alpha/dependency-internal", "alpha/dependency-external", "alpha/dead-reference", "alpha/orphan-file", "alpha/duplicate"])
    if (!rules.has(want)) fail.push(`missing finding ${want}`)
  if (findings.some((f) => f.detail.includes("LEDGER.md"))) fail.push("LEDGER.md reported")
  const a = skills.alpha
  if (a.internal.join() !== "beta" || a.external.join() !== "gamma,omega") fail.push(`alpha deps ${a.internal} | ${a.external}`)
  if (!a.description.startsWith("Review Vue") || a.description.includes("\n")) fail.push(`alpha description ${repr(a.description)}`)
  const scores = `${skills.empty.score},${skills.beta.score},${a.score}`
  if (scores !== "75,75,0") fail.push(`scores empty,beta,alpha = ${scores}`)
  if (!ledger(skills, findings, {}).includes("| alpha |")) fail.push("ledger lacks alpha")
  return fail
}

/** `overwatch hygiene [repo] [--issues] [--selftest]`, as text and an exit code. */
export async function hygiene(io: Io, args: string[]): Promise<{ text: string; code: number }> {
  if (args.includes("--selftest")) {
    const fail = await selftest()
    return fail.length ? { text: "selftest failed:\n" + fail.join("\n"), code: 1 } : { text: "selftest ok", code: 0 }
  }
  const arg = args.find((a) => !a.startsWith("--"))
  const root = arg ? abs(io, arg).replace(/\/+$/, "") : (await io.exists(join(io.cwd, "skills"))) ? io.cwd : io.root
  const skillsDir = join(root, "skills")
  if (!(await io.exists(skillsDir))) return { text: `no skills/ directory under ${root}`, code: 1 }
  const [skills, findings] = await scan(io, skillsDir)
  await io.write(join(root, "LEDGER.md"), ledger(skills, findings, await usageCounts(io)))
  const out = [`${Object.keys(skills).length} skills, ${findings.length} findings -> LEDGER.md`]
  if (args.includes("--issues")) {
    try {
      out.push(...(await syncIssues(io, root, findings)))
    } catch (err) {
      return { text: [...out, String((err as Error).message ?? err)].join("\n"), code: 1 }
    }
  }
  return { text: out.join("\n"), code: 0 }
}
