import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { synchronizeRuntime, type RuntimeSyncRequest, type RuntimeSyncResponse } from "./sync-runtime.ts"

const roots: string[] = []
const modulePath = fileURLToPath(new URL("./sync-runtime.ts", import.meta.url))
function git(root: string, args: string[]): string {
  const p = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 15000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } })
  if (p.status !== 0) throw new Error("git " + args.join(" ") + ": " + p.stderr + (p.error?.message ?? ""))
  return p.stdout.trim()
}
function put(root: string, path: string, text: string): void {
  const full = join(root, path)
  mkdirSync(join(full, ".."), { recursive: true })
  writeFileSync(full, text)
}
function configure(root: string): void {
  git(root, ["config", "user.name", "Overwatch synchronization test"])
  git(root, ["config", "user.email", "overwatch-sync-test@example.invalid"])
  git(root, ["config", "core.autocrlf", "false"])
}
function fixture(): { request: RuntimeSyncRequest; old: string; base: string } {
  const base = mkdtempSync(join(tmpdir(), "overwatch-sync-runtime-"))
  roots.push(base)
  const sourceRoot = join(base, "authority"), runtimeRoot = join(base, "runtime")
  mkdirSync(sourceRoot)
  git(sourceRoot, ["init", "-b", "main"])
  configure(sourceRoot)
  put(sourceRoot, ".gitignore", ".overwatch/\nbun.lock\n")
  put(sourceRoot, "core.txt", "old\n")
  git(sourceRoot, ["add", "."])
  git(sourceRoot, ["commit", "-m", "Create old runtime"])
  const old = git(sourceRoot, ["rev-parse", "HEAD"])
  git(base, ["clone", "--no-hardlinks", sourceRoot, runtimeRoot])
  configure(runtimeRoot)
  put(sourceRoot, "core.txt", "new\n")
  put(sourceRoot, "helper.ts", "export const value = 1\n")
  git(sourceRoot, ["add", "."])
  git(sourceRoot, ["commit", "-m", "Advance runtime"])
  return { request: { sourceRoot, runtimeRoot, sourceCommit: git(sourceRoot, ["rev-parse", "HEAD"]), apply: true }, old, base }
}
function cli(request: RuntimeSyncRequest): { code: number | null; value: RuntimeSyncResponse } {
  const p = spawnSync(process.execPath, [modulePath], { input: JSON.stringify(request), encoding: "utf8", timeout: 30000 })
  expect(p.error).toBeUndefined()
  return { code: p.status, value: JSON.parse(p.stdout) }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }) })

test("read-only preflight reports outdated without fetching, locking or updating checkout files", () => {
  const { request, old } = fixture(), root = request.runtimeRoot
  const index = statSync(join(root, ".git/index")).mtimeMs
  expect(synchronizeRuntime({ ...request, apply: false })).toMatchObject({ status: "outdated", commit: old, restartRequired: false })
  expect(git(root, ["rev-parse", "HEAD"])).toBe(old)
  expect(readFileSync(join(root, "core.txt"), "utf8")).toBe("old\n")
  expect(existsSync(join(root, ".overwatch/runtime-sync"))).toBe(false)
  expect(existsSync(join(root, ".git/FETCH_HEAD"))).toBe(false)
  expect(statSync(join(root, ".git/index")).mtimeMs).toBe(index)
})

test("fast-forwards to the exact authority commit and preserves ignored bun.lock and custom files", () => {
  const { request } = fixture(), root = request.runtimeRoot
  put(root, "bun.lock", "local ignored lock\n")
  put(root, "custom-tool.json", '{"mine":true}\n')
  const originalBranch = git(root, ["symbolic-ref", "HEAD"])
  const lockMtime = statSync(join(root, "bun.lock")).mtimeMs
  expect(cli(request)).toMatchObject({ code: 0, value: { status: "updated", commit: request.sourceCommit, restartRequired: true } })
  expect(git(root, ["rev-parse", "HEAD"])).toBe(request.sourceCommit)
  expect(git(root, ["symbolic-ref", "HEAD"])).toBe(originalBranch)
  expect(readFileSync(join(root, "core.txt"), "utf8")).toBe("new\n")
  expect(readFileSync(join(root, "custom-tool.json"), "utf8")).toBe('{"mine":true}\n')
  expect(readFileSync(join(root, "bun.lock"), "utf8")).toBe("local ignored lock\n")
  expect(statSync(join(root, "bun.lock")).mtimeMs).toBe(lockMtime)
  expect(existsSync(join(root, ".git/FETCH_HEAD"))).toBe(false)
  const paths = ["core.txt", "helper.ts", ".git/index", ".git/HEAD"]
  const times = paths.map(p => statSync(join(root, p)).mtimeMs)
  expect(cli(request)).toMatchObject({ code: 0, value: { status: "current", restartRequired: false } })
  expect(paths.map(p => statSync(join(root, p)).mtimeMs)).toEqual(times)
})

test("dirty tracked files and staged changes block the update without discarding either", () => {
  for (const staged of [false, true]) {
    const { request, old } = fixture(), root = request.runtimeRoot
    put(root, "core.txt", staged ? "staged work\n" : "dirty work\n")
    if (staged) git(root, ["add", "core.txt"])
    expect(synchronizeRuntime(request).status).toBe("blocked")
    expect(git(root, ["rev-parse", "HEAD"])).toBe(old)
    expect(readFileSync(join(root, "core.txt"), "utf8")).toBe(staged ? "staged work\n" : "dirty work\n")
    expect(git(root, ["show", ":core.txt"])).toBe(staged ? "staged work" : "old")
  }
})

test("divergent runtime history is refused without a merge, reset or branch change", () => {
  const { request } = fixture(), root = request.runtimeRoot
  put(root, "local.txt", "runtime-only work")
  git(root, ["add", "local.txt"])
  git(root, ["commit", "-m", "Preserve local runtime work"])
  const before = git(root, ["rev-parse", "HEAD"]), currentBranch = git(root, ["symbolic-ref", "HEAD"])
  expect(synchronizeRuntime(request)).toMatchObject({ status: "blocked", conflicts: ["HEAD"] })
  expect(git(root, ["rev-parse", "HEAD"])).toBe(before)
  expect(git(root, ["symbolic-ref", "HEAD"])).toBe(currentBranch)
  expect(readFileSync(join(root, "local.txt"), "utf8")).toBe("runtime-only work")
})

test("offline authority and absent commit leave the runtime unchanged", () => {
  const { request, old, base } = fixture()
  expect(synchronizeRuntime({ ...request, sourceRoot: join(base, "missing") })).toMatchObject({ status: "offline", commit: old })
  expect(synchronizeRuntime({ ...request, sourceCommit: "0".repeat(40) })).toMatchObject({ status: "offline", commit: old })
  expect(git(request.runtimeRoot, ["rev-parse", "HEAD"])).toBe(old)
})

test("incoming files cannot overwrite untracked files or ignored bun.lock", () => {
  for (const ignored of [false, true]) {
    const { request, old } = fixture(), root = request.runtimeRoot
    const path = ignored ? "bun.lock" : "helper.ts"
    if (ignored) {
      put(request.sourceRoot, path, "authority lock")
      git(request.sourceRoot, ["add", "-f", path])
      git(request.sourceRoot, ["commit", "-m", "Track runtime lock"])
      request.sourceCommit = git(request.sourceRoot, ["rev-parse", "HEAD"])
    }
    put(root, path, "custom contents")
    expect(synchronizeRuntime(request)).toMatchObject({ status: "blocked", conflicts: [path] })
    expect(git(root, ["rev-parse", "HEAD"])).toBe(old)
    expect(readFileSync(join(root, path), "utf8")).toBe("custom contents")
  }
})

test("active overlapping and unknown-scope claims block; completed and unrelated claims permit update", () => {
  for (const kind of ["active", "unknown", "completed", "unrelated"]) {
    const { request, old } = fixture(), root = request.runtimeRoot
    const status = kind === "completed" ? "implemented" : "specced"
    const paths = kind === "unknown" ? "" : "paths: [" + (kind === "unrelated" ? "unrelated.txt" : "core.txt") + "]\n"
    put(root, ".overwatch/vault/01 Specs/Claim.md", "---\nowner: other-agent\nstatus: " + status + "\n" + paths + "---\n")
    const result = synchronizeRuntime(request)
    expect(result.status).toBe(kind === "active" || kind === "unknown" ? "blocked" : "updated")
    expect(git(root, ["rev-parse", "HEAD"])).toBe(kind === "active" || kind === "unknown" ? old : request.sourceCommit)
  }
}, 30000)

test("claims or tracked edits arriving after preflight prevent the fast-forward", () => {
  for (const claim of [false, true]) {
    const { request, old } = fixture(), root = request.runtimeRoot
    const result = synchronizeRuntime(request, stage => {
      if (stage !== "ready") return
      if (claim) put(root, ".overwatch/vault/01 Specs/Late.md", "---\nowner: late-worker\nstatus: specced\npaths: [core.txt]\n---\n")
      else put(root, "core.txt", "late work")
    })
    expect(result.status).toBe("blocked")
    expect(git(root, ["rev-parse", "HEAD"])).toBe(old)
    expect(readFileSync(join(root, "core.txt"), "utf8")).toBe(claim ? "old\n" : "late work")
  }
})

test("a live shared-runtime owner excludes a second real subprocess", async () => {
  const { request } = fixture()
  const script = "import {synchronizeRuntime} from " + JSON.stringify(modulePath.replaceAll("\\", "/")) +
    ";const result=synchronizeRuntime(JSON.parse(await Bun.stdin.text()),stage=>{if(stage==='locked'){console.log('LOCKED');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2200)}});console.log(JSON.stringify(result));"
  const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] })
  child.stdin.end(JSON.stringify(request))
  let output = "", errors = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", x => errors += x)
  const locked = new Promise<void>((ok, fail) => {
    child.stdout.on("data", x => { output += x; if (output.includes("LOCKED")) ok() })
    child.once("error", fail)
  })
  const ended = new Promise<number | null>((ok, fail) => { child.once("exit", ok); child.once("error", fail) })
  try {
    await locked
    expect(cli(request)).toMatchObject({ code: 1, value: { status: "blocked", conflicts: [".overwatch/runtime-sync/lock"] } })
    expect(await ended).toBe(0)
    expect(errors).toBe("")
    expect(JSON.parse(output.trim().split("\n").at(-1)!).status).toBe("updated")
    expect(git(request.runtimeRoot, ["rev-parse", "HEAD"])).toBe(request.sourceCommit)
  } finally { if (child.exitCode === null) child.kill() }
}, 30000)

test("same-root current runtime requires no fetch or restart and rejects invalid inputs", () => {
  const { request } = fixture()
  expect(synchronizeRuntime({ ...request, runtimeRoot: request.sourceRoot, apply: false })).toMatchObject({ status: "current", commit: request.sourceCommit, restartRequired: false })
  expect(synchronizeRuntime({ ...request, sourceCommit: "main" }).status).toBe("blocked")
  expect(synchronizeRuntime({ ...request, runtimeRoot: join(request.runtimeRoot, "subdirectory") }).status).toBe("offline")
})

test("an ignored incoming file created after preflight is preserved before fast-forward", () => {
  const { request, old } = fixture(), root = request.runtimeRoot
  put(request.sourceRoot, "bun.lock", "authority lock")
  git(request.sourceRoot, ["add", "-f", "bun.lock"])
  git(request.sourceRoot, ["commit", "-m", "Add authoritative lock"])
  request.sourceCommit = git(request.sourceRoot, ["rev-parse", "HEAD"])
  const result = synchronizeRuntime(request, stage => { if (stage === "ready") put(root, "bun.lock", "late ignored work") })
  expect(result).toMatchObject({ status: "blocked", conflicts: ["bun.lock"] })
  expect(git(root, ["rev-parse", "HEAD"])).toBe(old)
  expect(readFileSync(join(root, "bun.lock"), "utf8")).toBe("late ignored work")
})
