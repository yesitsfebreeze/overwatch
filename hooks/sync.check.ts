import { afterEach, expect, test } from "bun:test"
import { cpSync, symlinkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, statSync, existsSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { spawnSync } from "node:child_process"
import { fromNode } from "../bin/node-io.ts"
import { captureSyncRuntime, syncAutomatic, syncCheck, syncConfigure, syncMigrate, syncNotice, syncVerify } from "./sync.ts"

const made: string[] = []
afterEach(() => { for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true }) })
function write(root: string, path: string, text: string) {
  const p = join(root, path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text)
}
function git(root: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 15000 })
  if (r.status !== 0) throw new Error(args.join(" ") + ": " + r.stderr)
  return r.stdout.trim()
}
function commit(root: string, message = "fixture") { git(root, "add", "."); git(root, "commit", "-m", message); return git(root, "rev-parse", "HEAD") }
function repository(root: string) {
  mkdirSync(root, { recursive: true })
  git(root, "init", "-b", "main")
  git(root, "config", "user.name", "Sync test")
  git(root, "config", "user.email", "sync-test@example.invalid")
  git(root, "config", "core.autocrlf", "false")
}
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "overwatch-sync-core-")); made.push(base)
  const source = join(base, "source"), project = join(base, "project"), home = join(base, "home")
  repository(source); repository(project); mkdirSync(home)
  write(source, "bin/cli.ts", "export {}\n")
  write(source, "data/shared/base.txt", "official one\n")
  write(source, "data/shared/OVERWATCH.md", "Shared workflow\n")
  write(source, "data/vault/00 Meta/Plan.md", "Default plan\n")
  write(source, "data/vault/.obsidian/community-plugins.json", '["plan-view"]\n')
  const manifest: any = { format: 1, vaultSchemaVersion: 1, workflowVersion: 1,
    capabilities: ["sync_check", "sync_migrate", "sync_verify"], runtimePaths: ["bin"],
    migrations: [{ version: 1, id: "one", files: [
      { source: "data/shared/base.txt", path: ".overwatch/shared/base.txt", mode: "shared" },
      { source: "data/shared/OVERWATCH.md", path: ".overwatch/shared/OVERWATCH.md", mode: "shared" },
      { source: "data/vault/00 Meta/Plan.md", path: ".overwatch/vault/00 Meta/Plan.md", mode: "seed" },
      { source: "data/vault/.obsidian/community-plugins.json", path: ".overwatch/vault/.obsidian/community-plugins.json", mode: "merge-array" },
    ] }] }
  write(source, "data/sync-manifest.json", JSON.stringify(manifest))
  const first = commit(source)
  const runtimeRoot = join(base, "runtime")
  git(base, "clone", "--quiet", source, runtimeRoot)
  write(project, ".gitignore", ".overwatch/sync/\n")
  write(project, "README.md", "project\n")
  commit(project)
  const normal = fromNode(project)
  const io = { ...normal, env: async (n: any) => n === "HOME" ? home : normal.env(n) }
  const options = { sourceRoot: source, sourceRef: "HEAD", runtimeRoot }
  return { base, source, runtimeRoot, project, home, manifest, io, options, first }
}
const at = (f: ReturnType<typeof fixture>, p: string) => readFileSync(join(f.project, p), "utf8")

test("fresh install uses committed source, records versions, and repeated sync does not write", async () => {
  const f = fixture()
  const check = await syncCheck(f.io, f.options)
  expect(check.status).toBe("uninitialized")
  expect(existsSync(join(f.project, ".mcp.json"))).toBe(false)
  const migrated = await syncMigrate(f.io, f.options)
  expect(migrated.status).toBe("applied")
  expect(migrated.installedCommit).toBe(f.first)
  expect(migrated.migrationVersion).toBe(1)
  expect(migrated.vaultSchemaVersion).toBe(1)
  expect(at(f, ".overwatch/shared/base.txt")).toBe("official one\n")
  const state = at(f, ".overwatch/sync/state.json")
  const mtime = statSync(join(f.project, ".overwatch/sync/state.json")).mtimeMs
  const again = await syncAutomatic(f.io, f.options)
  expect(again.status).toBe("current")
  expect(at(f, ".overwatch/sync/state.json")).toBe(state)
  expect(statSync(join(f.project, ".overwatch/sync/state.json")).mtimeMs).toBe(mtime)
  expect((await syncVerify(f.io, f.options)).verification.ok).toBe(true)
}, 60000)

test("machine authority config is shared by fresh projects and explicit project source remains stable", async () => {
  const f = fixture()
  const configured = await syncConfigure(f.io, f.options)
  expect(configured.status).toBe("applied")
  const authority = readFileSync(join(f.home, ".overwatch/source.json"), "utf8")
  expect(JSON.parse(authority).sourceRoot.replaceAll("\\", "/")).toBe(f.source.replaceAll("\\", "/"))
  expect((await syncAutomatic(f.io)).status).toBe("applied")
  expect(readFileSync(join(f.home, ".overwatch/source.json"), "utf8")).toBe(authority)
  expect((await syncConfigure(f.io, f.options)).status).toBe("current")
  write(f.home, ".overwatch/source.json", JSON.stringify({ sourceRoot: join(f.base, "offline"), runtimeRoot: f.source }))
  expect((await syncCheck(f.io)).status).toBe("current")
}, 60000)

test("skipped incremental migrations and same-version content upgrades converge", async () => {
  const f = fixture()
  expect((await syncMigrate(f.io, f.options)).status).toBe("applied")
  commit(f.project, "record installation")
  write(f.source, "data/shared/two.txt", "second\n")
  f.manifest.migrations.push({ version: 2, id: "two", files: [{ source: "data/shared/two.txt", path: ".overwatch/shared/two.txt", mode: "shared" }] })
  write(f.source, "data/sync-manifest.json", JSON.stringify(f.manifest)); commit(f.source, "second version")
  write(f.source, "data/shared/base.txt", "official three\n")
  f.manifest.migrations.push({ version: 3, id: "three", files: [{ source: "data/shared/base.txt", path: ".overwatch/shared/base.txt", mode: "shared" }] })
  write(f.source, "data/sync-manifest.json", JSON.stringify(f.manifest)); const third = commit(f.source, "third version")
  const upgraded = await syncMigrate(f.io, f.options)
  expect(upgraded.status).toBe("applied")
  expect(upgraded.migrationVersion).toBe(3)
  expect(upgraded.installedCommit).toBe(third)
  expect(at(f, ".overwatch/shared/two.txt")).toBe("second\n")
  expect(at(f, ".overwatch/shared/base.txt")).toBe("official three\n")
  commit(f.project, "record upgrade")
  write(f.source, "data/shared/base.txt", "content correction\n"); const correction = commit(f.source, "same version correction")
  const corrected = await syncMigrate(f.io, f.options)
  expect(corrected.status).toBe("applied")
  expect(corrected.migrationVersion).toBe(3)
  expect(corrected.installedCommit).toBe(correction)
  expect(at(f, ".overwatch/shared/base.txt")).toBe("content correction\n")
}, 60000)

test("custom MCP keys, vault notes, plugin entries, workflow and live plan bytes survive", async () => {
  const f = fixture()
  const custom = { mcpServers: { project: { command: "node", args: ["project.mjs"], env: { PROJECT_MODE: "custom" } } }, preference: 3 }
  const plan = '{ "plan": {"tasks":[{"id":8,"status":"active"}],"guards":[{"id":"keep","met":false}]} }\n'
  write(f.project, ".mcp.json", JSON.stringify(custom))
  write(f.project, ".overwatch/plan.json", plan)
  write(f.project, ".overwatch/vault/00 Meta/Plan.md", "My customized vault workflow\n")
  write(f.project, ".overwatch/vault/.obsidian/community-plugins.json", '["custom-plugin", "plan-view"]\n')
  write(f.project, ".overwatch/vault/01 Specs/Ongoing.md", "---\nstatus: target\nowner: peer\npaths: [packages/]\n---\nUser work\n")
  write(f.project, "SYSTEM.md", "Project-specific binding rules\n")
  commit(f.project)
  const result = await syncMigrate(f.io, f.options)
  expect(result.status).toBe("applied")
  const config = JSON.parse(at(f, ".mcp.json"))
  expect(config.mcpServers.project).toEqual(custom.mcpServers.project)
  expect(config.preference).toBe(3)
  expect(at(f, ".overwatch/plan.json")).toBe(plan)
  expect(at(f, ".overwatch/vault/00 Meta/Plan.md")).toBe("My customized vault workflow\n")
  expect(at(f, ".overwatch/vault/.obsidian/community-plugins.json")).toBe('["custom-plugin", "plan-view"]\n')
  expect(at(f, "SYSTEM.md")).toBe("Project-specific binding rules\n")
  expect(result.extensions.mcpTools).toContain("project")
  expect(result.extensions.workflowPaths).toContain("SYSTEM.md")
}, 60000)

test("stale open claims protect prefix scopes, completed historical owners do not", async () => {
  const f = fixture()
  const p = ".overwatch/vault/01 Specs/Peer.MD"
  write(f.project, p, "---\nstatus: target\nowner: peer\nsince: 2020-01-01T00:00:00Z\npaths: [.overwatch/shared/]\n---\n")
  commit(f.project)
  const blocked = await syncMigrate(f.io, f.options)
  expect(blocked.status).toBe("blocked")
  expect(blocked.conflicts.some(x => x.includes("claimed by peer"))).toBe(true)
  expect(existsSync(join(f.project, ".overwatch/sync/state.json"))).toBe(false)
  write(f.project, p, at(f, p).replace("status: target", "status: implemented")); commit(f.project, "complete peer unit")
  expect((await syncMigrate(f.io, f.options)).status).toBe("applied")
}, 60000)

test("open owner with unknown scope blocks automatic writes", async () => {
  const f = fixture()
  write(f.project, ".overwatch/vault/01 Specs/Unknown.md", "---\nstatus: target\nowner: peer\n---\n")
  commit(f.project)
  expect((await syncMigrate(f.io, f.options)).status).toBe("blocked")
  expect(existsSync(join(f.project, ".mcp.json"))).toBe(false)
}, 60000)

test("custom shared file and custom overwatch server never get replaced", async () => {
  const f = fixture()
  write(f.project, ".overwatch/shared/base.txt", "my implementation\n")
  write(f.project, ".mcp.json", JSON.stringify({ mcpServers: { overwatch: { command: "custom-core", args: ["serve"] } } }))
  commit(f.project)
  const r = await syncMigrate(f.io, f.options)
  expect(r.status).toBe("blocked")
  expect(at(f, ".overwatch/shared/base.txt")).toBe("my implementation\n")
  expect(JSON.parse(at(f, ".mcp.json")).mcpServers.overwatch.command).toBe("custom-core")
  expect(existsSync(join(f.project, ".overwatch/sync/state.json"))).toBe(false)
}, 60000)

test("dirty shared targets and intentional tracked deletions are preserved", async () => {
  const f = fixture()
  expect((await syncMigrate(f.io, f.options)).status).toBe("applied")
  commit(f.project)
  write(f.project, ".overwatch/shared/base.txt", "uncommitted work\n")
  write(f.source, "data/shared/base.txt", "upstream update\n"); commit(f.source, "upgrade")
  expect((await syncMigrate(f.io, f.options)).status).toBe("blocked")
  expect(at(f, ".overwatch/shared/base.txt")).toBe("uncommitted work\n")
  git(f.project, "restore", ".overwatch/shared/base.txt")
  unlinkSync(join(f.project, ".overwatch/shared/base.txt"))
  const deleted = await syncMigrate(f.io, f.options)
  expect(deleted.status).toBe("blocked")
  expect(deleted.conflicts.some(x => x.includes("working-tree changes"))).toBe(true)
  expect(existsSync(join(f.project, ".overwatch/shared/base.txt"))).toBe(false)
}, 60000)

test("unrelated dirty files are preserved while missing shared infrastructure installs", async () => {
  const f = fixture()
  write(f.project, "README.md", "ongoing unrelated edits\n")
  expect((await syncMigrate(f.io, f.options)).status).toBe("applied")
  expect(at(f, "README.md")).toBe("ongoing unrelated edits\n")
}, 60000)

test("source working-tree data does not leak into the project", async () => {
  const f = fixture()
  write(f.source, "data/shared/base.txt", "uncommitted source experiment\n")
  const r = await syncMigrate(f.io, f.options)
  expect(r.status).toBe("applied")
  expect(at(f, ".overwatch/shared/base.txt")).toBe("official one\n")
}, 60000)

test("offline source and corrupt receipt fail without mutation", async () => {
  const f = fixture()
  const offline = await syncMigrate(f.io, { ...f.options, sourceRoot: join(f.base, "unavailable") })
  expect(offline.status).toBe("offline")
  expect(existsSync(join(f.project, ".mcp.json"))).toBe(false)
  write(f.project, ".overwatch/sync/state.json", "{broken")
  expect((await syncMigrate(f.io, f.options)).status).toBe("blocked")
  expect(at(f, ".overwatch/sync/state.json")).toBe("{broken")
}, 60000)

test("manifest traversal, protected case aliases, version gaps and downgrade are refused", async () => {
  const f = fixture()
  expect((await syncMigrate(f.io, f.options)).status).toBe("applied")
  commit(f.project)
  const state = at(f, ".overwatch/sync/state.json")
  f.manifest.migrations.push({ version: 3, id: "gap", files: [] })
  write(f.source, "data/sync-manifest.json", JSON.stringify(f.manifest)); commit(f.source, "bad gap")
  expect((await syncMigrate(f.io, f.options)).status).toBe("blocked")
  f.manifest.migrations.pop()
  f.manifest.migrations[0].files[0].path = ".overwatch/vault/01 specs/keep.md"
  write(f.source, "data/sync-manifest.json", JSON.stringify(f.manifest)); commit(f.source, "bad protected path")
  expect((await syncMigrate(f.io, f.options)).status).toBe("blocked")
  f.manifest.migrations[0].files[0].path = ".overwatch/shared/../../plan.json"
  write(f.source, "data/sync-manifest.json", JSON.stringify(f.manifest)); commit(f.source, "bad traversal")
  expect((await syncMigrate(f.io, f.options)).status).toBe("blocked")
  expect(at(f, ".overwatch/sync/state.json")).toBe(state)
}, 60000)

test("default automatic check without committed authority is harmless", async () => {
  const f = fixture()
  const noSource = { ...f.io, root: join(f.base, "empty-runtime") }
  mkdirSync(noSource.root)
  const r = await syncAutomatic(noSource)
  expect(r.status).toBe("current")
  expect(r.reason).toBe("unconfigured")
  expect(syncNotice(r)).toBe("")
  expect(existsSync(join(f.project, ".mcp.json"))).toBe(false)
}, 60000)

test("repeating authority configuration recovers a pointer written before its receipt", async () => {
  const f = fixture()
  expect((await syncConfigure(f.io, f.options)).status).toBe("applied")
  const area = join(f.home, ".overwatch/sync")
  const archives = readdirSync(join(area, "transactions")).filter(n => n.endsWith(".json"))
  expect(archives.length).toBe(1)
  const journal = JSON.parse(readFileSync(join(area, "transactions", archives[0]!), "utf8"))
  journal.phase = "apply"
  writeFileSync(join(area, "journal.json"), JSON.stringify(journal))
  unlinkSync(join(area, "state.json"))
  const recovered = await syncConfigure(f.io, f.options)
  expect(["applied", "current"]).toContain(recovered.status)
  expect(existsSync(join(area, "journal.json"))).toBe(false)
  expect(JSON.parse(readFileSync(join(area, "state.json"), "utf8")).kind).toBe("authority")
  expect(JSON.parse(readFileSync(join(f.home, ".overwatch/source.json"), "utf8")).sourceRoot).toBe(f.source.replaceAll("\\", "/"))
}, 60000)
test("Copilot metadata proves no-Git runtime identity and loaded snapshots remain stable", async () => {
  const f = fixture()
  f.manifest.runtimePaths = [".github/plugin", "jev"]
  cpSync(join(f.io.root, "jev"), join(f.source, "jev"), { recursive: true })
  const metadata = JSON.stringify({ name: "overwatch", version: "0.3.0", hooks: "adapters/copilot/hooks.json" }) + "\n"
  write(f.source, ".github/plugin/plugin.json", metadata)
  write(f.source, "data/sync-manifest.json", JSON.stringify(f.manifest))
  const head = commit(f.source, "Copilot metadata")
  git(f.runtimeRoot, "pull", "--ff-only", "--quiet")
  const cache = join(f.base, "plugin-cache")
  mkdirSync(cache)
  for (const path of ["hooks", "bin", "types", "host", "jev", "data", "adapters", "package.json"])
    cpSync(join(f.io.root, path), join(cache, path), { recursive: true })
  if (existsSync(join(f.io.root, "node_modules")))
    symlinkSync(join(f.io.root, "node_modules"), join(cache, "node_modules"), process.platform === "win32" ? "junction" : "dir")
  write(cache, ".github/plugin/plugin.json", metadata)
  const loaded = { ...f.io, root: cache }
  expect(existsSync(join(cache, ".git"))).toBe(false)
  await captureSyncRuntime(loaded)
  const initial = await syncCheck(loaded, f.options)
  expect(initial.conflicts).toEqual([])
  expect(initial.status).toBe("uninitialized")
  expect(initial.runtime.commit).toBe(null)
  expect(initial.runtime.verifiedSourceCommit).toBe(head)
  expect(initial.restartRequired).toBe(false)

  write(cache, ".github/plugin/plugin.json", metadata.replace("0.3.0", "9.9.9"))
  const retained = await syncCheck(loaded, f.options)
  expect(retained.runtime.verifiedSourceCommit).toBe(head)
  expect(retained.restartRequired).toBe(false)

  const changed = join(f.base, "changed-plugin-cache")
  cpSync(cache, changed, { recursive: true })
  const reloaded = await syncCheck({ ...f.io, root: changed }, f.options)
  expect(reloaded.status).toBe("uninitialized")
  expect(reloaded.runtime.verifiedSourceCommit).toBeUndefined()
  expect(reloaded.restartRequired).toBe(true)
  expect(existsSync(join(f.project, ".overwatch/sync/state.json"))).toBe(false)
}, 60000)

function committedInstallation(f: ReturnType<typeof fixture>) {
  const root = join(f.base, "installed")
  repository(root)
  for (const path of ["hooks", "host", "bin", "types", "jev", "adapters", "data", ".claude-plugin", ".codex-plugin", ".cursor-plugin", ".github/plugin", "package.json"])
    cpSync(join(f.io.root, path), join(root, path), { recursive: true })
  write(root, ".gitignore", "node_modules/\n.overwatch/\n")
  if (existsSync(join(f.io.root, "node_modules")))
    symlinkSync(join(f.io.root, "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir")
  const head = commit(root, "committed runtime installation")
  return { io: { ...f.io, root }, head }
}

test("automatic startup does not enroll an unconfigured project from a committed Git installation", async () => {
  const f = fixture()
  const { io, head } = committedInstallation(f)
  expect(git(io.root, "status", "--porcelain")).toBe("")
  expect(git(io.root, "show", head + ":data/sync-manifest.json")).toContain('"format": 1')
  const ignore = at(f, ".gitignore")
  for (const reason of ["initialize", "reconnect", "session.start"] as const) {
    const result = await syncAutomatic(io, { reason })
    expect({
      status: result.status,
      reason: result.reason,
      notice: syncNotice(result),
      vault: existsSync(join(f.project, ".overwatch/vault")),
      receipt: existsSync(join(f.project, ".overwatch/sync/state.json")),
      mcp: existsSync(join(f.project, ".mcp.json")),
    }).toEqual({ status: "current", reason: "unconfigured", notice: "", vault: false, receipt: false, mcp: false })
    expect(at(f, ".gitignore")).toBe(ignore)
  }
  expect((await syncCheck(io)).status).toBe("uninitialized")
  const deliberate = await syncMigrate(io)
  expect(deliberate.status).toBe("applied")
  expect(deliberate.installedCommit).toBe(head)
  const enrolled = await syncAutomatic(io, { reason: "reconnect" })
  expect(enrolled.status).toBe("current")
  expect(enrolled.installedCommit).toBe(head)

  const area = join(f.project, ".overwatch/sync")
  const archives = readdirSync(join(area, "transactions")).filter(n => n.endsWith(".json"))
  expect(archives.length).toBe(1)
  const journal = JSON.parse(readFileSync(join(area, "transactions", archives[0]!), "utf8"))
  journal.phase = "apply"
  const journalBytes = JSON.stringify(journal)
  writeFileSync(join(area, "journal.json"), journalBytes)
  unlinkSync(join(area, "state.json"))
  const mcpBefore = at(f, ".mcp.json")
  const interrupted = await syncAutomatic(io, { reason: "reconnect" })
  expect(interrupted.status).toBe("blocked")
  expect(interrupted.reason).toContain("interrupted migration")
  expect(interrupted.pending).toContain("recover-interrupted-migration")
  expect(syncNotice(interrupted)).toContain("explicit source")
  expect(readFileSync(join(area, "journal.json"), "utf8")).toBe(journalBytes)
  expect(existsSync(join(area, "state.json"))).toBe(false)
  expect(at(f, ".mcp.json")).toBe(mcpBefore)
}, 60000)

test("automatic startup reports invalid authority and receipts while honoring explicit source precedence", async () => {
  const f = fixture()
  const { io } = committedInstallation(f)
  const pointer = ".overwatch/source.json"
  write(f.home, pointer, "{ broken")
  const malformed = await syncAutomatic(io)
  expect(malformed.status).toBe("error")
  expect(typeof malformed.reason).toBe("string")
  const invalidExplicit = await syncAutomatic(io, { sourceRoot: "" })
  expect(invalidExplicit.status).toBe("blocked")
  expect(invalidExplicit.conflicts[0]).toContain("authority root")

  write(f.home, pointer, JSON.stringify({ sourceRoot: 42 }))
  const invalid = await syncAutomatic(io)
  expect(invalid.status).toBe("error")
  expect(invalid.reason).toContain("invalid machine authority")

  write(f.home, pointer, JSON.stringify({ sourceRoot: join(f.base, "offline"), runtimeRoot: io.root }))
  expect((await syncAutomatic(io)).status).toBe("offline")
  expect(existsSync(join(f.project, ".overwatch/vault"))).toBe(false)
  expect(existsSync(join(f.project, ".mcp.json"))).toBe(false)

  write(f.home, pointer, "{ broken")
  expect((await syncAutomatic(io, { sourceRoot: io.root })).status).toBe("applied")
  expect((await syncAutomatic(io)).status).toBe("current")
  const invalidReceipt = "{ preserve this invalid receipt"
  write(f.project, ".overwatch/sync/state.json", invalidReceipt)
  expect((await syncAutomatic(io)).status).toBe("blocked")
  expect(at(f, ".overwatch/sync/state.json")).toBe(invalidReceipt)
}, 60000)
