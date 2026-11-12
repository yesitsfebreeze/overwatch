/**
 * The tool-surface ledger and a repo's verification checks, over `Io` so the hooks and bin/overwatch run the same code.
 *
 * The harness defers rarely used tools, and "rare" confirms itself: a tool never reached is never observed.
 * This ledger is the feedback loop:
 *   count   every main-thread tool call (Bash twice: `Bash` and `sh:<binary>`), flushed once per turn
 *   index   what gets used here plus the learned trigger lines, in the prompt, limited to this session's tools
 *   rate    one cold tool is drawn per session and rated useful | situational | dead
 *
 * State: .overwatch/ in the working directory (surface.json, checks.json, mistakes.md).
 */
import { cmp, type Io, join, onPath, readJson, state } from "./io.ts"
import { CHECK_TIERS, checkTier, isTier } from "./guards.ts"
import { incidentReport, lessons, load as loadIncidents, tallyLine } from "./incidents.ts"

const PROMOTE_AT = 3 // a "rare" tool that fires this often is mislabelled
const VERDICT_TTL_DAYS = 30 // a verdict this old is stale: the surface moved
export const VERDICTS = ["useful", "situational", "dead"] as const
type Verdict = (typeof VERDICTS)[number]
const TOP_N = 8

type Ledger = {
  counts: Record<string, number>
  verdicts: Record<string, { verdict: Verdict; reason: string; at: string }>
  triggers: Record<string, string>
  drawn: { name: string; uses: number } | null
}

const today = () => new Date().toISOString().slice(0, 10)

const statePath = (io: Io) => state(io, "surface.json")

export async function load(io: Io): Promise<Ledger> {
  const raw = await readJson<any>(io, statePath(io), {}) // a missing or broken ledger starts over
  // Shell names counted before BINARY_RE existed (`sh:real()`) are dropped as the ledger is read.
  const real = (o: Record<string, any> = {}) => Object.fromEntries(Object.entries(o).filter(([n]) => !n.startsWith("sh:") || BINARY_RE.test(n.slice(3))))
  return { counts: real(raw.counts), verdicts: real(raw.verdicts), triggers: real(raw.triggers), drawn: raw.drawn && real({ [raw.drawn.name]: 1 })[raw.drawn.name] ? raw.drawn : null }
}

/** Counting is best-effort: a failed save never breaks a session. */
export async function save(io: Io, st: Ledger): Promise<void> {
  const sorted = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => cmp(a, b)))
  const out = { counts: sorted(st.counts), drawn: st.drawn, triggers: sorted(st.triggers), verdicts: sorted(st.verdicts) }
  await io.write(statePath(io), JSON.stringify(out, null, 2) + "\n").catch(() => {})
}

async function seedNames(io: Io): Promise<string[]> {
  const text = (await io.read(join(io.root, "data/surface-seed.txt"))) ?? ""
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
}

/** A command name as it can stand on PATH. Ceiling: a plain word inside a heredoc or quoted script still counts; parse the shell grammar if that shows up in the report. */
const BINARY_RE = /^[A-Za-z0-9_][\w.+-]*$/
const SKIP_WORDS = new Set(["cd", "export", "env", "sudo", "time", "nohup", "source", "."])

/** The command a Bash call ran, as `sh:<binary>`: a rule like "use rg, not grep" is unfalsifiable until binaries are counted. */
export function shellBinary(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    for (const word of segment.trim().split(/\s+/).filter(Boolean)) {
      if (word.includes("=") || /^[-({#]/.test(word)) continue
      if (SKIP_WORDS.has(word)) break // `cd /tmp && rg foo` is an rg call
      const name = word.split("/").pop()!
      // Not a command name: a fragment of a quoted string, a heredoc or `$(…)` the split cut open (`real()`, `commits.txt)`).
      if (!BINARY_RE.test(name)) break
      return "sh:" + name
    }
  }
  return undefined
}

/** The names one tool call counts under. */
export const firedBy = (tool: string, input: { command?: unknown }) => [tool, ...[shellBinary(tool === "Bash" ? input.command : undefined)].filter((n): n is string => !!n)]

export async function tally(io: Io, fired: Record<string, number>): Promise<void> {
  if (!Object.keys(fired).length) return
  const st = await load(io)
  for (const [n, c] of Object.entries(fired)) st.counts[n] = (st.counts[n] ?? 0) + c
  await save(io, st)
}

const fresh = (v: { at?: string } | undefined) => !!v?.at && (Date.parse(today()) - Date.parse(v.at)) / 86_400_000 < VERDICT_TTL_DAYS

/** One tool from the cold half of the table; a new name has no count, so it sorts coldest. */
export function draw(st: Ledger, names: string[], rnd = Math.random): Ledger["drawn"] {
  const eligible = names.filter((n) => !fresh(st.verdicts[n]))
  if (!eligible.length) return null
  const cold = [...eligible].sort((a, b) => (st.counts[a] ?? 0) - (st.counts[b] ?? 0)).slice(0, Math.max(1, Math.floor(eligible.length / 2)))
  const name = cold[Math.floor(rnd() * cold.length)]!
  return { name, uses: st.counts[name] ?? 0 }
}

const top = (pairs: [string, number][]) => pairs.sort((a, b) => b[1] - a[1]).slice(0, TOP_N).map(([n, c]) => `${n} ${c}`).join(" · ")

/**
 * The tool-surface sections (asBlock joins them) without the rating question, the tool drawn for rating, and the
 * ledger write of that draw. The write is not awaited, so a prompt does not wait on it: take `drawn` from here,
 * never from the ledger, which may not hold it yet.
 */
export async function surface(io: Io, active?: readonly string[]): Promise<{ sections: string[]; drawn: Ledger["drawn"]; saved: Promise<void> }> {
  const [st, seedList] = await Promise.all([load(io), seedNames(io)])
  const tools = active && new Set(active)
  const names = [...new Set([...seedList, ...Object.keys(st.counts), ...Object.keys(st.triggers)])]
  const bins = await onPath(io, names.filter((n) => n.startsWith("sh:")).map((n) => n.slice(3)))
  const alive = new Set(names.filter((n) => (n.startsWith("sh:") ? bins.has(n.slice(3)) : !tools || tools.has(n))))
  const seeds = seedList.filter((n) => alive.has(n))
  st.drawn = draw(st, [...alive].filter((n) => n in st.counts || seeds.includes(n)).sort())
  const saved = save(io, st)

  const out: string[] = []
  const triggers = Object.entries(st.triggers).filter(([n, t]) => t && alive.has(n)).map(([, t]) => t).sort()
  if (triggers.length) out.push("## Learned triggers — situations that earned a tool", ...triggers.map((t) => `- ${t}`))
  const counts = Object.entries(st.counts).filter(([n]) => alive.has(n))
  const toolCounts = counts.filter(([n]) => !n.startsWith("sh:"))
  const hot = top(toolCounts)
  if (hot) out.push(`## Used most in this project: ${hot}`)
  const shells = top(counts.filter(([n]) => n.startsWith("sh:")).map(([n, c]) => [n.slice(3), c]))
  if (shells) out.push(`## Shell binaries reached for: ${shells}`)
  // Only where a kern tool fired at least once (the `kern` CLI is not one): shell search that dwarfs them is the habit to break.
  const kern = toolCounts.filter(([n]) => n.includes("kern")).reduce((a, [, c]) => a + c, 0)
  const shellSearch = ["grep", "rg", "cat", "sed", "find", "head"].reduce((a, b) => a + (st.counts[`sh:${b}`] ?? 0), 0)
  if (kern && shellSearch >= 10 && shellSearch > 3 * kern)
    out.push(`## Search through kern first: shell search ${shellSearch} vs kern ${kern}. Project state goes to kern_fs grep / kern_memory search; a built-in only for what kern cannot reach, and say why.`)
  const earning = seeds.filter((n) => (st.counts[n] ?? 0) >= PROMOTE_AT).map((n) => `${n} (${st.counts[n]})`)
  if (earning.length) out.push(`## Deferred but earning its place — load it early, do not rediscover it: ${earning.join(", ")}`)
  return { sections: out, drawn: st.drawn, saved }
}

export const asBlock = (sections: string[]) => (sections.length ? ["# Tool surface (overwatch)", ...sections].join("\n") : "")

/** The block with the rating question, once the draw is saved (`overwatch index`, which exits right after). */
export async function index(io: Io, active?: readonly string[]): Promise<string> {
  const { sections, drawn, saved } = await surface(io, active)
  await saved
  return asBlock(drawn ? [...sections, evaluation(drawn)] : sections)
}

/** The one question about the drawn tool; the session hooks hold it back until the session has done some work. */
export const evaluation = (due: NonNullable<Ledger["drawn"]>): string =>
  [
    `## Evaluation due: \`${due.name}\` — ${due.uses} recorded uses`,
    "Judge it against the work actually done in this session, before the session ends:",
    `\`mcp__overwatch__rate\` {name: "${due.name}", verdict: useful|situational|dead, reason: "<one line why>", trigger?: "<situation that should have fired it>"}. ` +
      "`useful` means it should have been reached and was not — then trigger is required. No basis to judge it here → say that as the reason.",
  ].join("\n")

/** Records a verdict; a refusal is thrown as an Error carrying the reason. */
export async function rate(io: Io, name: string, verdict: string, reason: string, trigger?: string): Promise<string> {
  if (!(VERDICTS as readonly string[]).includes(verdict)) throw new Error(`overwatch: verdict must be one of ${VERDICTS.join(" | ")}`)
  if (!name.trim() || !reason.trim()) throw new Error("overwatch: rate needs a name and a reason")
  if (verdict === "useful" && !trigger?.trim())
    throw new Error("overwatch: a `useful` verdict needs a trigger — the situation line that should have fired it, e.g. 'unfamiliar repo, need the big picture: graft map'")
  const st = await load(io)
  st.verdicts[name] = { verdict: verdict as Verdict, reason, at: today() }
  if (verdict === "useful") st.triggers[name] = trigger!.trim()
  if (verdict === "dead") delete st.triggers[name]
  if (st.drawn?.name === name) st.drawn = null
  await save(io, st)
  const tail = { useful: "trigger recorded — it ships in the surface block from the next session", dead: "candidate for removal from the seed list", situational: "correct to sit idle" }[verdict as Verdict]
  return `overwatch: ${name} rated ${verdict} — ${tail}`
}

export async function report(io: Io): Promise<string> {
  const [st, caught] = await Promise.all([load(io), loadIncidents(io)])
  const all = Object.entries(st.counts).sort((a, b) => b[1] - a[1])
  const counts = [...all.filter(([n]) => !n.startsWith("sh:")), ...all.filter(([n]) => n.startsWith("sh:"))]
  const lines = [`tools fired: ${counts.length}, total fires: ${counts.reduce((a, [, c]) => a + c, 0)}`, ...counts.slice(0, 15).map(([n, c]) => `  ${n}: ${c}`)]
  const never = (await seedNames(io)).filter((n) => !(n in st.counts))
  if (never.length) lines.push(`never fired: ${never.join(", ")}`)
  const verdicts = Object.entries(st.verdicts).sort((a, b) => (a[1].at < b[1].at ? 1 : -1)).slice(0, 8)
  if (verdicts.length) lines.push("verdicts:", ...verdicts.map(([n, v]) => `  ${n}: ${v.verdict} (${v.at}) ${v.reason}`))
  const triggers = Object.values(st.triggers)
  if (triggers.length) lines.push("triggers:", ...triggers.map((t) => `  ${t}`))
  lines.push(incidentReport(caught))
  return lines.join("\n")
}

// ── checks: a repo's verification commands and its mistakes ledger ──────────

const CHECK_RE = /test|lint|check|build|verify|typecheck|fmt/

// Language servers and toolchains that outlive their editor and eat swap.
const ORPHAN_RE = /rust-analyzer|language-server|langserver|tsserver|gopls|pyright|clangd/

export async function discover(io: Io): Promise<string[]> {
  let checks: string[] = []
  const at = (f: string) => join(io.cwd, f)
  const pkg = await io.read(at("package.json"))
  if (pkg !== undefined) {
    try { checks.push(...Object.keys(JSON.parse(pkg).scripts ?? {}).filter((s) => /^(test|lint|typecheck|build|check)/.test(s)).map((s) => `npm run ${s}`)) } catch { /* not JSON */ }
  }
  if (await io.exists(at("Cargo.toml"))) checks.push("cargo test", "cargo clippy")
  if (await io.exists(at("go.mod"))) checks.push("go test ./...")
  if (await io.exists(at("Makefile"))) checks.push("make test", "make lint")
  for (const name of ["justfile", "Justfile", ".justfile"]) {
    const jf = await io.read(at(name))
    if (jf === undefined) continue
    // Parameters sit between the name and the colon (`verify rev="HEAD":`); `:=` is a variable.
    const recipes = [...jf.matchAll(/^([a-zA-Z][\w-]*)[^:\n]*:(?!=)/gm)].map((m) => m[1]!)
    checks.push(...recipes.filter((r) => CHECK_RE.test(r)).map((r) => `just ${r}`))
    break
  }
  if (await io.exists(at("pyproject.toml"))) checks.push("pytest")
  // A justfile recipe wrapping cargo/npm supersedes the raw command; `verify` is the project's own gate.
  const wrapped = new Set(checks.filter((c) => c.startsWith("just ")).map((c) => c.split(" ").pop()!))
  const drop = (...cs: string[]) => (checks = checks.filter((c) => !cs.includes(c)))
  if (wrapped.has("test") || wrapped.has("verify")) drop("cargo test", "npm run test", "pytest")
  if (wrapped.has("verify")) drop("just test")
  if (wrapped.has("check") || wrapped.has("verify")) drop("cargo clippy")
  return [...new Set(checks)].sort()
}

const frozenDoc = async (io: Io): Promise<{ checks?: string[]; tiers?: Record<string, string> }> => await readJson<any>(io, state(io, "checks.json"), {})
const frozen = async (io: Io): Promise<string[]> => (await frozenDoc(io)).checks ?? []
/** A command's tier: the frozen override, else the name heuristic. */
const tierOf = (tiers: Record<string, string>, c: string) => tiers[c] ?? checkTier(c)

/** The recorded mistakes, or undefined when there are none. */
const mistakes = async (io: Io) => (await io.read(state(io, "mistakes.md")))?.trim() || undefined

const LEARNED_MISTAKES = 5

/** What earlier sessions taught, for the prompt: one lesson per kind caught repeatedly here (incidents.ts) and the newest recorded mistakes. Empty when there are none. */
export async function learned(io: Io): Promise<string> {
  const [caught, mist] = await Promise.all([loadIncidents(io), mistakes(io)])
  const habits = lessons(caught)
  const recorded = (mist ?? "").split("\n").filter((l) => l.startsWith("- ")).slice(-LEARNED_MISTAKES)
  const out: string[] = []
  if (habits.length) out.push("## Caught repeatedly in earlier sessions — do not repeat", ...habits)
  if (recorded.length) out.push("## Mistakes recorded in this repo", ...recorded)
  return out.length ? ["# Lessons (overwatch)", ...out].join("\n") : ""
}

export async function scan(io: Io): Promise<string> {
  const checks = await discover(io)
  const tiers = Object.fromEntries(checks.map((c) => [c, checkTier(c)]))
  const path = state(io, "checks.json")
  await io.write(path, JSON.stringify({ checks, tiers, at: new Date().toISOString() }, null, 2) + "\n")
  if (!checks.length) return "no checks discovered — add them to .overwatch/checks.json by hand"
  return `froze ${checks.length} checks to ${path}:\n${checks.map((c) => `- [${tiers[c]}] ${c}`).join("\n")}`
}

/** The frozen checks, one tier when named; an unknown tier is an error. */
export async function checklist(io: Io, tier?: string): Promise<string> {
  if (tier && !isTier(tier)) throw new Error(`tier must be one of ${CHECK_TIERS.join(", ")}`)
  const doc = await frozenDoc(io)
  const all = doc.checks ?? []
  if (!all.length) return "no checks frozen — run scan (`overwatch scan`) first"
  const tiers = doc.tiers ?? {}
  const checks = tier ? all.filter((c) => tierOf(tiers, c) === tier) : all
  const [body, mist] = await Promise.all([
    Promise.resolve(checks.length
      ? checks.map((c) => `- [${tierOf(tiers, c)}] ${c}`).join("\n")
      : `no ${tier} checks frozen; all frozen checks: ${all.join(", ")}`),
    mistakes(io),
  ])
  const head = tier ? `# verification plan (${tier} tier)` : "# verification plan"
  return `${head}\nrun these, in order, before calling the change done:\n${body}\n\n# mistakes to avoid\n${mist ?? "(none recorded)"}`
}

export async function mistake(io: Io, text: string): Promise<string> {
  if (!text.trim()) throw new Error("usage: overwatch mistake <what went wrong>")
  const path = state(io, "mistakes.md")
  const old = (await io.read(path)) ?? "# Mistakes to fold into every plan\n"
  await io.write(path, `${old}- ${text.trim()} (${today()})\n`)
  return `recorded: ${text.trim()}`
}

async function guardBlocks(io: Io): Promise<string> {
  // search-guard's own log, the one file read outside the working directory.
  const log = join((await io.env("XDG_STATE_HOME")) || join((await io.env("HOME")) ?? "", ".local/state"), "overwatch/guard.log")
  const text = await io.read(log)
  if (text === undefined) return "guard: no blocks logged"
  const n = text.split("\n").filter((l) => l.startsWith(`[${today()}`)).length
  return `guard: ${n} block(s) today (${log})`
}

async function memory(io: Io): Promise<string> {
  const rows = (await io.run(["ps", "-axo", "rss=,comm="])).stdout
    .split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(.+)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => [Math.floor(Number(m[1]) / 1024), m[2]!] as const)
    .sort((a, b) => b[0] - a[0])
  const row = ([mb, name]: readonly [number, string]) => `  ${mb}MB ${name.split("/").pop()}`
  const orphans = rows.filter(([mb, name]) => ORPHAN_RE.test(name) && mb > 500).map(row)
  return ["memory (top 5):", ...rows.slice(0, 5).map(row), ...(orphans.length ? ["language servers over 500MB — check for orphans after an editor exit:", ...orphans] : [])].join("\n")
}

export async function status(io: Io): Promise<string> {
  const [git, checks, mist, guard, mem, st, caught] = await Promise.all([
    io.run(["git", "status", "--porcelain"]).then((r) => (r.code === 0 ? r.stdout.trimEnd().split("\n").filter(Boolean) : [])),
    frozen(io),
    mistakes(io),
    guardBlocks(io),
    memory(io),
    load(io),
    loadIncidents(io),
  ])
  const fires = Object.values(st.counts)
  return [
    "# overwatch",
    git.length ? `git: dirty, ${git.length} path(s)\n${git.slice(0, 10).map((d) => `  ${d}`).join("\n")}` : "git: clean",
    checks.length ? `checks: ${checks.join(", ")}` : "checks: none frozen (run scan)",
    mist ? `mistakes: ${mist.split("\n").length - 1} recorded` : "mistakes: none recorded",
    guard,
    tallyLine(caught),
    mem,
    `tools fired: ${fires.length}, total fires: ${fires.reduce((a, c) => a + c, 0)}`,
  ].join("\n")
}
