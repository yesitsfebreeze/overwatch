// Exact-commit fast-forward boundary for the shared runtime; never changes branches or restarts hosts.
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { frontmatter, str, strings } from "../hooks/note.ts"
import { acquireSyncLock, containedPath } from "./sync-transaction.ts"

export type RuntimeSyncRequest = { sourceRoot: string; sourceCommit: string; runtimeRoot: string; apply: boolean }
export type RuntimeSyncResponse = {
  status: "current" | "outdated" | "updated" | "blocked" | "offline"
  commit: string | null; conflicts: string[]; restartRequired: boolean; error?: string
}
type Checkpoint = (stage: "locked" | "fetched" | "ready" | "updated") => void
const lockArea = ".overwatch/runtime-sync"
const slash = (s: string) => s.replaceAll("\\", "/").replace(/\/+$/, "")
const canonical = (s: string) => slash(s).toLowerCase()
const errorCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code
const hash = (b: Buffer | string) => createHash("sha256").update(b).digest("hex")
class Blocked extends Error { constructor(readonly paths: string[], message: string) { super(message) } }
class Offline extends Error {}
function git(root: string, args: string[]) {
  const r = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8", timeout: 15000, maxBuffer: 16 << 20, windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  })
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.error?.message ?? r.stderr ?? "" }
}
function requireGit(root: string, args: string[]): string {
  const r = git(root, args)
  if (r.code !== 0) throw new Blocked([], "git " + args[0] + " failed: " + r.stderr.trim())
  return r.stdout
}
function repository(input: string, label: string): string {
  if (typeof input !== "string" || !isAbsolute(input)) throw new Blocked([], label + " must be an absolute repository root")
  let root: string
  try {
    const s = lstatSync(input)
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Blocked([], label + " must be a real directory")
    root = realpathSync(input)
  } catch (e) {
    if (errorCode(e) === "ENOENT") throw new Offline(label + " is unavailable")
    throw e
  }
  const top = git(root, ["rev-parse", "--show-toplevel"])
  if (top.code !== 0) throw new Offline(label + " is not an accessible Git checkout")
  if (canonical(top.stdout.trim()) !== canonical(root)) throw new Blocked([], label + " must name the checkout root")
  return root
}
function head(root: string): string { return requireGit(root, ["rev-parse", "--verify", "HEAD"]).trim() }
function branch(root: string): string | null {
  const r = git(root, ["symbolic-ref", "--quiet", "HEAD"])
  if (r.code === 0) return r.stdout.trim()
  if (r.code === 1) return null
  throw new Blocked([], "Unable to verify the runtime branch")
}
function clean(root: string): void {
  const r = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=no"])
  if (r.code !== 0) throw new Blocked([], "Unable to verify runtime working-tree/index state")
  if (r.stdout) throw new Blocked(["tracked working tree or index"], "Runtime has tracked edits or staged work; preserve and reconcile them")
}
function overlap(a: string, b: string): boolean {
  a = canonical(a).replace(/^\.\//, "")
  b = canonical(b).replace(/^\.\//, "")
  return !a || a === "." || a === b || a.startsWith(b + "/") || b.startsWith(a + "/")
}
function activeClaims(root: string, changed: string[]): string[] {
  if (!changed.length) return []
  const held: string[] = []
  const visit = (relative: string, depth = 0) => {
    if (depth > 16) throw new Blocked([relative], "Claim directory nesting exceeds inspection limit")
    const p = containedPath(root, relative)
    let entries: ReturnType<typeof readdirSync>
    try { entries = readdirSync(p) } catch (e) { if (errorCode(e) === "ENOENT") return; throw e }
    for (const name of entries as string[]) {
      const path = relative + "/" + name
      const full = containedPath(root, path), stat = lstatSync(full)
      if (stat.isDirectory()) { visit(path, depth + 1); continue }
      if (!stat.isFile() || !name.toLowerCase().endsWith(".md")) continue
      const f = frontmatter(readFileSync(full, "utf8")).fields
      const owner = str(f.owner)
      if (!owner || ["implemented", "done", "closed", "collected"].includes(str(f.status).toLowerCase())) continue
      const paths = strings(f.paths)
      if (!paths.length || paths.some(scope => changed.some(path => overlap(scope, path)))) held.push(path)
    }
  }
  visit(".overwatch/vault/01 Specs")
  return held
}
function safeUntracked(root: string, path: string): string {
  if (!path || path.includes("\\") || path.includes(":") || isAbsolute(path) ||
      path.split("/").some(p => !p || p === "." || p === "..")) throw new Blocked([path], "Unsafe Git path")
  const slashAt = path.lastIndexOf("/")
  if (slashAt >= 0) containedPath(root, path.slice(0, slashAt))
  return join(root, ...path.split("/"))
}
function fingerprint(root: string, path: string): string {
  const p = safeUntracked(root, path)
  const stat = lstatSync(p)
  if (stat.isSymbolicLink()) return "link:" + readlinkSync(p)
  if (stat.isFile()) return "file:" + stat.mode + ":" + hash(readFileSync(p))
  if (stat.isDirectory()) return "dir:" + JSON.stringify(readdirSync(p).sort())
  throw new Blocked([path], "Cannot verify an untracked special file")
}
function retained(root: string, tracked: Set<string>): Map<string, string> {
  const paths = requireGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)
  if (!tracked.has("bun.lock")) {
    try { lstatSync(join(root, "bun.lock")); paths.push("bun.lock") } catch (e) { if (errorCode(e) !== "ENOENT") throw e }
  }
  const out = new Map<string, string>()
  for (const path of new Set(paths)) {
    if (path === lockArea || path.startsWith(lockArea + "/")) continue
    // Git reports an untracked nested repository as a directory with a trailing slash.
    const p = path.replace(/\/$/, "")
    out.set(p, fingerprint(root, p))
  }
  return out
}
function verifyRetained(root: string, before: Map<string, string>): void {
  const changed: string[] = []
  for (const [path, value] of before) {
    try { if (fingerprint(root, path) !== value) changed.push(path) }
    catch (e) { if (errorCode(e) === "ENOENT") changed.push(path); else throw e }
  }
  if (changed.length) throw new Blocked(changed, "Runtime advanced but an existing untracked file changed; do not reset it")
}
function incomingCollisions(root: string, changed: string[], tracked: Set<string>): void {
  const collisions: string[] = []
  for (const path of changed) {
    const p = containedPath(root, path)
    try {
      lstatSync(p)
      if (!tracked.has(path)) collisions.push(path)
    } catch (e) { if (errorCode(e) !== "ENOENT") throw e }
  }
  if (collisions.length) throw new Blocked(collisions, "Incoming runtime files collide with untracked or ignored project files")
}
function inspect(root: string, source: string, target: string) {
  const current = head(root), currentBranch = branch(root)
  clean(root)
  if (current === target) return { current, currentBranch, changed: [] as string[], tracked: new Set<string>() }
  // Read-only preflight uses the authority's object graph. Fetch is reserved for apply.
  const ancestor = git(source, ["merge-base", "--is-ancestor", current, target])
  if (ancestor.code !== 0) throw new Blocked(["HEAD"], "Runtime HEAD is divergent or its ancestry cannot be proven at the authority")
  const changed = requireGit(source, ["diff", "--name-only", "-z", current, target]).split("\0").filter(Boolean)
  const tracked = new Set(requireGit(root, ["ls-files", "-z"]).split("\0").filter(Boolean))
  incomingCollisions(root, changed, tracked)
  const held = activeClaims(root, changed)
  if (held.length) throw new Blocked(held, "Active runtime claims overlap this update")
  return { current, currentBranch, changed, tracked }
}

export function synchronizeRuntime(request: RuntimeSyncRequest, checkpoint?: Checkpoint): RuntimeSyncResponse {
  let commit: string | null = null, initial: string | null = null
  let release: (() => void) | null = null
  const result = (status: RuntimeSyncResponse["status"], conflicts: string[] = [], error?: string): RuntimeSyncResponse =>
    ({ status, commit, conflicts, restartRequired: initial !== null && commit !== initial,
      ...(error ? { error } : {}) })
  try {
    if (!request || typeof request.apply !== "boolean" || typeof request.sourceCommit !== "string" ||
        !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(request.sourceCommit)) throw new Blocked([], "An exact source commit and boolean apply are required")
    const root = repository(request.runtimeRoot, "Runtime")
    commit = initial = head(root)
    const source = repository(request.sourceRoot, "Authority")
    const target = request.sourceCommit.toLowerCase()
    const sourceCommit = git(source, ["rev-parse", "--verify", target + "^{commit}"])
    if (sourceCommit.code !== 0) throw new Offline("The exact authoritative commit is unavailable")
    if (sourceCommit.stdout.trim() !== target) throw new Blocked([], "Source must identify the commit itself")
    if (!request.apply) {
      const state = inspect(root, source, target)
      return result(state.current === target ? "current" : "outdated")
    }
    release = acquireSyncLock(root, lockArea)
    if (!release) return result("blocked", [lockArea + "/lock"], "Another process owns the shared runtime lock")
    checkpoint?.("locked")
    const state = inspect(root, source, target)
    commit = state.current
    if (state.current === target) return result("current")
    const untracked = retained(root, state.tracked)
    const fetched = git(root, ["fetch", "--no-tags", "--no-write-fetch-head", source, target])
    if (fetched.code !== 0) throw new Offline("Exact local-authority fetch failed: " + fetched.stderr.trim())
    checkpoint?.("fetched")
    if (git(root, ["merge-base", "--is-ancestor", state.current, target]).code !== 0) throw new Blocked(["HEAD"], "Fetched target is not a fast-forward")
    checkpoint?.("ready")
    clean(root)
    if (head(root) !== state.current || branch(root) !== state.currentBranch) throw new Blocked(["HEAD"], "Runtime branch or HEAD changed during preparation")
    const held = activeClaims(root, state.changed)
    if (held.length) throw new Blocked(held, "Runtime claims changed before the update")
    incomingCollisions(root, state.changed, state.tracked)
    verifyRetained(root, untracked)
    // Git's own index/ref locks remain enabled; no hooks or safety checks are bypassed.
    const merged = git(root, ["merge", "--ff-only", target])
    commit = head(root)
    if (merged.code !== 0) throw new Blocked(["HEAD"], "Fast-forward refused: " + merged.stderr.trim())
    if (commit !== target || branch(root) !== state.currentBranch) throw new Blocked(["HEAD"], "Runtime did not finish at the exact commit on the original branch")
    verifyRetained(root, untracked)
    clean(root)
    checkpoint?.("updated")
    return result("updated")
  } catch (e) {
    if (e instanceof Offline) return result("offline", [], e.message)
    if (e instanceof Blocked) return result("blocked", e.paths, e.message)
    return result("blocked", [], e instanceof Error ? e.message : String(e))
  } finally { release?.() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result: RuntimeSyncResponse
  try { result = synchronizeRuntime(JSON.parse(readFileSync(0, "utf8"))) }
  catch (e) { result = { status: "blocked", commit: null, conflicts: [], restartRequired: false, error: e instanceof Error ? e.message : String(e) } }
  process.stdout.write(JSON.stringify(result) + "\n")
  if (result.status === "blocked" || result.status === "offline") process.exitCode = 1
}
