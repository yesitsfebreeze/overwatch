import type { Io } from "./io.ts"
import { join } from "./io.ts"
import { frontmatter, str, strings } from "./note.ts"

export type SyncOptions = { sourceRoot?: string; sourceRef?: string; runtimeRoot?: string }
type Source = { root: string; ref: string; commit: string }
type Mode = "shared" | "seed" | "merge-array"
type FileRule = { source: string; path: string; mode: Mode }
type Migration = { version: number; id: string; files: FileRule[] }
type Manifest = { format: 1; vaultSchemaVersion: number; workflowVersion: number; capabilities: string[]; runtimePaths: string[]; migrations: Migration[] }
type Owned = { hash: string; source: string; mode: Mode }
type Extensions = { mcpTools: string[]; vaultPaths: string[]; workflowPaths: string[]; vaultCount: number }
type Receipt = {
  format: 1; source: Source; runtimeRoot: string; installedCommit: string; migrationVersion: number
  vaultSchemaVersion: number; workflowVersion: number; capabilitiesHash: string
  capabilities: string[]; owned: Record<string, Owned>; extensions: Extensions
  appliedMigrations: string[]; updatedAt: string
}
type Change = { path: string; before: string | null; after: string }
type Runtime = { root: string; commit: string | null; dirty: boolean; verifiedSourceCommit?: string }
type Snapshot = { runtime: Runtime; blobs: Record<string, string> }
export type SyncReport = {
  status: "current" | "outdated" | "uninitialized" | "applied" | "blocked" | "offline" | "error"
  source: Source | null; installedCommit: string | null; migrationVersion: number
  vaultSchemaVersion: number; workflowVersion: number; capabilitiesHash: string
  pending: string[]; applied: string[]; preserved: string[]; conflicts: string[]
  restartRequired: boolean; runtime: Runtime; verification: { ok: boolean; checks: string[] }
  extensions: Extensions; reason?: string
  sharedRuntime?: { root: string; status: string; commit: string | null }
}
type Guard = { path: string; before: string | null }
type DirectoryGuard = { path: string; before: string[] | null }
type Prepared = { report: SyncReport; receiptBefore: string | null; receiptAfter?: Receipt; files: Change[]; interrupted: boolean; guards?: Guard[]; directories?: DirectoryGuard[] }

const STATE = ".overwatch/sync/state.json"
const JOURNAL = ".overwatch/sync/journal.json"
const MANIFEST = "data/sync-manifest.json"
const INSTRUCTIONS = ".overwatch/shared/OVERWATCH.md"
const runtimes = new Map<string, Promise<Snapshot>>()
const sourceFiles = new Map<string, Promise<string>>()
const slash = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "")
const canonical = (s: string) => slash(s).toLowerCase()
const sorted = (s: string[]) => [...new Set(s)].sort()
const emptyExtensions = (): Extensions => ({ mcpTools: [], vaultPaths: [], workflowPaths: [], vaultCount: 0 })
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v)
const digest = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map(n => n.toString(16).padStart(2, "0")).join("")
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const safeRelative = (s: unknown): s is string => typeof s === "string" && !!s && !s.includes("\\") && !s.startsWith("/") && !s.includes(":") && s.split("/").every(p => p !== ".." && p !== "." && !!p)
const absolute = (s: string) => /^(?:[A-Za-z]:[\\/]|\/)/.test(s)
const safeTarget = (p: string) => safeRelative(p) && (p.startsWith(".overwatch/shared/") || p.startsWith(".overwatch/vault/")) &&
  !/^\.overwatch\/vault\/(?:01 specs|02 prds|13 issues|14 proposals|16 research|17 questions)(?:\/|$)/.test(p.toLowerCase()) &&
  !/\/(?:plan data\.json|plan tasks\.md)$/.test(p.toLowerCase())
const overlap = (a: string, b: string) => {
  a = canonical(a).replace(/^\.\//, "").replace(/\/+$/, "")
  b = canonical(b).replace(/^\.\//, "").replace(/\/+$/, "")
  return a === "." || a === "" || b === "." || b === "" || a === b || a.startsWith(b + "/") || b.startsWith(a + "/")
}
async function git(io: Io, root: string, args: string[], stdin?: string) {
  return io.run(["git", "-C", root, ...args], { stdin, timeoutMs: 15000 })
}
async function gitBlob(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const header = new TextEncoder().encode("blob " + bytes.length + "\0")
  const data = new Uint8Array(header.length + bytes.length)
  data.set(header); data.set(bytes, header.length)
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", data))].map(n => n.toString(16).padStart(2, "0")).join("")
}
async function snapshot(io: Io): Promise<Snapshot> {
  const key = slash(io.root)
  if (!runtimes.has(key)) runtimes.set(key, (async () => {
    const [h, d] = await Promise.all([
      git(io, io.root, ["rev-parse", "--verify", "HEAD"]),
      git(io, io.root, ["status", "--porcelain=v1", "--untracked-files=no", "--", "hooks", "host", "bin", "types", "adapters", "jev", ".claude-plugin", ".codex-plugin", ".cursor-plugin", ".github/plugin", "package.json"]),
    ])
    const local: Io = { ...io, cwd: io.root }
    const blobs: Record<string, string> = {}
    for (const dir of ["hooks", "host", "bin", "types", "adapters", "jev", ".claude-plugin", ".codex-plugin", ".cursor-plugin", ".github/plugin", "data/shared"]) {
      for (const p of await walk(local, dir, 0, undefined, true)) {
        const text = await io.read(join(io.root, p))
        if (text !== undefined) blobs[p] = await gitBlob(text)
      }
    }
    for (const p of ["package.json", "data/sync-manifest.json"]) {
      const text = await io.read(join(io.root, p))
      if (text !== undefined) blobs[p] = await gitBlob(text)
    }
    return { runtime: { root: io.root, commit: h.code === 0 ? h.stdout.trim() : null, dirty: d.code !== 0 || !!d.stdout.trim() }, blobs }
  })())
  return runtimes.get(key)!
}
async function runtime(io: Io): Promise<Runtime> { return (await snapshot(io)).runtime }
export async function captureSyncRuntime(io: Io): Promise<void> { await runtime(io) }
async function runtimeEvidence(io: Io, source: Source, manifest: Manifest): Promise<{ runtime: Runtime; matches: boolean }> {
  const snap = await snapshot(io)
  const tree = await git(io, source.root, ["ls-tree", "-r", "-z", source.commit, "--", ...manifest.runtimePaths])
  if (tree.code !== 0) return { runtime: snap.runtime, matches: false }
  const expected = new Map<string, string>()
  for (const row of tree.stdout.split("\0").filter(Boolean)) {
    const m = /^[0-9]+ blob ([0-9a-f]+)\t(.+)$/.exec(row)
    if (m) expected.set(m[2]!, m[1]!)
  }
  const captured = Object.keys(snap.blobs).filter(p => manifest.runtimePaths.some(r => p === r || p.startsWith(r + "/")))
  const matches = expected.size > 0 && captured.length === expected.size && [...expected].every(([p, hash]) => snap.blobs[p] === hash)
  return { runtime: matches ? { ...snap.runtime, verifiedSourceCommit: source.commit } : snap.runtime, matches }
}
function validateManifest(value: unknown): Manifest {
  if (!object(value) || value.format !== 1 || !Number.isInteger(value.vaultSchemaVersion) || value.vaultSchemaVersion < 1 ||
      !Number.isInteger(value.workflowVersion) || value.workflowVersion < 1 || !Array.isArray(value.capabilities) ||
      !value.capabilities.every((x: unknown) => typeof x === "string") || !Array.isArray(value.runtimePaths) ||
      !value.runtimePaths.every(safeRelative) || !Array.isArray(value.migrations) || !value.migrations.length)
    throw new Error("unsupported or invalid synchronization manifest")
  const migrations = value.migrations as Migration[]
  const ids = new Set<string>()
  const paths = new Map<string, string>()
  for (let i = 0; i < migrations.length; i++) {
    const m = migrations[i]!
    if (!object(m) || m.version !== i + 1 || typeof m.id !== "string" || !m.id || ids.has(m.id) || !Array.isArray(m.files))
      throw new Error("migration versions must be contiguous from 1 with unique IDs")
    ids.add(m.id)
    const inVersion = new Set<string>()
    for (const f of m.files) {
      if (typeof f.path === "string") {
        const key = f.path.toLowerCase()
        if (inVersion.has(key) || (paths.has(key) && paths.get(key) !== f.path)) throw new Error("manifest has duplicate or case-aliased targets")
        inVersion.add(key); paths.set(key, f.path)
      }
      if (!object(f) || !safeRelative(f.source) || !f.source.startsWith("data/") ||
      !safeTarget(f.path) || !["shared", "seed", "merge-array"].includes(f.mode))
        throw new Error("manifest contains an unsafe or unsupported file rule")
    }
  }
  return value as Manifest
}
function validateReceipt(value: unknown): Receipt {
  if (!object(value) || value.format !== 1 || !object(value.source) || typeof value.source.root !== "string" ||
      typeof value.source.ref !== "string" || !/^[0-9a-f]{40,64}$/.test(value.installedCommit) ||
      !Number.isInteger(value.migrationVersion) || !Number.isInteger(value.vaultSchemaVersion) ||
      !Number.isInteger(value.workflowVersion) || !object(value.owned) || !Array.isArray(value.appliedMigrations))
    throw new Error("invalid synchronization receipt; preserve it and recover explicitly")
  for (const [p, v] of Object.entries(value.owned)) if (!safeRelative(p) || !object(v) || !/^[0-9a-f]{64}$/.test(v.hash))
    throw new Error("invalid owned-file evidence in synchronization receipt")
  return value as Receipt
}
async function walk(io: Io, dir: string, depth = 0, directories?: DirectoryGuard[], skipDependencies = false): Promise<string[]> {
  if (depth > 16) throw new Error("vault directory nesting exceeds safe inspection depth")
  const out: string[] = []
  const entries = await io.list(join(io.cwd, dir))
  if (directories) directories.push({ path: dir, before: await io.exists(join(io.cwd, dir)) ? entries.map(e => e.name).sort() : null })
  for (const e of entries) {
    if (skipDependencies && ["node_modules", ".git", ".overwatch"].includes(e.name)) continue
    const p = dir + "/" + e.name
    if (!safeRelative(p)) throw new Error("unsafe directory entry while inspecting extensions")
    if (e.kind === "dir") out.push(...await walk(io, p, depth + 1, directories, skipDependencies))
    else if (e.kind === "file") out.push(p)
  }
  return out
}
async function claims(io: Io, captured?: { guards: Guard[]; directories: DirectoryGuard[] }): Promise<{ owner: string; unit: string; paths: string[] }[]> {
  const out: { owner: string; unit: string; paths: string[] }[] = []
  for (const p of await walk(io, ".overwatch/vault/01 Specs", 0, captured?.directories)) {
    if (!p.toLowerCase().endsWith(".md")) continue
    const text = (await io.read(join(io.cwd, p))) ?? null
    captured?.guards.push({ path: p, before: text })
    const fields = frontmatter(text ?? "").fields
    const owner = str(fields.owner)
    if (owner && !["implemented", "done", "closed", "collected"].includes(str(fields.status))) out.push({ owner, unit: p, paths: strings(fields.paths) })
  }
  return out
}
async function extensionInventory(io: Io, managed: Set<string>, config?: Record<string, any>): Promise<Extensions> {
  const vault = (await walk(io, ".overwatch/vault")).filter(p => !managed.has(p))
  const workflows: string[] = []
  for (const p of ["AGENTS.md", "CLAUDE.md", "SYSTEMS.md", "SYSTEM.md", "INVARIANTS.md", "WORK.md", "justfile", "workflow.config.json", ".claude/settings.json", ".claude/settings.local.json", "dev/wf", ".opencode", "opencode.json"])
    if (await io.exists(join(io.cwd, p))) workflows.push(p)
  return { mcpTools: sorted(Object.keys(config?.mcpServers ?? {}).filter(k => k !== "overwatch")),
    vaultPaths: vault.sort().slice(0, 100), vaultCount: vault.length, workflowPaths: workflows }
}
async function sourceText(io: Io, source: Source, path: string) {
  const key = source.root + ":" + source.commit + ":" + path
  if (!sourceFiles.has(key)) sourceFiles.set(key, (async () => {
    const r = await git(io, source.root, ["show", source.commit + ":" + path])
    if (r.code !== 0) { sourceFiles.delete(key); throw new Error("source commit is missing " + path) }
    return r.stdout
  })())
  return sourceFiles.get(key)!
}
async function knownOfficial(io: Io, source: Source, path: string, text: string): Promise<boolean> {
  const log = await git(io, source.root, ["log", "--format=%H", source.commit, "--", path])
  if (log.code !== 0) return false
  for (const commit of log.stdout.trim().split(/\r?\n/).filter(Boolean)) {
    const r = await git(io, source.root, ["show", commit + ":" + path])
    if (r.code === 0 && r.stdout === text) return true
  }
  return false
}
function standardOverwatch(value: unknown): boolean {
  if (!object(value) || Object.keys(value).some(k => !["command", "args", "type"].includes(k))) return false
  const cmd = typeof value.command === "string" ? slash(value.command).toLowerCase() : ""
  const args = value.args
  if (!Array.isArray(args) || !args.every(a => typeof a === "string")) return false
  if ((cmd === "overwatch" || /\/overwatch(?:\.exe)?$/.test(cmd)) && args.length === 1 && args[0] === "mcp") return true
  return /(?:^|\/)bun(?:\.exe)?$/.test(cmd) && args.length === 2 && args[1] === "mcp" &&
    /(?:^|\/)overwatch\/bin\/(?:cli\.ts|overwatch)$/.test(slash(args[0]).toLowerCase())
}
function reportBase(rt: Runtime, old?: Receipt): SyncReport {
  return { status: old ? "outdated" : "uninitialized", source: null, installedCommit: old?.installedCommit ?? null,
    migrationVersion: old?.migrationVersion ?? 0, vaultSchemaVersion: old?.vaultSchemaVersion ?? 0,
    workflowVersion: old?.workflowVersion ?? 0, capabilitiesHash: old?.capabilitiesHash ?? "",
    pending: [], applied: [], preserved: [], conflicts: [], restartRequired: false, runtime: rt,
    verification: { ok: false, checks: [] }, extensions: emptyExtensions() }
}
async function machineHome(io: Io): Promise<string | undefined> {
  const home = await io.env("HOME")
  if (home && absolute(home)) return slash(home)
  const r = await io.run(["bun", "-e", "console.log(require('node:os').homedir())"], { timeoutMs: 5000 })
  return r.code === 0 && absolute(r.stdout.trim()) ? slash(r.stdout.trim()) : undefined
}
async function machineAuthority(io: Io): Promise<SyncOptions | undefined> {
  const home = await machineHome(io)
  if (!home) return undefined
  const raw = await io.read(join(home, ".overwatch/source.json"))
  if (raw === undefined) return undefined
  const value = JSON.parse(raw)
  if (!object(value) || typeof value.sourceRoot !== "string" || (value.sourceRef !== undefined && typeof value.sourceRef !== "string") ||
      (value.runtimeRoot !== undefined && typeof value.runtimeRoot !== "string"))
    throw new Error("invalid machine authority configuration; preserve and repair it explicitly")
  return value as SyncOptions
}
async function inspectRuntime(io: Io, source: Source, root: string, apply: boolean): Promise<any> {
  const r = await io.run(["bun", join(io.root, "bin/sync-runtime.ts")], {
    cwd: io.cwd, stdin: JSON.stringify({ sourceRoot: source.root, sourceCommit: source.commit, runtimeRoot: root, apply }), timeoutMs: 60000,
  })
  try {
    const result = JSON.parse(r.stdout)
    if (!["current", "outdated", "updated", "blocked", "offline"].includes(result.status)) throw new Error()
    return result
  } catch { return { status: "blocked", commit: null, conflicts: [r.stderr.trim() || "runtime adapter did not return a valid result"] } }
}
async function prepare(io: Io, options: SyncOptions): Promise<Prepared> {
  const rt = await runtime(io)
  const before = (await io.read(join(io.cwd, STATE))) ?? null
  let old: Receipt | undefined
  try { if (before !== null) old = validateReceipt(JSON.parse(before)) } catch (e: any) {
    return { report: { ...reportBase(rt), status: "blocked", conflicts: [e.message] }, receiptBefore: before, files: [], interrupted: false }
  }
  const report = reportBase(rt, old)
  const hint = !options.sourceRoot && !old ? await machineAuthority(io) : undefined
  const root = options.sourceRoot ?? old?.source.root ?? hint?.sourceRoot ?? io.root
  const ref = options.sourceRef ?? old?.source.ref ?? hint?.sourceRef ?? "HEAD"
  const result: Prepared = { report, receiptBefore: before, files: [], interrupted: await io.exists(join(io.cwd, JOURNAL)) }
  if (!absolute(root) || !ref || ref.startsWith("-") || ref.includes("\0")) {
    report.status = "blocked"; report.conflicts.push("authority root must be absolute and ref must be a Git revision"); return result
  }
  const rev = await git(io, root, ["rev-parse", "--verify", ref + "^{commit}"])
  if (rev.code !== 0) {
    report.status = !options.sourceRoot && !old && !hint ? "current" : "offline"
    report.reason = report.status === "current" ? "unconfigured" : "authoritative source/ref is unavailable"
    return result
  }
  const source: Source = { root: slash(root), ref, commit: rev.stdout.trim() }
  report.source = source
  report.restartRequired = rt.commit !== source.commit || rt.dirty
  const manifestText = await git(io, root, ["show", source.commit + ":" + MANIFEST])
  if (manifestText.code !== 0) {
    report.status = options.sourceRoot || old || hint ? "offline" : "current"
    report.reason = options.sourceRoot || old || hint ? "authoritative commit has no synchronization manifest" : "unconfigured"
    return result
  }
  let manifest: Manifest
  try { manifest = validateManifest(JSON.parse(manifestText.stdout)) } catch (e: any) {
    report.status = "blocked"; report.conflicts.push(e.message); return result
  }
  const runtimeProof = await runtimeEvidence(io, source, manifest)
  report.runtime = runtimeProof.runtime
  report.restartRequired = !runtimeProof.matches
  const runtimeRoot = slash(options.runtimeRoot ?? old?.runtimeRoot ?? hint?.runtimeRoot ?? (rt.commit ? io.root : ""))
  if (!absolute(runtimeRoot)) {
    report.status = "blocked"; report.conflicts.push("configure an absolute shared runtimeRoot for this installed plugin"); return result
  }
  const deployment = await inspectRuntime(io, source, runtimeRoot, false)
  report.sharedRuntime = { root: runtimeRoot, status: deployment.status, commit: deployment.commit }
  if (deployment.status === "blocked" || deployment.status === "offline") {
    report.status = deployment.status; report.conflicts = deployment.conflicts ?? []; report.reason = deployment.error; return result
  }
  const version = manifest.migrations.at(-1)!.version
  if (old && (old.migrationVersion > version || old.vaultSchemaVersion > manifest.vaultSchemaVersion || old.workflowVersion > manifest.workflowVersion)) {
    report.status = "blocked"; report.conflicts.push("source would downgrade an installed migration or schema"); return result
  }
  const rules = new Map<string, FileRule>()
  for (const m of manifest.migrations) for (const f of m.files) rules.set(f.path, f)
  const owned: Record<string, Owned> = { ...(old?.owned ?? {}) }
  const captured = { guards: [{ path: ".overwatch/plan.json", before: (await io.read(join(io.cwd, ".overwatch/plan.json"))) ?? null }] as Guard[], directories: [] as DirectoryGuard[] }
  const active = await claims(io, captured)
  result.guards = captured.guards; result.directories = captured.directories
  const candidates: Change[] = []
  for (const f of rules.values()) {
    const want = await sourceText(io, source, f.source)
    const now = (await io.read(join(io.cwd, f.path))) ?? null
    captured.guards.push({ path: f.path, before: now })
    const hash = await digest(want)
    if (f.mode === "seed" && now !== null) {
      report.preserved.push(f.path)
      if (owned[f.path] && owned[f.path]!.hash !== await digest(now)) delete owned[f.path]
      continue
    }
    let after = want
    if (f.mode === "merge-array" && now !== null) {
      try {
        const have: unknown = JSON.parse(now), required: unknown = JSON.parse(want)
        if (!Array.isArray(have) || !Array.isArray(required) || !have.every(x => typeof x === "string") || !required.every(x => typeof x === "string")) throw new Error()
        const merged = [...have, ...required.filter(x => !have.includes(x))]
        after = merged.length === have.length ? now : json(merged)
        if (have.some(x => !required.includes(x))) report.preserved.push(f.path + " custom entries")
      } catch { report.conflicts.push(f.path + ": customized or invalid array configuration"); continue }
    } else if (now !== null && now !== want) {
      const evidence = old?.owned[f.path]
      const unchanged = evidence && evidence.hash === await digest(now)
      if (!unchanged && !(await knownOfficial(io, source, f.source, now))) {
        report.preserved.push(f.path)
        report.conflicts.push(f.path + ": custom shared file has no unchanged ownership baseline")
        continue
      }
    }
    owned[f.path] = { hash: after === want ? hash : await digest(after), source: f.source, mode: f.mode }
    if (now !== after) candidates.push({ path: f.path, before: now, after })
  }
  const configBefore = (await io.read(join(io.cwd, ".mcp.json"))) ?? null
  captured.guards.push({ path: ".mcp.json", before: configBefore })
  let config: Record<string, any> = {}
  try {
    if (configBefore !== null) config = JSON.parse(configBefore)
    if (!object(config) || (config.mcpServers !== undefined && !object(config.mcpServers))) throw new Error()
  } catch { report.conflicts.push(".mcp.json: invalid project configuration"); config = {} }
  const desired = { command: "bun", args: [join(runtimeRoot, "bin/cli.ts"), "mcp"] }
  const current = config.mcpServers?.overwatch
  const sameMcp = object(current) && current.command === desired.command && JSON.stringify(current.args) === JSON.stringify(desired.args)
  const previouslyOwnedMcp = old && JSON.stringify(current) === JSON.stringify({ command: "bun", args: [join(old.runtimeRoot ?? old.source.root, "bin/cli.ts"), "mcp"] })
  if (!sameMcp && !report.conflicts.some(s => s.startsWith(".mcp.json:"))) {
    if (current !== undefined && !previouslyOwnedMcp && !standardOverwatch(current)) {
      report.preserved.push(".mcp.json custom overwatch server")
      report.conflicts.push(".mcp.json: custom overwatch server requires explicit reconciliation")
    } else {
      candidates.push({ path: ".mcp.json", before: configBefore, after: json({ ...config, mcpServers: { ...config.mcpServers, overwatch: desired } }) })
    }
  }
  for (const c of candidates) {
    const held = active.filter(a => !a.paths.length || a.paths.some(p => overlap(p, c.path)))
    if (held.length) { report.conflicts.push(c.path + ": claimed by " + held.map(a => a.owner).join(", ")); continue }
    const dirty = await git(io, io.cwd, ["status", "--porcelain=v1", "--untracked-files=all", "--", c.path])
    if (dirty.code === 0 && dirty.stdout.trim()) { report.conflicts.push(c.path + ": working-tree changes preserved"); continue }
    if (dirty.code !== 0 && await io.exists(join(io.cwd, ".git"))) { report.conflicts.push(c.path + ": unable to verify working-tree state"); continue }
    result.files.push(c)
  }
  const changing = new Set(result.files.map(f => f.path))
  result.guards = captured.guards.filter(g => !changing.has(g.path))
  const managed = new Set(Object.keys(owned))
  report.extensions = await extensionInventory(io, managed, config)
  report.preserved = sorted([...report.preserved, ...report.extensions.mcpTools.map(n => ".mcp.json mcpServers." + n), ...report.extensions.workflowPaths])
  const capabilitiesHash = await digest(JSON.stringify(sorted(manifest.capabilities)))
  const missing = manifest.migrations.filter(m => m.version > (old?.migrationVersion ?? 0)).map(m => m.id)
  report.pending = [...missing]
  if (deployment.status === "outdated") report.pending.push("shared-runtime-fast-forward")
  if (old && old.installedCommit !== source.commit) report.pending.push("content@" + source.commit.slice(0, 12))
  if (result.files.length && !report.pending.length) report.pending.push("repair-owned-infrastructure")
  if (result.interrupted) report.pending.push("recover-interrupted-migration")
  const same = old && old.installedCommit === source.commit && old.source.root === source.root && old.source.ref === ref &&
    old.runtimeRoot === runtimeRoot && deployment.status === "current" &&
    old.migrationVersion === version && old.vaultSchemaVersion === manifest.vaultSchemaVersion &&
    old.workflowVersion === manifest.workflowVersion && old.capabilitiesHash === capabilitiesHash && !result.files.length && !result.interrupted
  report.verification.checks = ["authoritative committed manifest parsed", "project extensions inventoried", "claims and dirty targets checked", "shared file ownership checked"]
  if (report.conflicts.length) { report.status = "blocked"; report.conflicts = sorted(report.conflicts); return result }
  if (same) {
    report.status = "current"; report.pending = []; report.verification.ok = true
    report.verification.checks.push("installed receipt and owned infrastructure match")
    return result
  }
  report.status = old ? "outdated" : "uninitialized"
  result.receiptAfter = { ...old, format: 1, source, runtimeRoot, installedCommit: source.commit, migrationVersion: version,
    vaultSchemaVersion: manifest.vaultSchemaVersion, workflowVersion: manifest.workflowVersion,
    capabilitiesHash, capabilities: sorted(manifest.capabilities), owned, extensions: report.extensions,
    appliedMigrations: sorted([...(old?.appliedMigrations ?? []), ...missing]), updatedAt: new Date().toISOString() }
  return result
}
export async function syncConfigure(io: Io, options: SyncOptions): Promise<SyncReport> {
  return configureAuthority(io, options, 0)
}
async function configureAuthority(io: Io, options: SyncOptions, recovery: number): Promise<SyncReport> {
  const report = reportBase(await runtime(io))
  const root = options.sourceRoot, ref = options.sourceRef ?? "HEAD"
  if (!root || !absolute(root) || !ref || ref.startsWith("-") || ref.includes("\0")) {
    return { ...report, status: "blocked", conflicts: ["sourceRoot must name an absolute committed Overwatch checkout"] }
  }
  const rev = await git(io, root, ["rev-parse", "--verify", ref + "^{commit}"])
  if (rev.code !== 0) return { ...report, status: "offline", reason: "authoritative source/ref is unavailable" }
  const source = { root: slash(root), ref, commit: rev.stdout.trim() }
  try { validateManifest(JSON.parse(await sourceText(io, source, MANIFEST))) } catch (e: any) {
    return { ...report, source, status: "blocked", conflicts: [String(e?.message ?? e)] }
  }
  const home = await machineHome(io)
  if (!home) return { ...report, source, status: "blocked", conflicts: ["cannot resolve the machine-local authority directory"] }
  const path = ".overwatch/source.json"
  const before = (await io.read(join(home, path))) ?? null
  const runtimeRoot = slash(options.runtimeRoot ?? (report.runtime.commit ? io.root : ""))
  if (!absolute(runtimeRoot)) return { ...report, source, status: "blocked", conflicts: ["configure an absolute shared runtimeRoot"] }
  const after = json({ sourceRoot: source.root, sourceRef: ref, runtimeRoot })
  if (before === after && !(await io.exists(join(home, JOURNAL)))) return { ...report, source, status: "current", reason: "machine-authority-configured", verification: { ok: true, checks: ["machine authority already matches"] } }
  const receiptBefore = (await io.read(join(home, STATE))) ?? null
  if (receiptBefore !== null) {
    try { if (JSON.parse(receiptBefore)?.kind !== "authority") throw new Error() } catch {
      return { ...report, source, status: "blocked", conflicts: ["machine authority receipt path already belongs to project state"] }
    }
  }
  const receipt = { path: STATE, before: receiptBefore, after: json({ format: 1, kind: "authority", source, configuredAt: new Date().toISOString() }) }
  const files = [{ path, before, after }]
  const transactionId = (await digest(JSON.stringify({ files, receipt }))).slice(0, 32)
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await io.run(["bun", join(io.root, "bin/sync-transaction.ts")], { cwd: home, stdin: JSON.stringify({ action: "apply", root: home, transactionId, files, receipt }), timeoutMs: 60000 })
    let output: any
    try { output = JSON.parse(r.stdout) } catch { return { ...report, source, status: "error", reason: r.stderr.trim() || "authority transaction failed" } }
    if (output.status === "recovered" && attempt === 0 && recovery === 0) return configureAuthority(io, options, 1)
    if (!["applied", "noop"].includes(output.status)) return { ...report, source, status: "blocked", conflicts: output.conflicts?.length ? output.conflicts : [output.error ?? output.status] }
    if (await io.read(join(home, path)) !== after) return { ...report, source, status: "error", reason: "authority read-back failed" }
    return { ...report, source, status: "applied", reason: "machine-authority-configured", applied: [join(home, path)], verification: { ok: true, checks: ["machine authority committed and read back"] } }
  }
  return { ...report, source, status: "blocked", conflicts: ["authority recovery requires retry"] }
}
async function checked(io: Io, options: SyncOptions): Promise<Prepared> {
  try { return await prepare(io, options) } catch (e: any) {
    return { report: { ...reportBase(await runtime(io)), status: "error", reason: String(e?.message ?? e) }, receiptBefore: null, files: [], interrupted: false }
  }
}
export async function syncCheck(io: Io, options: SyncOptions = {}): Promise<SyncReport> {
  return (await checked(io, options)).report
}
export async function syncVerify(io: Io, options: SyncOptions = {}): Promise<SyncReport> {
  const p = await checked(io, options)
  if (p.report.reason === "unconfigured") { p.report.status = "uninitialized"; p.report.verification.ok = false }
  return p.report
}
export async function syncMigrate(io: Io, options: SyncOptions = {}): Promise<SyncReport> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = await checked(io, options)
    if (["blocked", "offline", "error", "current"].includes(p.report.status)) return p.report
    if (!p.receiptAfter) return p.report
    if (p.report.sharedRuntime?.status === "outdated" && p.report.source) {
      const upgrade = await inspectRuntime(io, p.report.source, p.report.sharedRuntime.root, true)
      if (!["current", "updated"].includes(upgrade.status))
        return { ...p.report, status: upgrade.status === "offline" ? "offline" : "blocked", conflicts: upgrade.conflicts ?? [], reason: upgrade.error }
      if (attempt < 2) continue
      return { ...p.report, status: "blocked", conflicts: ["shared runtime advanced repeatedly; retry against the stable authority"] }
    }
    const receipt = { path: STATE, before: p.receiptBefore, after: json(p.receiptAfter) }
    const transactionId = (await digest(JSON.stringify({ source: p.report.source, files: p.files, receipt }))).slice(0, 32)
    const out = await io.run(["bun", join(io.root, "bin/sync-transaction.ts")], {
      cwd: io.cwd, stdin: JSON.stringify({ action: "apply", root: io.cwd, transactionId, files: p.files, receipt, guards: p.guards, directories: p.directories }), timeoutMs: 60000,
    })
    let response: any
    try { response = JSON.parse(out.stdout.trim()) } catch {
      return { ...p.report, status: "error", reason: "transaction adapter failed: " + (out.stderr.trim() || "invalid response") }
    }
    if (response.status === "recovered") {
      if (attempt < 2) continue
      return { ...p.report, status: "blocked", conflicts: ["migration recovery needs another explicit retry"] }
    }
    if (!["applied", "noop"].includes(response.status))
      return { ...p.report, status: "blocked", conflicts: sorted([...(response.conflicts ?? []), response.error ?? response.status ?? "transaction failed"]) }
    const verified = await syncVerify(io, options)
    if (verified.status !== "current") return verified
    return { ...verified, status: response.status === "applied" ? "applied" : "current",
      applied: [...p.report.pending, ...p.files.map(f => f.path)], verification: { ok: true, checks: [...verified.verification.checks, "transaction committed and read back"] } }
  }
  throw new Error("unreachable synchronization retry")
}
export async function syncAutomatic(io: Io, options: SyncOptions & { reason?: "initialize" | "reconnect" | "session.start" } = {}): Promise<SyncReport> {
  return syncMigrate(io, options)
}
export function syncNotice(r: SyncReport): string {
  if (r.reason === "unconfigured") return ""
  if (r.status === "current" || r.status === "applied")
    return "[overwatch sync] " + r.status + " at " + (r.installedCommit?.slice(0, 12) ?? "unknown") +
      ". Shared workflow: " + INSTRUCTIONS + (r.restartRequired ? ". Running core differs; reconnect to load the installed core." : ".")
  return "[overwatch sync] " + r.status + ": " + (r.reason ?? r.conflicts.slice(0, 3).join("; ") ?? "migration required") + ". Project work was preserved."
}
