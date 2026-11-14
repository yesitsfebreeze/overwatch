// Real CLI and stdio MCP integration; never loaded into Claude's hook test engine.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"

const repo = resolve(import.meta.dir, "..")
const sandbox = mkdtempSync(join(tmpdir(), "overwatch-sync-host-"))
const source = join(sandbox, "authority")
const cache = join(sandbox, "plugin-cache")
const cliPath = join(source, "bin", "cli.ts")
type Context = { root: string; env: NodeJS.ProcessEnv; originals: Record<string, string>; custom: Record<string, unknown> }
type Result = { code: number | null; stdout: string; stderr: string }

function put(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}
function git(root: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const r = spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8", windowsHide: true, timeout: 30000 })
  if (r.error || r.status !== 0) throw new Error("fixture git: " + (r.error?.message ?? r.stderr))
  return r.stdout.trim()
}
function init(root: string, env?: NodeJS.ProcessEnv) {
  git(root, ["init", "-q"], env)
  git(root, ["config", "core.autocrlf", "false"], env)
  git(root, ["add", "--all"], env)
  git(root, ["-c", "user.name=Overwatch fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "-qm", "Create integration fixture"], env)
}
beforeAll(() => {
  mkdirSync(source); mkdirSync(cache)
  for (const path of ["hooks", "host", "bin", "types", "jev", "data", "adapters", ".claude-plugin", ".codex-plugin", ".cursor-plugin", ".github/plugin", "package.json"])
    for (const target of [source, cache]) cpSync(join(repo, path), join(target, path), { recursive: true })
  put(source, ".gitignore", "node_modules/\n.overwatch/\n")
  if (existsSync(join(repo, "node_modules")))
    for (const target of [source, cache]) symlinkSync(join(repo, "node_modules"), join(target, "node_modules"), process.platform === "win32" ? "junction" : "dir")
  init(source)
}, 60000)
afterAll(() => rmSync(sandbox, { recursive: true, force: true }))

function project(name: string): Context {
  const root = join(sandbox, name), home = join(sandbox, name + "-home")
  mkdirSync(root); mkdirSync(home)
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, ".claude"),
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }
  const custom = { command: "node", args: ["custom-mcp.mjs"], env: { PROJECT_MODE: "keep" } }
  const originals = {
    ".overwatch/plan.json": '{ "plan": { "tasks": [{"id":9,"title":"Other worker","status":"active","progress":40}], "nextId":10, "guards":[{"id":"keep","question":"Keep my guard","check":"exit 9","met":false}] }, "stops":{"rounds":2}, "told":true }\n',
    ".overwatch/vault/01 Specs/Active work.md": "---\nstatus: target\nowner: another-worker\nsince: 2026-11-14T10:00:00Z\npaths: [src/owned.ts]\n---\n# Active work\n\n- [ ] Keep this task.\n",
    ".overwatch/vault/Home.md": "# Project home\n\nKeep this customized home.\n",
    ".overwatch/vault/.obsidian/plugins/custom-widget/data.json": '{"projectSetting":42}\n',
    "SYSTEM.md": "# Project instructions\nKeep the singular SYSTEM.md convention.\n",
    "WORK.md": "# Project work\nKeep the existing workflow.\n",
    "src/owned.ts": "// committed source\n",
  }
  for (const [path, text] of Object.entries(originals)) put(root, path, text)
  put(root, ".mcp.json", JSON.stringify({ projectSetting: "keep", mcpServers: { custom } }, null, 2) + "\n")
  put(root, ".overwatch/vault/.obsidian/community-plugins.json", '["custom-widget"]\n')
  put(root, ".gitignore", ".overwatch/*\n!.overwatch/vault/\n")
  init(root, env)
  originals["src/owned.ts"] = "// another worker's uncommitted change\n"
  put(root, "src/owned.ts", originals["src/owned.ts"])
  return { root, env, originals, custom }
}
function cli(c: Context, args: string[], input = "", script = cliPath): Result {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: c.root, env: c.env,
    input, encoding: "utf8", windowsHide: true, timeout: 90000, maxBuffer: 16 * 1024 * 1024 })
  if (r.error) throw r.error
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}
function report(r: Result): any {
  try { return JSON.parse((r.stdout || r.stderr).trim()) }
  catch { throw new Error("Expected JSON report, exit " + r.code + ": " + r.stdout + r.stderr) }
}
function success(r: Result) {
  if (r.code !== 0) throw new Error("CLI failed (" + r.code + "): " + r.stdout + r.stderr)
}
function configure(c: Context) { success(cli(c, ["sync", "source", source])) }
function preserved(c: Context) {
  for (const [path, text] of Object.entries(c.originals)) expect(readFileSync(join(c.root, path), "utf8")).toBe(text)
  const config = JSON.parse(readFileSync(join(c.root, ".mcp.json"), "utf8"))
  expect(config.projectSetting).toBe("keep")
  expect(config.mcpServers.custom).toEqual(c.custom)
}
function receipt(c: Context) { return readFileSync(join(c.root, ".overwatch/sync/state.json"), "utf8") }
function rpc(id: number, method: string, params: any = {}) { return { jsonrpc: "2.0", id, method, params } }
function mcp(c: Context, requests: object[], script = cliPath): any[] {
  const r = cli(c, ["mcp"], requests.map(x => JSON.stringify(x)).join("\n") + "\n", script)
  success(r)
  const answers = r.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  for (const answer of answers) if (answer.error) throw new Error(JSON.stringify(answer.error))
  return answers
}
const initialize = (id = 1) => rpc(id, "initialize", { protocolVersion: "2025-06-18",
  capabilities: {}, clientInfo: { name: "sync-integration", version: "1" } })

test("CLI configures an authority, migrates a dirty project and verifies a byte-stable repeat", () => {
  const c = project("cli")
  configure(c)
  const initial = cli(c, ["sync", "check"])
  expect(initial.code).toBe(1)
  expect(report(initial).status).toBe("uninitialized")
  expect(existsSync(join(c.root, ".overwatch/sync/state.json"))).toBe(false)
  const applied = cli(c, ["sync", "migrate"])
  success(applied)
  expect(report(applied).status).toBe("applied")
  expect(report(applied).installedCommit).toBe(git(source, ["rev-parse", "HEAD"]))
  expect(report(applied).restartRequired).toBe(false)
  const before = receipt(c), configBefore = readFileSync(join(c.root, ".mcp.json"), "utf8")
  const verify = cli(c, ["sync", "verify"])
  success(verify)
  expect(report(verify).verification.ok).toBe(true)
  const repeated = cli(c, ["sync", "migrate"])
  success(repeated)
  expect(report(repeated).status).toBe("current")
  expect(receipt(c)).toBe(before)
  expect(readFileSync(join(c.root, ".mcp.json"), "utf8")).toBe(configBefore)
  expect(JSON.parse(readFileSync(join(c.root, ".overwatch/vault/.obsidian/community-plugins.json"), "utf8"))).toContain("custom-widget")
  preserved(c)
}, 120000)

test("MCP initialize, tool calls and reconnect share automatic synchronization without replacing active work", () => {
  const c = project("mcp")
  const configured = mcp(c, [initialize(), rpc(2, "tools/call", { name: "sync_source", arguments: { source_root: source, runtime_root: source } })], join(cache, "bin/cli.ts"))
  expect(configured[1].result.isError).toBe(false)
  expect(JSON.parse(configured[1].result.content[0].text).reason).toBe("machine-authority-configured")
  expect(existsSync(join(c.root, ".overwatch/sync/state.json"))).toBe(false)
  const answers = mcp(c, [initialize(), rpc(2, "tools/list"), rpc(3, "tools/call", { name: "sync_verify", arguments: {} }),
    rpc(4, "tools/call", { name: "sync_check", arguments: {} }), initialize(5)])
  expect(answers.map(a => a.id)).toEqual([1, 2, 3, 4, 5])
  expect(answers[0].result.instructions).toContain("[overwatch sync] applied")
  const names = answers[1].result.tools.map((t: any) => t.name)
  for (const name of ["sync_source", "sync_check", "sync_migrate", "sync_verify"]) expect(names).toContain(name)
  for (const answer of answers.slice(2, 4)) {
    expect(answer.result.isError).toBe(false)
    expect(JSON.parse(answer.result.content[0].text).status).toBe("current")
  }
  expect(answers[4].result.instructions).toContain("[overwatch sync] current")
  const before = receipt(c), configBefore = readFileSync(join(c.root, ".mcp.json"), "utf8")
  const reconnect = mcp(c, [initialize(), rpc(2, "tools/call", { name: "sync_migrate", arguments: {} })])
  expect(reconnect[0].result.instructions).toContain("[overwatch sync] current")
  expect(reconnect[1].result.isError).toBe(false)
  expect(receipt(c)).toBe(before)
  expect(readFileSync(join(c.root, ".mcp.json"), "utf8")).toBe(configBefore)
  preserved(c)
}, 120000)


test("a fresh cached plugin without Git metadata resolves the configured machine authority", () => {
  const c = project("cached-plugin")
  configure(c)
  expect(existsSync(join(cache, ".git"))).toBe(false)
  const answers = mcp(c, [initialize(), rpc(2, "tools/call", { name: "sync_verify", arguments: {} })], join(cache, "bin/cli.ts"))
  expect(answers[0].result.instructions).toContain("[overwatch sync] applied")
  expect(answers[1].result.isError).toBe(false)
  const result = JSON.parse(answers[1].result.content[0].text)
  expect(result.installedCommit).toBe(git(source, ["rev-parse", "HEAD"]))
  expect(result.verification.ok).toBe(true)
  expect(result.restartRequired).toBe(false)
  preserved(c)
}, 120000)

test("invalid CLI synchronization options fail before changing project state", () => {
  const c = project("invalid")
  const configBefore = readFileSync(join(c.root, ".mcp.json"), "utf8")
  for (const args of [
    ["sync", "unknown"], ["sync", "source"], ["sync", "source", source, "--ref"],
    ["sync", "check", "--source"], ["sync", "verify", "--ref"], ["sync", "check", "--runtime"],
    ["sync", "source", source, "--runtime"], ["sync", "check", "--runtime", source, "--runtime", source],
    ["sync", "migrate", "--bogus", "yes"], ["sync", "migrate", "--source", source, "--source", source],
  ]) {
    const r = cli(c, args)
    expect(r.code).toBe(2)
    expect(existsSync(join(c.root, ".overwatch/sync/state.json"))).toBe(false)
  }
  expect(readFileSync(join(c.root, ".mcp.json"), "utf8")).toBe(configBefore)
  preserved(c)
}, 120000)
