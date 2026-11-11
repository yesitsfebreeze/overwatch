import { TOOL_PREFIX } from "./catalog.ts"
import { cmp, join, readJson, shellArgv, state, type Io } from "./io.ts"

/**
 * The disk gardener: knows when the disk a project sits on is nearly full, finds what
 * can go (ephemeral files in the temp folders, build output and dependency folders that
 * rebuild, both proven rather than guessed by name) and deletes only what it proved
 * again at that moment. Two scopes: `project` (the working directory, first) and `disk`
 * (the home folder, the temp folders, caches and app data). Everything goes through
 * `find`, `du`, `df`, `git` and `lsof`, so it runs wherever a POSIX shell does.
 */

/** Smallest unit listed, in MiB; loose files are listed from LARGE_FILE_MIB. */
export const MIN_MIB = 100
const LARGE_FILE_MIB = 500
/** A unit changed within this many minutes is in use. */
export const ACTIVE_MINUTES = 120
/** Build output of a project whose last commit is this old is a leftover, not a working copy. */
export const STALE_DAYS = 30
/** The disk counts as nearly full from this percent used (the plugin's `diskFullPercent` setting). */
export const FULL_PERCENT = 88
/** How deep a busy temp folder is split into its children, so one live process does not hide dead siblings. */
const TEMP_DEPTH = 3
const SCAN_TIMEOUT_MS = 10 * 60_000
const ROWS = 12

/** What proves a folder with an output name is output: a manifest beside it, a file inside it, or git ignoring it. None: the name is proof enough. */
type Proof = { kind: string; beside?: string[]; inside?: string[]; ignored?: true }
const JS: Pick<Proof, "beside"> = { beside: ["package.json"] }
export const OUTPUT: Record<string, Proof> = {
  node_modules: { kind: "JavaScript dependencies", ...JS },
  ".next": { kind: "Next.js build output", ...JS },
  ".nuxt": { kind: "Nuxt build output", ...JS },
  ".svelte-kit": { kind: "SvelteKit build output", ...JS },
  ".angular": { kind: "Angular cache", ...JS },
  ".turbo": { kind: "Turborepo cache" },
  ".parcel-cache": { kind: "Parcel cache" },
  target: { kind: "Cargo or Maven build output", inside: ["CACHEDIR.TAG"], beside: ["Cargo.toml", "pom.xml"] },
  ".venv": { kind: "Python virtual environment", inside: ["pyvenv.cfg"] },
  venv: { kind: "Python virtual environment", inside: ["pyvenv.cfg"] },
  __pycache__: { kind: "Python bytecode cache" },
  ".pytest_cache": { kind: "pytest cache" },
  ".mypy_cache": { kind: "mypy cache" },
  ".ruff_cache": { kind: "ruff cache" },
  ".tox": { kind: "tox environments" },
  ".nox": { kind: "nox environments" },
  ".gradle": { kind: "Gradle project cache", beside: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"] },
  ".build": { kind: "Swift build output", beside: ["Package.swift"] },
  DerivedData: { kind: "Xcode build output" },
  Pods: { kind: "CocoaPods dependencies", beside: ["Podfile"] },
  ".zig-cache": { kind: "Zig cache", beside: ["build.zig"] },
  "zig-cache": { kind: "Zig cache", beside: ["build.zig"] },
  "zig-out": { kind: "Zig build output", beside: ["build.zig"] },
  _build: { kind: "Mix or Dune build output", beside: ["mix.exs", "dune-project"] },
  ".dart_tool": { kind: "Dart tool cache", beside: ["pubspec.yaml"] },
  ".terraform": { kind: "Terraform providers and modules", inside: ["providers", "modules"] },
  ".stack-work": { kind: "Stack build output", beside: ["stack.yaml"] },
  // Names source folders carry too: output only where git ignores the folder and tracks nothing in it.
  dist: { kind: "build output (git-ignored)", ignored: true },
  build: { kind: "build output (git-ignored)", ignored: true },
  out: { kind: "build output (git-ignored)", ignored: true },
  coverage: { kind: "coverage report (git-ignored)", ignored: true },
  ".cache": { kind: "project cache (git-ignored)", ignored: true },
}

/** Folders under the home folder whose children are listed in the disk scope: never deleted here, only named with their owner's command. */
const AREAS = ["Library/Caches", ".cache", "Library/Application Support", "Library/Containers", "Library/Developer"]
/** The command that shrinks a cache, by path under the home folder. `owners` in .overwatch/disk.json adds to it. */
export const OWNERS: Record<string, string> = {
  ".npm/_cacache": "npm cache clean --force",
  ".npm/_npx": "delete it; npx downloads again",
  ".cache/uv": "uv cache prune",
  "Library/Caches/uv": "uv cache prune",
  ".cache/pip": "pip cache purge",
  "Library/Caches/pip": "pip cache purge",
  ".cache/go-build": "go clean -cache",
  "Library/Caches/go-build": "go clean -cache",
  "go/pkg/mod": "go clean -modcache",
  ".cargo/registry": "delete registry/cache and registry/src; cargo downloads again",
  "Library/Caches/Homebrew": "brew cleanup -s",
  "Library/Caches/Yarn": "yarn cache clean",
  ".cache/yarn": "yarn cache clean",
  "Library/pnpm/store": "pnpm store prune",
  ".local/share/pnpm/store": "pnpm store prune",
  ".bun/install/cache": "bun pm cache rm",
  "Library/Caches/ms-playwright": "npx playwright uninstall --all",
  ".cache/ms-playwright": "npx playwright uninstall --all",
  ".gradle/caches": "gradle --stop, then delete it; Gradle downloads again",
  ".m2/repository": "delete it; Maven downloads again",
  "Library/Developer/Xcode/DerivedData": "delete it; Xcode rebuilds",
  "Library/Developer/CoreSimulator": "xcrun simctl delete unavailable",
  "Library/Containers/com.docker.docker": "docker system prune",
  ".cache/huggingface": "huggingface-cli delete-cache",
  ".ollama/models": "ollama rm <model>",
  ".Trash": "empty the Trash",
}

export type Scope = "project" | "disk"
export type Status = "leftover" | "regenerable" | "unverified" | "busy" | "kept"
export type Unit = { path: string; kib: number; kind: string; status: Status; why: string }
export type Listed = { path: string; kib: number; note: string }
export type Df = { mount: string; totalKib: number; freeKib: number; percent: number }
/** What the shell found out about one path (PROBE). `unsaved` names a git checkout at or under it with uncommitted or unpushed work. */
export type Facts = { type: "d" | "f" | "l"; commit?: number; top: string; ignored: boolean; tracked: boolean; active: boolean; unsaved: string }
type Ctx = { keep: string[]; cwds: string[]; now: number; home: string }
/** .overwatch/disk.json: `keep` and `owners` are the user's; the rest is the last survey per scope and what was deleted. */
type Book = { keep?: string[]; owners?: Record<string, string>; project?: Snapshot; disk?: Snapshot; cleaned?: { at: number; path: string; kib: number }[] }
type Snapshot = { at: number; kib: Record<string, number> }
type Sized = readonly [path: string, kib: number]
export type Survey = { scope: Scope; df?: Df; units: Unit[]; areas: Listed[]; files: Listed[]; grew: Listed[]; since?: number; searched: string[]; seconds: number; minMib: number }

const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/"
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1)
export const inside = (p: string, root: string) => p === root || p.startsWith(root.replace(/\/+$/, "") + "/")
export const size = (kib: number) => (kib >= 1 << 20 ? `${(kib / (1 << 20)).toFixed(1)} GiB` : `${Math.round(kib / 1024)} MiB`)

// ── the shell side ───────────────────────────────────────────────────
// Each script takes its paths as arguments (never spliced into the text) and prints tab-separated lines.

const NAMES = Object.keys(OUTPUT).map((n) => `-name '${n}'`).join(" -o ")
/** `kib<TAB>path` for one path, skipping links and anything under `$min` KiB. */
const ONE = String.raw`one() { [ -L "$1" ] && return; [ -e "$1" ] || return; k=$(du -skx "$1" 2>/dev/null | cut -f1); [ -n "$k" ] && [ "$k" -ge "$min" ] && printf '%s\t%s\n' "$k" "$1"; }
min=$1; shift
`
export const SCRIPTS = {
  /** Every folder with an output name (not entered, so nested ones stay one unit) and every large loose file under the roots. Never crosses a filesystem, never enters .git, the Trash or ~/Library. */
  walk: String.raw`min=$1; fmin=$2; home=$3; shift 3
find "$@" -xdev \( -name .git -o -name .Trash -o -path "$home/Library" \) -prune -o \( -type d \( ${NAMES} \) -prune -print0 \) -o \( -type f -size +"$fmin"k -print0 \) 2>/dev/null |
  xargs -0 -r -n 100 -P 4 du -skx 2>/dev/null | awk -F '\t' -v m="$min" '$1 + 0 >= m + 0'`,
  sizes: ONE + String.raw`for e; do one "$e"; done`,
  children: ONE + String.raw`for d; do for e in "$d"/* "$d"/.[!.]* "$d"/..?*; do one "$e"; done; done`,
  /** A folder's real path (temp folders are often links: /tmp, $TMPDIR). */
  real: String.raw`for d; do r=$(cd "$d" 2>/dev/null && pwd -P) && printf '%s\t%s\n' "$d" "$r"; done`,
  /**
   * Case patterns open with a paren: bash 3.2 (macOS sh) cannot parse the bare form inside $( ).
   * path, type, last commit of the folder around it, git toplevel, ignored, tracked, active, unsaved checkout.
   * One find per path answers both "changed lately" and "holds a checkout". Ceiling: only its first 200
   * lines are read, so a folder with more than 200 checkouts and no recent file has the rest unchecked.
   */
  probe: String.raw`export GIT_OPTIONAL_LOCKS=0
m=$1; shift
probe() {
  p=$1; d=$(dirname "$p"); b=$(basename "$p")
  [ -e "$p" ] || [ -L "$p" ] || return
  t=f; g=$d
  if [ -L "$p" ]; then t=l; elif [ -d "$p" ]; then t=d; g=$p; fi
  top=$(git -C "$g" rev-parse --show-toplevel 2>/dev/null)
  c=$(git -C "$d" log -1 --format=%ct 2>/dev/null)
  ign=0; git -C "$d" check-ignore -q "$b" 2>/dev/null && ign=1
  trk=0; [ -n "$(git -C "$d" ls-files -- "$b" 2>/dev/null | head -1)" ] && trk=1
  fl=$(find "$p" \( -mmin "-$m" -o -name .git \) -print 2>/dev/null | head -200 | {
    act=0; uns=
    while IFS= read -r h; do
      case $h in
        (*/.git) r=$(dirname "$h")
          if [ -z "$uns" ] && { [ -n "$(git -C "$r" status --porcelain 2>/dev/null | head -1)" ] || [ -n "$(git -C "$r" log --branches --not --remotes -1 --format=%h 2>/dev/null)" ]; }; then uns=$r; fi ;;
        (*) act=1 ;;
      esac
    done
    printf '%s\t%s' "$act" "$uns"; })
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$p" "$t" "$c" "$top" "$ign" "$trk" "$fl"
}
n=0
for p; do probe "$p" & n=$((n + 1)); [ $((n % 8)) -eq 0 ] && wait; done
wait`,
  /** The first open file at or under each path, if any process has one. */
  open: String.raw`for p; do o=$(lsof -Fn 2>/dev/null | cut -c2- | awk -v p="$p" '$0 == p || index($0, p "/") == 1' | head -1); printf '%s\t%s\n' "$p" "$o"; done`,
} as const

const rows = (out: string) => out.split("\n").filter(Boolean).map((l) => l.split("\t"))
/** A script that did not run to its end (timeout, no shell, a syntax error) is an error, never an empty finding. */
const sh = async (io: Io, script: string, args: readonly string[]): Promise<string[][]> => {
  const r = await io.run([...await shellArgv(io.run), "-c", script, "sh", ...args], { timeoutMs: SCAN_TIMEOUT_MS })
  if (r.code === 124 || r.code === 127 || r.code === 2) throw new Error(`disk gardener: a shell step ${r.code === 124 ? "timed out" : `failed (${r.stderr.trim().split("\n")[0] || r.code})`}`)
  return rows(r.stdout)
}
/** The scripts' `kib<TAB>path` lines as [path, kib]; a path listed twice counts once. */
const sized = async (io: Io, script: string, args: readonly string[]): Promise<Sized[]> =>
  [...new Map((await sh(io, script, args)).filter((r) => r.length >= 2).map(([kib, ...path]) => [path.join("\t"), Number(kib)] as const))]

async function probe(io: Io, paths: string[]): Promise<Map<string, Facts>> {
  const out = new Map<string, Facts>()
  for (let i = 0; i < paths.length; i += 400) // stays far under the argument-size limit
    for (const [path, type, commit, top, ign, trk, act, uns] of await sh(io, SCRIPTS.probe, [String(ACTIVE_MINUTES), ...paths.slice(i, i + 400)]))
      if (path && type) out.set(path, { type: type as Facts["type"], commit: Number(commit) || undefined, top: top ?? "", ignored: ign === "1", tracked: trk === "1", active: act === "1", unsaved: uns ?? "" })
  return out
}

/** The real paths of `dirs` that exist, without repeats. */
const real = async (io: Io, dirs: string[]) => [...new Set((await sh(io, SCRIPTS.real, dirs.filter(Boolean))).map((r) => r[1]!).filter(Boolean))]
const tempRoots = async (io: Io) => real(io, ["/tmp", "/var/tmp", (await io.env("TMPDIR")) ?? ""])
/** Where processes work right now; empty without lsof (the activity check still holds). */
const workdirs = async (io: Io) => (await io.run(["lsof", "-a", "-d", "cwd", "-Fn"], { timeoutMs: 20_000 })).stdout.split("\n").filter((l) => l.startsWith("n/") && l.length > 2).map((l) => l.slice(1))

export function parseDf(stdout: string): Df | undefined {
  const m = stdout.trim().split("\n").pop()?.match(/\s(\d+)\s+\d+\s+(\d+)\s+(\d+)%\s+(\/.*)$/)
  return m ? { totalKib: Number(m[1]), freeKib: Number(m[2]), percent: Number(m[3]), mount: m[4]! } : undefined
}
export const usage = async (io: Io, path: string) => parseDf((await io.run(["df", "-Pk", path], { timeoutMs: 10_000 })).stdout)

// ── judging ──────────────────────────────────────────────────────────

/**
 * What may happen to one unit. `temp`: it sits in a temp folder; otherwise it carries an output name and
 * `proven` says whether its proof held. Only `leftover` and `regenerable` are ever deleted.
 */
export function judge(u: { path: string; temp: boolean; proven: boolean }, f: Facts, ctx: Ctx): Pick<Unit, "status" | "why"> {
  const { path } = u
  if (ctx.keep.some((k) => inside(path, k) || inside(k, path))) return { status: "kept", why: "a kept project" }
  if (f.tracked) return { status: "unverified", why: "git tracks files in it" }
  if (f.unsaved) return { status: "unverified", why: `uncommitted or unpushed work in ${f.unsaved}` }
  if (u.temp && f.top && f.top !== path && !f.ignored) return { status: "unverified", why: `part of the checkout ${f.top}, not ignored by it` }
  if (!u.temp && !u.proven) return { status: "unverified", why: "nothing beside it proves it is build output" }
  // ~/.tool/…/node_modules is an installed tool, not a project's output: deleting it breaks the tool until someone reinstalls it.
  const tool = ctx.home && inside(path, ctx.home) ? path.slice(ctx.home.length + 1).split("/")[0]! : ""
  if (!u.temp && tool.startsWith(".")) return { status: "unverified", why: `inside ~/${tool}, a tool's own folder: its owner decides` }
  const user = ctx.cwds.find((c) => inside(c, u.temp ? path : dirname(path)))
  if (user) return { status: "busy", why: `a process works in ${user}` }
  if (f.active) return { status: "busy", why: `changed in the last ${ACTIVE_MINUTES} min` }
  if (u.temp) return { status: "leftover", why: `idle for ${ACTIVE_MINUTES} min or more` }
  const days = f.commit ? Math.floor((ctx.now / 1000 - f.commit) / 86400) : undefined
  if (days !== undefined && days >= STALE_DAYS) return { status: "leftover", why: `project's last commit ${days}d ago` }
  return { status: "regenerable", why: days === undefined ? "rebuilds on demand" : `project's last commit ${days}d ago` }
}

async function proved(io: Io, path: string, rule: Proof, f: Facts): Promise<boolean> {
  if (!rule.beside && !rule.inside && !rule.ignored) return true
  if (rule.ignored) return f.ignored && !f.tracked
  const at = [...(rule.beside ?? []).map((b) => join(dirname(path), b)), ...(rule.inside ?? []).map((i) => join(path, i))]
  return (await Promise.all(at.map((p) => io.exists(p)))).some(Boolean)
}

/** The owner's command for a path under the home folder, or for a cache inside it. */
export function ownerOf(rel: string, owners: Record<string, string> = OWNERS): string {
  const keys = Object.keys(owners).sort((a, b) => b.length - a.length || cmp(a, b))
  const at = keys.find((k) => inside(rel, k))
  if (at) return owners[at]!
  const under = keys.find((k) => inside(k, rel))
  return under ? `${under.slice(rel.length + 1)}: ${owners[under]}` : ""
}

export const fileKind = (p: string) =>
  /\.(part|partial|crdownload|download|tmp)$/i.test(p) ? "partial download or temp file"
  : /(^|\/)core(\.\d+)?$|\.(dmp|mdmp|hprof|core)$/i.test(p) ? "crash dump"
  : /\.(log|out)(\.\d+)?$/i.test(p) ? "log: rotate or truncate"
  : /\/Downloads\/.*\.(dmg|pkg|iso|zip|tgz|tar(\.\w+)?|exe|msi)$/i.test(p) ? "downloaded installer or archive"
  : /\.(qcow2|vmdk|vdi|raw|img|sparseimage)$/i.test(p) ? "disk image: shrink through its owner"
  : "large file"

// ── survey ───────────────────────────────────────────────────────────

const book = (io: Io) => readJson<Book>(io, state(io, "disk.json"), {})
const bySize = <T extends { kib: number; path: string }>(xs: readonly T[]) => [...xs].sort((a, b) => b.kib - a.kib || cmp(a.path, b.path))

/** Temp folders: every entry is a unit; a busy folder that is not a checkout is split into its children, TEMP_DEPTH levels deep. */
async function tempUnits(io: Io, temps: string[], min: string, ctx: Ctx): Promise<Unit[]> {
  const units: Unit[] = []
  let level = temps
  for (let depth = 1; level.length; depth++) {
    const entries = await sized(io, SCRIPTS.children, [min, ...level])
    const facts = await probe(io, entries.map(([p]) => p))
    level = []
    for (const [path, kib] of entries) {
      const f = facts.get(path)
      if (!f || f.type === "l") continue
      const u: Unit = { path, kib, kind: f.type === "d" ? "temp folder" : "temp file", ...judge({ path, temp: true, proven: true }, f, ctx) }
      if (u.status === "busy" && f.type === "d" && f.top !== path && depth < TEMP_DEPTH) level.push(path)
      else units.push(u)
    }
  }
  return units
}

/** What the walk found, judged: folders with an output name as units, everything else as large files. */
async function walked(io: Io, found: Sized[], ctx: Ctx): Promise<{ units: Unit[]; files: Listed[] }> {
  const facts = await probe(io, found.map(([p]) => p))
  const units: Unit[] = []
  const files: Listed[] = []
  for (const [path, kib] of found) {
    const f = facts.get(path)
    const rule = OUTPUT[basename(path)]
    if (f?.type === "d" && rule) units.push({ path, kib, kind: rule.kind, ...judge({ path, temp: false, proven: await proved(io, path, rule, f) }, f, ctx) })
    else if (f?.type === "f") files.push({ path, kib, note: fileKind(path) })
  }
  return { units, files }
}

/** Caches and app data under the home folder, each with its owner's command where one is known. */
async function homeAreas(io: Io, home: string, min: string, owners: Record<string, string>): Promise<Listed[]> {
  const singles = Object.keys(owners).filter((k) => !AREAS.some((a) => inside(k, a)))
  const found = await Promise.all([sized(io, SCRIPTS.children, [min, ...AREAS.map((a) => join(home, a))]), sized(io, SCRIPTS.sizes, [min, ...singles.map((k) => join(home, k))])])
  return found.flat().map(([path, kib]) => ({ path, kib, note: ownerOf(path.slice(home.length + 1), owners) || "no known owner command: report only" }))
}

/** Finds and judges every unit of `scope`, and remembers the sizes so the next survey can say what grew. */
export async function survey(io: Io, scope: Scope = "project", minMib = MIN_MIB): Promise<Survey> {
  const started = Date.now()
  const whole = scope === "disk"
  const min = String(Math.round(minMib * 1024))
  const fileMin = String(Math.round(Math.max(minMib, LARGE_FILE_MIB) * 1024))
  const home = (await io.env("HOME")) ?? ""
  const [temps, bk, cwds] = await Promise.all([whole ? tempRoots(io) : [], book(io), workdirs(io)])
  // The project scope is asked to clean the project the session works in; the disk scope leaves that project alone.
  const ctx: Ctx = { keep: [...(bk.keep ?? []), ...(whole ? [io.cwd] : [])], cwds: whole ? cwds : cwds.filter((c) => !inside(c, io.cwd)), now: started, home }
  const searched = whole ? [home, ...temps] : [io.cwd]
  const [found, temp, areas] = await Promise.all([
    sized(io, SCRIPTS.walk, [min, fileMin, home, ...searched]),
    tempUnits(io, temps, min, ctx),
    whole ? homeAreas(io, home, min, { ...OWNERS, ...bk.owners }) : [],
  ])
  // Left out of the walk's findings: what a temp unit already covers (a leftover goes as a whole, a loose file is its
  // entry), and an output name directly in the home folder (~/.cache, ~/.gradle), a tool's store the caches section has.
  const gone = temp.filter((u) => u.status === "leftover").map((u) => u.path)
  const rest = await walked(io, found.filter(([p]) => dirname(p) !== home && !gone.some((g) => inside(p, g))), ctx)
  const units = [...temp, ...rest.units]
  const files = rest.files.filter((f) => !temps.some((t) => inside(f.path, t)))

  const all = [...units, ...areas, ...files]
  const before = bk[scope]
  const grew: Listed[] = (before ? all : [])
    .map((x) => ({ path: x.path, kib: x.kib - (before!.kib[x.path] ?? 0), note: x.path in before!.kib ? `now ${size(x.kib)}` : "new" }))
    .filter((g) => g.kib >= Number(min))
  // Read again before writing: a disk_clean may have logged deletions while this survey ran.
  const snapshot: Snapshot = { at: started, kib: Object.fromEntries(all.map((x) => [x.path, x.kib])) }
  await io.write(state(io, "disk.json"), JSON.stringify({ ...(await book(io)), [scope]: snapshot }, null, 1))
  return { scope, df: await usage(io, whole ? home : io.cwd), units: bySize(units), areas: bySize(areas), files: bySize(files), grew: bySize(grew), since: before?.at, searched, seconds: Math.round((Date.now() - started) / 1000), minMib }
}

const SECTIONS: [Status, string][] = [
  ["leftover", "Leftover: nothing uses it; disk_clean deletes it"],
  ["regenerable", "Rebuildable: disk_clean deletes it, the next build or install pays"],
  ["unverified", "Unverified: report only, a person decides"],
  ["busy", "In use: hands off"],
  ["kept", "Kept: hands off"],
]

/** One section: its count and total, the ROWS largest, then how many more. Empty when there is nothing to list. */
function table<T extends { path: string; kib: number }>(title: string, xs: T[], note: (x: T) => string): string[] {
  if (!xs.length) return []
  const total = size(xs.reduce((n, x) => n + x.kib, 0))
  const more = xs.length > ROWS ? [`${" ".repeat(12)}… ${xs.length - ROWS} more`] : []
  return [`\n## ${title} (${xs.length}, ${total})`, ...xs.slice(0, ROWS).map((x) => `${size(x.kib).padStart(10)}  ${x.path}  (${note(x)})`), ...more]
}

export function render(s: Survey, full = FULL_PERCENT): string {
  const of = (st: Status) => s.units.filter((u) => u.status === st)
  const free = of("leftover").length
  const tight = !!s.df && s.df.percent >= full
  return [
    `# disk (${s.scope})`,
    s.df ? `${s.df.mount}: ${s.df.percent}% used, ${size(s.df.freeKib)} free of ${size(s.df.totalKib)}` : "free space unknown (df gave nothing)",
    `searched ${s.searched.join(", ")} in ${s.seconds} s; units from ${s.minMib} MiB`,
    ...SECTIONS.flatMap(([st, title]) => table(title, of(st), (u) => `${u.kind}; ${u.why}`)),
    ...table("Caches and app data: only through the owner's command", s.areas, (a) => a.note),
    ...table("Large files: report only", s.files, (f) => f.note),
    ...table(`Grew since ${s.since ? new Date(s.since).toISOString().slice(0, 16).replace("T", " ") : "the last survey"} UTC`, s.grew, (g) => g.note),
    "",
    free ? `Next: ${TOOL_PREFIX}disk_clean {paths: [the leftover paths], apply: true}.` : "No leftovers found.",
    ...(tight && s.scope === "project" ? [`Still at ${full}% or more after that: ${TOOL_PREFIX}disk {scope: "disk"} looks at the whole disk.`] : []),
    ...(tight && s.scope === "disk" ? ["Still nearly full after that: the rebuildable units, then the caches through their owner's command, largest first."] : []),
  ].join("\n")
}

export const disk = async (io: Io, scope: Scope = "project", minMib = MIN_MIB, full = FULL_PERCENT) => render(await survey(io, scope, minMib), full)

/** The line that asks the agent to free space, or "" while the disk under the working directory is below `full` percent used. */
export async function fullNotice(io: Io, full = FULL_PERCENT): Promise<string> {
  const d = full > 0 ? await usage(io, io.cwd) : undefined
  if (!d || d.percent < full) return ""
  return `[overwatch] The disk this project is on (${d.mount}) is ${d.percent}% full, ${size(d.freeKib)} free. Free space now, before a build or a write fails: (1) run ${TOOL_PREFIX}disk (this project first) and delete its leftovers with ${TOOL_PREFIX}disk_clean; (2) only if the disk is then still at ${full}% or more, run ${TOOL_PREFIX}disk {scope: "disk"} for the whole disk and do the same. The gardener skill has the rules. Then tell the user in one line what was freed, and go on with the work.`
}

// ── cleaning ─────────────────────────────────────────────────────────

/**
 * Deletes the given paths, each only if it is, right now, a temp entry or proven build output that
 * nothing uses: judged again from scratch (never from an earlier survey), not a link, no tracked
 * files, no unsaved checkout inside, no open file. A dry run unless `apply`.
 */
export async function clean(io: Io, paths: string[], apply = false): Promise<string> {
  const asked = [...new Set(paths.map((p) => p.replace(/\/+$/, "")))]
  const bad = asked.filter((p) => !p.startsWith("/") || p.split("/").some((s) => s === "." || s === ".."))
  if (!asked.length || bad.length) throw new Error(bad.length ? `absolute paths without . or .. only: ${bad.join(", ")}` : "no paths given")
  const [temps, bk, cwds, parents, before, home] = await Promise.all([tempRoots(io), book(io), workdirs(io), sh(io, SCRIPTS.real, [...new Set(asked.map(dirname))]), usage(io, io.cwd), io.env("HOME")])
  const parent = new Map(parents.map((r) => [r[0]!, r[1]!]))
  // The parent folder's real path: /tmp/x is judged as /private/tmp/x, where the temp folders are.
  const at = new Map(asked.map((p) => [p, parent.has(dirname(p)) ? join(parent.get(dirname(p))!, basename(p)) : ""]))
  const reals = [...new Set([...at.values()].filter(Boolean))]
  const [facts, sizes, open] = await Promise.all([probe(io, reals), sized(io, SCRIPTS.sizes, ["0", ...reals]), sh(io, SCRIPTS.open, reals)])
  const kib = new Map<string, number>(sizes)
  const held = new Map(open.map((r) => [r[0]!, r[1] ?? ""]))
  const ctx: Ctx = { keep: bk.keep ?? [], cwds: cwds.filter((c) => !inside(c, io.cwd)), now: Date.now(), home: home ?? "" }
  const lines: string[] = []
  const done: NonNullable<Book["cleaned"]> = []
  for (const p of asked) {
    const path = at.get(p)!
    const f = facts.get(path)
    const refuse = (why: string) => lines.push(`refused  ${p}: ${why}`)
    if (!path || !f) { refuse("not found"); continue }
    if (f.type === "l") { refuse("a symbolic link"); continue }
    const rule = f.type === "d" ? OUTPUT[basename(path)] : undefined
    const output = !!rule && (await proved(io, path, rule, f))
    const temp = !output && temps.some((t) => path !== t && inside(path, t) && path.slice(t.length).split("/").length - 1 <= TEMP_DEPTH)
    if (!temp && !rule) { refuse("neither in a temp folder nor a known build output folder"); continue }
    const j = judge({ path, temp, proven: output }, f, ctx)
    if (j.status !== "leftover" && j.status !== "regenerable") { refuse(j.why); continue }
    if (held.get(path)) { refuse(`a process has ${held.get(path)} open`); continue }
    const n = kib.get(path) ?? 0
    if (!apply) { lines.push(`would delete  ${size(n).padStart(10)}  ${path}`); continue }
    const r = await io.run(["rm", "-rf", "--", path], { timeoutMs: SCAN_TIMEOUT_MS })
    if (r.code !== 0 || (await io.exists(path))) { lines.push(`failed   ${path}: ${r.stderr.trim().split("\n")[0] || `rm exited ${r.code}`}`); continue }
    done.push({ at: Date.now(), path, kib: n })
    lines.push(`deleted  ${size(n).padStart(10)}  ${path}`)
  }
  if (done.length) {
    const now = await book(io)
    await io.write(state(io, "disk.json"), JSON.stringify({ ...now, cleaned: [...(now.cleaned ?? []), ...done].slice(-50) }, null, 1))
  }
  const after = apply ? await usage(io, io.cwd) : undefined
  const sum = size(done.reduce((n, d) => n + d.kib, 0))
  return [
    ...lines,
    apply
      ? `${done.length} deleted, ${sum}${before && after ? `; ${after.mount} ${before.percent}% → ${after.percent}% used, ${size(after.freeKib)} free` : ""}`
      : "Dry run: nothing deleted. Pass apply: true to delete the paths marked `would delete`.",
  ].join("\n")
}
