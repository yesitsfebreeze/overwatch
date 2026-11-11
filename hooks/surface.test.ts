import { test, expect } from "claude-code/testing"
import { memIo, type Io } from "./io.ts"
import { discover, draw, evaluation, firedBy, index, load, rate, report, save, shellBinary, tally } from "./surface.ts"
import { EVALUATE_AFTER_CALLS } from "./commands.ts"

// The fs engine resolves a path before a hook sees it: win32 delivers 'C:\state\x' for '/state/x'.
// Normalize back so the POSIX keys the mocks pre-seed match on every host.
const norm = (p: unknown) => String(p).replace(/\\/g, "/").replace(/^[A-Za-z]:/, "")

/** A memory Io with a state home and a PATH holding only `onPath`. */
function io(files: Record<string, string> = {}, onPath = ["ls"]): Io & { files: Record<string, string> } {
  const m = memIo(files, "/repo")
  return {
    ...m,
    root: "/plugin",
    env: async (n) => (n === "XDG_STATE_HOME" ? "/state" : n === "HOME" ? "/home" : undefined),
    run: async (argv) => ({ code: 0, stdout: argv.slice(4).filter((b) => onPath.includes(b)).join("\n"), stderr: "" }),
  }
}

test("scan: parameterised just recipes are seen, and verify supersedes raw cargo", async () => {
  const m = io({ "/repo/Cargo.toml": "[package]\n", "/repo/justfile": 'target := "x"\nbuild:\n\tcargo build\ntest *args:\n\tcargo test\nverify rev="HEAD":\n\techo\n' })
  expect(await discover(m)).toEqual(["just build", "just verify"])
})

test("shellBinary: the command a Bash call ran, past cd, env and flags", () => {
  // A fragment the split cut out of a quoted string or `$(…)` is not a binary.
  expect(shellBinary('git log --format="$(real() { :; })"')).toBe("sh:git")
  expect(shellBinary("commits.txt) | wc -l")).toBe("sh:wc")
  expect(shellBinary("cd /tmp && rg foo")).toBe("sh:rg")
  expect(shellBinary("FOO=1 /usr/bin/git status | head")).toBe("sh:git")
  expect(shellBinary(42)).toBeUndefined()
  expect(firedBy("Bash", { command: "sed -n 1p x" })).toEqual(["Bash", "sh:sed"])
  expect(firedBy("Read", { command: "rg" })).toEqual(["Read"])
})

test("index: only active tools and binaries on PATH; the drawn tool is one of them", async () => {
  const m = io()
  await save(m, { counts: { Bash: 9, mcp__gone__task: 7, Read: 3, "sh:ls": 5, "sh:no-such-binary-xyz": 4 }, verdicts: {}, triggers: { mcp__gone__task: "gone trigger", Read: "read trigger" }, drawn: null })
  const out = await index(m, ["Bash", "Read"])
  expect(out).toContain("# Tool surface (overwatch)")
  expect(out).toContain("Bash 9")
  expect(out).toContain("read trigger")
  expect(out).toContain("ls 5")
  expect(out).not.toContain("mcp__gone__task")
  expect(out).not.toContain("gone trigger")
  expect(out).not.toContain("no-such-binary-xyz")
  expect((await load(m)).drawn?.name).not.toBe("mcp__gone__task")
  // Without an active list (the terminal) every tool shows; binaries still need PATH.
  expect(await index(m)).toContain("mcp__gone__task 7")
})

test("index: shell search that dwarfs kern asks for kern first, only where kern fired", async () => {
  const m = io({}, ["rg", "sed"])
  await save(m, { counts: { "sh:rg": 30, "sh:sed": 20, kern_fs: 5 }, verdicts: {}, triggers: {}, drawn: null })
  expect(await index(m)).toContain("## Search through kern first: shell search 50 vs kern 5")
  await save(m, { counts: { "sh:rg": 30 }, verdicts: {}, triggers: {}, drawn: null })
  expect(await index(m)).not.toContain("kern first")
})

test("index: the kern CLI on PATH is not kern's tools, so it never asks for kern first", async () => {
  const m = io({}, ["rg", "sed", "kern"])
  await save(m, { counts: { "sh:rg": 30, "sh:sed": 20, "sh:kern": 5 }, verdicts: {}, triggers: {}, drawn: null })
  const block = await index(m, ["Bash", "Read"])
  expect(block).toContain("kern 5") // still listed as a shell binary
  expect(block).not.toContain("kern first")
})

test("ledger: tally adds a turn's fires; rate refuses a useful verdict without a trigger", async () => {
  const m = io()
  await tally(m, { Bash: 2, "sh:rg": 1 })
  await tally(m, { Bash: 1 })
  expect((await load(m)).counts).toEqual({ Bash: 3, "sh:rg": 1 })
  await expect(rate(m, "WebFetch", "useful", "read docs by hand")).rejects.toThrow("needs a trigger")
  await expect(rate(m, "WebFetch", "great", "x")).rejects.toThrow("verdict must be one of")
  expect(await rate(m, "WebFetch", "useful", "read docs by hand", "a docs URL in the request")).toContain("rated useful")
  expect((await load(m)).triggers.WebFetch).toBe("a docs URL in the request")
  expect(await report(m)).toContain("a docs URL in the request")
  // A freshly rated tool is not drawn again.
  expect(draw(await load(m), ["WebFetch"])).toBeNull()
})

test("index: the evaluation can be left out; evaluation() names the drawn tool", async () => {
  const m = io()
  await save(m, { counts: { Bash: 9, Read: 3 }, verdicts: {}, triggers: {}, drawn: null })
  expect(await index(m, ["Bash", "Read"])).toContain("Evaluation due")
  expect(await index(m, ["Bash", "Read"], false)).not.toContain("Evaluation due")
  expect(evaluation({ name: "Read", uses: 3 })).toContain('name: "Read"')
})

test("session: rating held back while the session is unused, asked once after real work", async ($, on) => {
  on("tool.list", async () => ({ value: [{ name: "Agent", description: "", mcp: false }] }) as any)
  on("prompt.compose", async () => ({ sections: [] }) as any)
  on("prompt.submit", async (_: any, e: any) => ({ ...e }))
  // A machine ledger in memory: two used tools, so one is drawn for rating.
  const files: Record<string, string> = { "/state/overwatch/surface.json": JSON.stringify({ counts: { Bash: 9, Read: 3 } }) }
  on("session.cwd", async () => ({ value: "/repo" }) as any)
  on("env.get", async (_: any, e: any) => ({ value: (e?.name ?? e) === "XDG_STATE_HOME" ? "/state" : undefined }) as any)
  on("fs.read", async (_: any, e: any) => (norm(e?.path ?? e) in files ? { value: files[norm(e?.path ?? e)] } : { deny: "ENOENT" }) as any)
  on("fs.write", async (_: any, e: any) => ((files[norm(e.path)] = e.text), { value: undefined }) as any)
  on("fs.exists", async (_: any, e: any) => ({ value: norm(e?.path ?? e) in files }) as any)
  on("process.run", async () => ({ value: { exitCode: 0, stdout: "", stderr: "" } }) as any)
  on("tool.call", async () => ({ result: "ok" }) as any)
  on("turn.complete", async () => ({ text: "" }) as any)
  const built = JSON.stringify((await ($.prompt.compose as any)({ model: "m", promptModel: "m", surfaces: [], tools: ["Bash", "Read"], outputStyle: null, traits: [] })).sections)
  expect(built).toContain("Used most on this machine")
  expect(JSON.stringify((await ($.prompt.compose as any)({ model: "m", promptModel: "m", surfaces: [], tools: ["Bash", "Read"], outputStyle: null, traits: [] })).sections)).not.toContain("Evaluation due")
  const submit = async () => JSON.stringify(await $.prompt.submit({ text: "hi" } as any))
  expect(await submit()).not.toContain("Evaluation due")
  // Real work: main-thread tool calls, folded in when the turn completes.
  for (let i = 0; i < EVALUATE_AFTER_CALLS; i++) await $.tool.call({ tool: "Read", file_path: "/repo/x" } as any)
  await $.turn.complete({ turnId: "t1", answer: "", reason: "end_turn" } as any)
  expect(await submit()).toContain("Evaluation due")
  expect(await submit()).not.toContain("Evaluation due")
})
