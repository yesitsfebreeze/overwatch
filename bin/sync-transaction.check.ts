import { afterEach, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { transact, type SyncRequest, type SyncResponse } from "./sync-transaction.ts"

const roots: string[] = []
const modulePath = fileURLToPath(new URL("./sync-transaction.ts", import.meta.url))
const receipt = ".overwatch/sync/state.json"
const journal = ".overwatch/sync/journal.json"
function root(): string { const p = mkdtempSync(join(tmpdir(), "overwatch-sync-transaction-")); roots.push(p); return p }
function put(r: string, p: string, value: string | Buffer): void { mkdirSync(dirname(join(r, p)), { recursive: true }); writeFileSync(join(r, p), value) }
function text(r: string, p: string): string | null { return existsSync(join(r, p)) ? readFileSync(join(r, p), "utf8") : null }
function request(r: string, id = "tx-1"): SyncRequest {
  return { action: "apply", root: r, transactionId: id, files: [
    { path: "workflow.md", before: "old workflow", after: "new workflow" },
    { path: "tools/basic.json", before: null, after: '{"enabled":true}' },
  ], receipt: { path: receipt, before: null, after: '{"source":"new"}' } }
}
function fixture(): string { const r = root(); put(r, "workflow.md", "old workflow"); put(r, "tools/custom.json", '{"mine":true}'); return r }
function cli(req: SyncRequest): { code: number | null; value: SyncResponse } {
  const child = spawnSync(process.execPath, [modulePath], { input: JSON.stringify(req), encoding: "utf8", timeout: 15000 })
  expect(child.error).toBeUndefined()
  return { code: child.status, value: JSON.parse(child.stdout) }
}
function crash(req: SyncRequest, stage: string, nth = 1): void {
  const script = "import {transact} from " + JSON.stringify(modulePath.replaceAll("\\", "/")) +
    ";let n=0;transact(JSON.parse(await Bun.stdin.text()),(stage)=>{if(stage===" + JSON.stringify(stage) +
    "&&++n===" + nth + ")process.exit(86)});"
  const child = spawnSync(process.execPath, ["-e", script], { input: JSON.stringify(req), encoding: "utf8", timeout: 15000 })
  expect(child.error).toBeUndefined()
  expect(child.status).toBe(86)
  expect(existsSync(join(req.root, journal))).toBe(true)
}
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })

test("applies exact files with a durable original journal and receipt last", () => {
  const r = fixture(), req = request(r), written: string[] = []
  const result = transact(req, (stage, path) => {
    if (stage === "journal") {
      const stored = JSON.parse(text(r, journal)!)
      expect(stored.files[0].before).toBe("old workflow")
      expect(text(r, "workflow.md")).toBe("old workflow")
      expect(text(r, "tools/basic.json")).toBeNull()
    }
    if (stage === "write") { expect(text(r, receipt)).toBeNull(); written.push(path!) }
    if (stage === "receipt") written.push(path!)
  })
  expect(result.status).toBe("applied")
  expect(written).toEqual(["workflow.md", "tools/basic.json", receipt])
  expect(text(r, "tools/custom.json")).toBe('{"mine":true}')
  expect(text(r, "workflow.md")).toBe("new workflow")
  expect(text(r, journal)).toBeNull()
  expect(JSON.parse(text(r, ".overwatch/sync/transactions/tx-1.json")!).phase).toBe("applied")
})

test("an identical retry leaves managed files, receipt and archive timestamps unchanged", async () => {
  const r = fixture(), req = request(r)
  expect(cli(req).value.status).toBe("applied")
  const paths = ["workflow.md", "tools/basic.json", receipt, ".overwatch/sync/transactions/tx-1.json"]
  const times = paths.map(p => statSync(join(r, p)).mtimeMs)
  await Bun.sleep(30)
  expect(cli(req)).toMatchObject({ code: 0, value: { status: "noop" } })
  expect(paths.map(p => statSync(join(r, p)).mtimeMs)).toEqual(times)
})

test("checks every precondition before writing any target", () => {
  const r = fixture(), req = request(r)
  put(r, "tools/basic.json", "concurrent custom tool")
  expect(transact(req)).toMatchObject({ status: "conflict", conflicts: ["tools/basic.json"] })
  expect(text(r, "workflow.md")).toBe("old workflow")
  expect(text(r, "tools/basic.json")).toBe("concurrent custom tool")
  expect(text(r, receipt)).toBeNull()
  expect(text(r, journal)).toBeNull()
})

test("absence does not hide unreadable/non-file or invalid UTF-8 targets", () => {
  for (const bad of ["directory", "bytes"]) {
    const r = fixture()
    if (bad === "directory") mkdirSync(join(r, "tools/basic.json"))
    else put(r, "tools/basic.json", Buffer.from([0xff, 0xfe, 0xfd]))
    expect(transact(request(r)).status).toBe("error")
    expect(text(r, "workflow.md")).toBe("old workflow")
    expect(text(r, receipt)).toBeNull()
  }
})

test("rejects path escapes, aliases, protected metadata and ancestor collisions", () => {
  for (const path of ["../escape", "/absolute", "C:/absolute", "tools\\escape", "tools/../escape", "name:stream",
    ".git/config", ".overwatch/sync/journal.json", "dir./file", "NUL.txt"]) {
    const r = fixture(), req = request(r)
    req.files = [{ path, before: null, after: "bad" }]
    expect(transact(req).status).toBe("error")
    expect(text(r, receipt)).toBeNull()
  }
  const r = fixture(), req = request(r)
  req.files = [{ path: "nested", before: null, after: "a" }, { path: "nested/file", before: null, after: "b" }]
  expect(transact(req).status).toBe("error")
  expect(text(r, "nested")).toBeNull()
})

test("rejects a directory link leaving the project and protects the outside tree", () => {
  const r = fixture(), outside = root()
  put(outside, "basic.json", "outside")
  rmSync(join(r, "tools"), { recursive: true })
  symlinkSync(outside, join(r, "tools"), process.platform === "win32" ? "junction" : "dir")
  expect(transact(request(r)).status).toBe("error")
  expect(readFileSync(join(outside, "basic.json"), "utf8")).toBe("outside")
  expect(lstatSync(join(r, "tools")).isSymbolicLink()).toBe(true)
  expect(text(r, "workflow.md")).toBe("old workflow")
})

test("does not take a live lock even if its file timestamp is ancient", () => {
  const r = fixture(), nonce = "00000000-0000-0000-0000-000000000000"
  const p = ".overwatch/sync/lock/owner-" + process.pid + "-" + nonce + ".json"
  put(r, p, JSON.stringify({ pid: process.pid, nonce }))
  utimesSync(join(r, p), new Date(0), new Date(0))
  expect(transact(request(r)).status).toBe("busy")
  expect(text(r, "workflow.md")).toBe("old workflow")
  expect(existsSync(join(r, p))).toBe(true)
})

test("two real subprocesses serialize one project and never steal a live owner", async () => {
  const r = fixture(), req = request(r)
  const script = "import {transact} from " + JSON.stringify(modulePath.replaceAll("\\", "/")) +
    ";const result=transact(JSON.parse(await Bun.stdin.text()),(stage)=>{if(stage==='locked'){console.log('LOCKED');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1800)}});console.log(JSON.stringify(result));"
  const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] })
  child.stdin.end(JSON.stringify(req))
  let output = "", errors = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", x => errors += x)
  const locked = new Promise<void>((ok, fail) => {
    child.stdout.on("data", x => { output += x; if (output.includes("LOCKED")) ok() })
    child.once("error", fail)
  })
  const exited = new Promise<number | null>((ok, fail) => { child.once("exit", ok); child.once("error", fail) })
  try {
    await locked
    expect(cli({ ...req, transactionId: "tx-other" })).toMatchObject({ code: 1, value: { status: "busy" } })
    expect(await exited).toBe(0)
    expect(errors).toBe("")
    expect(JSON.parse(output.trim().split("\n").at(-1)!).status).toBe("applied")
    expect(readdirSync(join(r, ".overwatch/sync/transactions"))).toEqual(["tx-1.json"])
  } finally { if (child.exitCode === null) child.kill() }
}, 15000)

test("recovers a process killed after its journal but before any payload write", () => {
  const r = fixture(), req = request(r)
  crash(req, "journal")
  expect(transact(req).status).toBe("recovered")
  expect(text(r, "workflow.md")).toBe("old workflow")
  expect(text(r, receipt)).toBeNull()
  expect(text(r, journal)).toBeNull()
  expect(transact(req).status).toBe("applied")
})

test("interrupted mixed state rolls back proven writes and requires a fresh apply", () => {
  const r = fixture(), req = request(r)
  crash(req, "write", 1)
  expect(text(r, "workflow.md")).toBe("new workflow")
  expect(text(r, "tools/basic.json")).toBeNull()
  expect(text(r, receipt)).toBeNull()
  expect(transact(req).status).toBe("recovered")
  expect(text(r, "workflow.md")).toBe("old workflow")
  expect(text(r, "tools/custom.json")).toBe('{"mine":true}')
  expect(transact(req).status).toBe("applied")
})

test("receipt-complete interruption finalizes without rewriting payload or receipt", async () => {
  const r = fixture(), req = request(r)
  crash(req, "receipt")
  const paths = ["workflow.md", "tools/basic.json", receipt]
  const times = paths.map(p => statSync(join(r, p)).mtimeMs)
  await Bun.sleep(30)
  expect(transact(req).status).toBe("recovered")
  expect(paths.map(p => statSync(join(r, p)).mtimeMs)).toEqual(times)
  expect(transact(req).status).toBe("noop")
})

test("recovery never overwrites an unknown concurrent edit or partially restores other files", () => {
  const r = fixture(), req = request(r)
  crash(req, "write", 2)
  put(r, "tools/basic.json", "someone else's edit")
  expect(transact(req)).toMatchObject({ status: "conflict", conflicts: ["tools/basic.json"] })
  expect(text(r, "workflow.md")).toBe("new workflow")
  expect(text(r, "tools/basic.json")).toBe("someone else's edit")
  expect(text(r, receipt)).toBeNull()
  expect(text(r, journal)).not.toBeNull()
})

test("rollback restores originals and only removes unchanged transaction-created files", () => {
  const r = fixture(), req = request(r)
  expect(transact(req).status).toBe("applied")
  const rollback: SyncRequest = { action: "rollback", root: r, transactionId: req.transactionId }
  expect(transact(rollback).status).toBe("recovered")
  expect(text(r, "workflow.md")).toBe("old workflow")
  expect(text(r, "tools/basic.json")).toBeNull()
  expect(text(r, receipt)).toBeNull()
  expect(text(r, "tools/custom.json")).toBe('{"mine":true}')
  expect(transact(rollback).status).toBe("noop")
  expect(transact(req).status).toBe("applied")
  put(r, "workflow.md", "later work")
  expect(transact(rollback)).toMatchObject({ status: "conflict", conflicts: ["workflow.md"] })
  expect(text(r, "tools/basic.json")).toBe('{"enabled":true}')
  expect(text(r, receipt)).toBe('{"source":"new"}')
})

test("reusing an ID for another payload refuses without writes", () => {
  const r = fixture(), req = request(r)
  expect(transact(req).status).toBe("applied")
  req.files![0]!.after = "different desired payload"
  expect(transact(req).status).toBe("conflict")
  expect(text(r, "workflow.md")).toBe("new workflow")
})

test("recovers an interrupted rollback without removing later unmanaged work", () => {
  const r = fixture(), req = request(r)
  expect(transact(req).status).toBe("applied")
  const rollback: SyncRequest = { action: "rollback", root: r, transactionId: req.transactionId }
  crash(rollback, "write", 1)
  put(r, "tools/added-later.json", "keep")
  expect(text(r, "tools/basic.json")).toBeNull()
  expect(text(r, "workflow.md")).toBe("new workflow")
  expect(transact(rollback).status).toBe("recovered")
  expect(text(r, "workflow.md")).toBe("old workflow")
  expect(text(r, "tools/added-later.json")).toBe("keep")
  expect(text(r, receipt)).toBeNull()
})

test("receipt-only updates work and unchanged receipt requests are no-ops", () => {
  const r = root()
  const req: SyncRequest = { action: "apply", root: r, transactionId: "receipt-only", files: [],
    receipt: { path: receipt, before: null, after: "one" } }
  expect(transact(req)).toMatchObject({ status: "applied", paths: [receipt] })
  const before = statSync(join(r, receipt)).mtimeMs
  expect(transact({ ...req, transactionId: "same-content", receipt: { path: receipt, before: "one", after: "one" } }).status).toBe("noop")
  expect(statSync(join(r, receipt)).mtimeMs).toBe(before)
})

test("invalid recovery journals remain untouched and cannot redirect writes", () => {
  const r = fixture()
  const bad = JSON.stringify({ version: 1, root: r, transactionId: "bad", phase: "apply", files: [
    { path: "../escape", before: null, after: "bad" }, { path: receipt, before: null, after: "bad" }] })
  put(r, journal, bad)
  expect(transact(request(r)).status).toBe("error")
  expect(text(r, journal)).toBe(bad)
  expect(text(r, "workflow.md")).toBe("old workflow")
  expect(text(r, receipt)).toBeNull()
})

test("claim changes between preparation and apply block every payload write", () => {
  const r = fixture(), req = request(r), claim = ".overwatch/vault/01 Specs/Work.md"
  put(r, claim, "---\nowner: ''\n---\n")
  req.guards = [{ path: claim, before: text(r, claim) }]
  put(r, claim, "---\nowner: another-agent\n---\n")
  expect(transact(req)).toMatchObject({ status: "conflict", conflicts: [claim] })
  expect(text(r, "workflow.md")).toBe("old workflow")
  expect(text(r, "tools/basic.json")).toBeNull()
  expect(text(r, receipt)).toBeNull()
  expect(text(r, journal)).toBeNull()
  expect(text(r, claim)).toContain("another-agent")
})

test("new claim files and directories invalidate inspected membership before any write", () => {
  for (const nested of [false, true]) {
    const r = fixture(), req = request(r), specs = ".overwatch/vault/01 Specs"
    put(r, specs + "/Existing.md", "existing")
    req.directories = [{ path: specs, before: ["Existing.md"] }]
    put(r, specs + (nested ? "/New/Claim.md" : "/New.md"), "new claim")
    expect(transact(req)).toMatchObject({ status: "conflict", conflicts: [specs] })
    expect(text(r, "workflow.md")).toBe("old workflow")
    expect(text(r, receipt)).toBeNull()
    expect(text(r, journal)).toBeNull()
  }
})

test("claim guards are checked again after journaling and before the first payload", () => {
  const r = fixture(), req = request(r), claim = ".overwatch/vault/01 Specs/Work.md"
  put(r, claim, "unclaimed")
  req.guards = [{ path: claim, before: "unclaimed" }]
  const result = transact(req, stage => { if (stage === "journal") put(r, claim, "new owner") })
  expect(result).toMatchObject({ status: "conflict", conflicts: [claim] })
  expect(text(r, "workflow.md")).toBe("old workflow")
  expect(text(r, "tools/basic.json")).toBeNull()
  expect(text(r, receipt)).toBeNull()
  expect(JSON.parse(text(r, journal)!)).not.toHaveProperty("guards")
})

test("a plan change during payload writes blocks subsequent writes and receipt", () => {
  for (const changeAfter of ["workflow.md", "tools/basic.json"]) {
    const r = fixture(), req = request(r), plan = ".overwatch/plan.json"
    put(r, plan, '{"owner":"first"}')
    req.guards = [{ path: plan, before: text(r, plan) }]
    const result = transact(req, (stage, path) => { if (stage === "write" && path === changeAfter) put(r, plan, '{"owner":"second"}') })
    expect(result).toMatchObject({ status: "conflict", conflicts: [plan] })
    expect(text(r, "workflow.md")).toBe("new workflow")
    expect(text(r, "tools/basic.json")).toBe(changeAfter === "workflow.md" ? null : '{"enabled":true}')
    expect(text(r, receipt)).toBeNull()
    expect(text(r, plan)).toBe('{"owner":"second"}')
    expect(transact(req).status).toBe("conflict")
    expect(text(r, "workflow.md")).toBe("new workflow")
  }
})

test("read-only guards still reject path escapes and newly appeared directories", () => {
  const r = fixture(), req = request(r)
  req.guards = [{ path: "../outside", before: null }]
  expect(transact(req).status).toBe("error")
  req.guards = []
  req.directories = [{ path: ".overwatch/vault/01 Specs", before: null }]
  put(r, ".overwatch/vault/01 Specs/Claim.md", "claim")
  expect(transact(req)).toMatchObject({ status: "conflict", conflicts: [".overwatch/vault/01 Specs"] })
  expect(text(r, "workflow.md")).toBe("old workflow")
  expect(text(r, receipt)).toBeNull()
})
