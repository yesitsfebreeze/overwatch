// Filesystem transaction boundary for project synchronization; core supplies reviewed CAS writes.
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

export type SyncFile = { path: string; before: string | null; after: string }
export type SyncGuard = { path: string; before: string | null }
export type SyncDirectoryGuard = { path: string; before: string[] | null }
export type SyncRequest = {
  action: "apply" | "rollback"; root: string; transactionId: string
  files?: SyncFile[]; receipt?: SyncFile
  guards?: SyncGuard[]; directories?: SyncDirectoryGuard[]
}
export type SyncResponse = {
  status: "applied" | "noop" | "busy" | "conflict" | "recovered" | "error"
  transactionId: string; paths: string[]; conflicts: string[]; error?: string
}
type Journal = {
  version: 1; root: string; transactionId: string
  phase: "apply" | "rollback" | "applied" | "rolled_back"; files: SyncFile[]
}
type Checkpoint = (stage: "locked" | "journal" | "write" | "receipt", path?: string) => void
const area = ".overwatch/sync"
const journalPath = area + "/journal.json"
const receiptPath = area + "/state.json"
const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

class Conflict extends Error {
  constructor(readonly paths: string[], message = "File preconditions changed") { super(message) }
}

// Never follow links, including directory junctions, through either payload or journal paths.
function at(root: string, path: string): string {
  if (!path || path.includes("\\") || path.includes(":") || path.startsWith("/") ||
      path.split("/").some(p => !p || p === "." || p === ".." || /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error("Unsafe relative path: " + path)
  const parts = path.split("/")
  let current = root
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!)
    try {
      const s = lstatSync(current)
      if (s.isSymbolicLink()) throw new Error("Symlink path refused: " + path)
      if (i < parts.length - 1 && !s.isDirectory()) throw new Error("Parent is not a directory: " + path)
    } catch (e) {
      if (code(e) === "ENOENT") break
      throw e
    }
  }
  return join(root, ...parts)
}
function directory(root: string, relative: string): void {
  let prefix = ""
  for (const part of relative.split("/")) {
    prefix += (prefix ? "/" : "") + part
    const p = at(root, prefix)
    try { mkdirSync(p) } catch (e) { if (code(e) !== "EEXIST") throw e }
    if (!lstatSync(p).isDirectory() || lstatSync(p).isSymbolicLink()) throw new Error("Unsafe directory: " + prefix)
  }
}
function read(root: string, path: string): string | null {
  const p = at(root, path)
  try {
    const stat = lstatSync(p)
    if (!stat.isFile()) throw new Error("Not a regular file: " + path)
    const bytes = readFileSync(p)
    const text = bytes.toString("utf8")
    if (!bytes.equals(Buffer.from(text, "utf8"))) throw new Error("Non-UTF-8 file refused: " + path)
    return text
  } catch (e) {
    if (code(e) === "ENOENT") return null
    throw e
  }
}
function write(root: string, path: string, before: string | null, after: string): void {
  if (read(root, path) !== before) throw new Conflict([path])
  if (before === after) return
  const slash = path.lastIndexOf("/")
  if (slash >= 0) directory(root, path.slice(0, slash))
  const target = at(root, path)
  const temp = join(dirname(target), ".overwatch-sync-" + process.pid + "-" + randomUUID() + ".tmp")
  let fd: number | undefined
  try {
    fd = openSync(temp, "wx", before === null ? (path.startsWith(area + "/") ? 0o600 : 0o666) : lstatSync(target).mode & 0o777)
    writeFileSync(fd, after, "utf8")
    fsyncSync(fd)
    closeSync(fd); fd = undefined
    if (read(root, path) !== before) throw new Conflict([path])
    at(root, path)
    renameSync(temp, target)
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temp) } catch (e) { if (code(e) !== "ENOENT") throw e }
  }
}
function remove(root: string, path: string, expected: string): void {
  if (read(root, path) !== expected) throw new Conflict([path])
  unlinkSync(at(root, path))
}
function live(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return code(e) !== "ESRCH" }
}
export function acquireSyncLock(root: string, namespace = area): (() => void) | null {
  directory(root, namespace)
  const lockRel = namespace + "/lock"
  const lockPath = at(root, lockRel)
  const nonce = randomUUID()
  const owner = "owner-" + process.pid + "-" + nonce + ".json"
  const ownerText = JSON.stringify({ pid: process.pid, nonce })
  const candidate = namespace + "/lock-candidate-" + process.pid + "-" + nonce
  directory(root, candidate)
  write(root, candidate + "/" + owner, null, ownerText)
  let held = false
  try {
    for (let tries = 0; tries < 4; tries++) {
      try { at(root, lockRel); renameSync(at(root, candidate), lockPath); held = true; break }
      catch (e) { if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(code(e) ?? "")) throw e }
      let names: string[]
      try { names = readdirSync(at(root, lockRel)) } catch (e) { if (code(e) === "ENOENT") continue; throw e }
      if (names.length !== 1 || !/^owner-[1-9]\d*-[0-9a-f-]+\.json$/.test(names[0]!)) return null
      const oldName = names[0]!
      const oldPath = lockRel + "/" + oldName
      const oldText = read(root, oldPath)
      let old: unknown
      try { old = JSON.parse(oldText ?? "") } catch { return null }
      if (!record(old) || !Number.isSafeInteger(old.pid) || Number(old.pid) <= 0 ||
          typeof old.nonce !== "string" || oldName !== "owner-" + old.pid + "-" + old.nonce + ".json" ||
          live(Number(old.pid))) return null
      // Remove only this dead owner's unique file. A replacement live owner has a different name.
      if (read(root, oldPath) !== oldText || live(Number(old.pid))) return null
      try { remove(root, oldPath, oldText!) } catch (e) { if (code(e) !== "ENOENT" && !(e instanceof Conflict)) throw e }
      try { rmdirSync(at(root, lockRel)) } catch (e) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(code(e) ?? "")) throw e }
    }
    if (!held) return null
    return () => {
      const p = lockRel + "/" + owner
      if (read(root, p) === ownerText) remove(root, p, ownerText)
      try { rmdirSync(at(root, lockRel)) } catch (e) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(code(e) ?? "")) throw e }
    }
  } finally {
    if (!held) {
      const p = candidate + "/" + owner
      if (read(root, p) === ownerText) remove(root, p, ownerText)
      try { rmdirSync(at(root, candidate)) } catch (e) { if (code(e) !== "ENOENT") throw e }
    }
  }
}
function file(value: unknown): SyncFile {
  if (!record(value) || typeof value.path !== "string" || !(value.before === null || typeof value.before === "string") ||
      typeof value.after !== "string") throw new Error("Invalid transaction file")
  return { path: value.path, before: value.before, after: value.after }
}
function guard(value: unknown): SyncGuard {
  if (!record(value) || typeof value.path !== "string" || !(value.before === null || typeof value.before === "string")) {
    throw new Error("Invalid read-only file guard")
  }
  return { path: value.path, before: value.before }
}
function directoryGuard(value: unknown): SyncDirectoryGuard {
  if (!record(value) || typeof value.path !== "string" || !(value.before === null ||
      (Array.isArray(value.before) && value.before.every(n => typeof n === "string" && !!n && !/[\\/]/.test(n) && n !== "." && n !== "..")))) {
    throw new Error("Invalid read-only directory guard")
  }
  return { path: value.path, before: value.before === null ? null : [...value.before as string[]].sort() }
}
function entries(root: string, path: string): string[] | null {
  const p = at(root, path)
  try {
    if (!lstatSync(p).isDirectory()) throw new Error("Guard target is not a directory: " + path)
    return readdirSync(p).sort()
  } catch (e) { if (code(e) === "ENOENT") return null; throw e }
}
function checkGuards(root: string, guards: SyncGuard[], directories: SyncDirectoryGuard[]): void {
  const changed = guards.filter(g => read(root, g.path) !== g.before).map(g => g.path)
  for (const g of directories) if (JSON.stringify(entries(root, g.path)) !== JSON.stringify(g.before)) changed.push(g.path)
  if (changed.length) throw new Conflict([...new Set(changed)], "Read-only planning or ownership preconditions changed")
}
function validateFiles(root: string, files: SyncFile[]): void {
  const seen = new Set<string>()
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!
    at(root, f.path)
    const key = process.platform === "win32" ? f.path.toLowerCase() : f.path
    if ([...seen].some(p => p === key || p.startsWith(key + "/") || key.startsWith(p + "/")) || key === ".git" || key.startsWith(".git/")) throw new Error("Duplicate or protected path: " + f.path)
    if ((key === area || key.startsWith(area + "/")) && (i !== files.length - 1 || f.path !== receiptPath)) {
      throw new Error("Transaction metadata path refused: " + f.path)
    }
    seen.add(key)
  }
  if (files.at(-1)?.path !== receiptPath) throw new Error("Receipt must be last at " + receiptPath)
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value)) throw new Error("Invalid transactionId")
  return value
}
function journal(root: string, text: string): Journal {
  const value: unknown = JSON.parse(text)
  if (!record(value) || value.version !== 1 || value.root !== root || !Array.isArray(value.files) ||
      !["apply", "rollback", "applied", "rolled_back"].includes(String(value.phase))) throw new Error("Invalid transaction journal")
  const j: Journal = { version: 1, root, transactionId: identity(value.transactionId), phase: value.phase as Journal["phase"], files: value.files.map(file) }
  validateFiles(root, j.files)
  return j
}
const archivePath = (id: string) => area + "/transactions/" + id + ".json"
const payload = (j: Journal) => JSON.stringify(j.files)
function finish(root: string, j: Journal, active: string, phase: "applied" | "rolled_back"): void {
  const path = archivePath(j.transactionId)
  const before = read(root, path)
  if (before !== null && payload(journal(root, before)) !== payload(j)) throw new Conflict([path], "Transaction ID already has another payload")
  write(root, path, before, JSON.stringify({ ...j, phase }))
  remove(root, journalPath, active)
}
function states(root: string, files: SyncFile[]): Array<string | null> { return files.map(f => read(root, f.path)) }
function conflicts(files: SyncFile[], actual: Array<string | null>): string[] {
  return files.filter((f, i) => actual[i] !== f.before && actual[i] !== f.after).map(f => f.path)
}
function restore(root: string, j: Journal, actual: Array<string | null>, checkpoint?: Checkpoint, verify?: () => void): void {
  const changed = conflicts(j.files, actual)
  if (changed.length) throw new Conflict(changed, "Recovery preserves files changed outside this transaction")
  for (let i = j.files.length - 1; i >= 0; i--) {
    const f = j.files[i]!
    if (actual[i] === f.before) continue
    verify?.()
    if (f.before === null) remove(root, f.path, f.after)
    else write(root, f.path, f.after, f.before)
    checkpoint?.(f.path === receiptPath ? "receipt" : "write", f.path)
  }
}

export { at as containedPath }

export function transact(request: SyncRequest, checkpoint?: Checkpoint): SyncResponse {
  let id = typeof request?.transactionId === "string" ? request.transactionId : ""
  let release: (() => void) | null = null
  const response = (status: SyncResponse["status"], paths: string[] = [], changed: string[] = [], error?: string): SyncResponse =>
    ({ status, transactionId: id, paths, conflicts: changed, ...(error ? { error } : {}) })
  try {
    id = identity(request?.transactionId)
    if (!request || !["apply", "rollback"].includes(request.action) || typeof request.root !== "string" || !isAbsolute(request.root)) {
      throw new Error("Expected apply/rollback with an absolute project root")
    }
    const resolved = resolve(request.root)
    const rootStat = lstatSync(resolved)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Project root must be a real directory")
    const root = realpathSync(resolved)
    const files = request.action === "apply" ? [...(Array.isArray(request.files) ? request.files.map(file) : (() => { throw new Error("Missing transaction files") })()), file(request.receipt)] : []
    if (request.action === "apply") validateFiles(root, files)
    if (request.guards !== undefined && !Array.isArray(request.guards)) throw new Error("Invalid read-only guards")
    if (request.directories !== undefined && !Array.isArray(request.directories)) throw new Error("Invalid directory guards")
    const guards = (request.guards ?? []).map(guard)
    const directories = (request.directories ?? []).map(directoryGuard)
    for (const g of [...guards, ...directories]) at(root, g.path)
    const verify = () => checkGuards(root, guards, directories)
    release = acquireSyncLock(root)
    if (!release) return response("busy", [], [], "Another process owns the project transaction lock")
    checkpoint?.("locked")
    verify()
    const pending = read(root, journalPath)
    if (pending !== null) {
      const j = journal(root, pending)
      if (j.phase !== "apply" && j.phase !== "rollback") throw new Error("Active journal has an invalid phase")
      const actual = states(root, j.files)
      const changed = conflicts(j.files, actual)
      if (changed.length) throw new Conflict(changed, "Recovery preserves files changed outside this transaction")
      const complete = j.phase === "apply" && j.files.every((f, i) => actual[i] === f.after)
      if (!complete) restore(root, j, actual, checkpoint, verify)
      finish(root, j, pending, complete ? "applied" : "rolled_back")
      id = j.transactionId
      return response("recovered", j.files.map(f => f.path))
    }
    const archivedText = read(root, archivePath(id))
    const archived = archivedText === null ? null : journal(root, archivedText)
    if (request.action === "rollback") {
      if (!archived) throw new Error("No completed journal for transaction " + id)
      const actual = states(root, archived.files)
      const changed = conflicts(archived.files, actual)
      if (changed.length) throw new Conflict(changed, "Rollback preserves later edits")
      if (archived.files.every((f, i) => actual[i] === f.before)) return response("noop")
      const j: Journal = { ...archived, phase: "rollback" }
      const text = JSON.stringify(j)
      write(root, journalPath, null, text)
      checkpoint?.("journal")
      restore(root, j, actual, checkpoint, verify)
      finish(root, j, text, "rolled_back")
      return response("recovered", j.files.map(f => f.path))
    }
    const j: Journal = { version: 1, root, transactionId: id, phase: "apply", files }
    if (archived && payload(archived) !== payload(j)) throw new Conflict([archivePath(id)], "Transaction ID already has another payload")
    const actual = states(root, files)
    if (archived?.phase === "applied" && files.every((f, i) => actual[i] === f.after)) return response("noop")
    const changed = files.filter((f, i) => actual[i] !== f.before).map(f => f.path)
    if (changed.length) throw new Conflict(changed)
    const paths = files.filter(f => f.before !== f.after).map(f => f.path)
    if (!paths.length) return response("noop")
    const text = JSON.stringify(j)
    verify()
    write(root, journalPath, null, text)
    checkpoint?.("journal")
    for (const f of files) {
      if (f.before === f.after) continue
      verify()
      write(root, f.path, f.before, f.after)
      checkpoint?.(f.path === receiptPath ? "receipt" : "write", f.path)
    }
    finish(root, j, text, "applied")
    return response("applied", paths)
  } catch (e) {
    if (e instanceof Conflict) return response("conflict", [], e.paths, e.message)
    return response("error", [], [], e instanceof Error ? e.message : String(e))
  } finally {
    release?.()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result: SyncResponse
  try { result = transact(JSON.parse(readFileSync(0, "utf8"))) }
  catch (e) { result = { status: "error", transactionId: "", paths: [], conflicts: [], error: e instanceof Error ? e.message : String(e) } }
  process.stdout.write(JSON.stringify(result) + "\n")
  if (!["applied", "noop", "recovered"].includes(result.status)) process.exitCode = 1
}
