import { test, expect } from "claude-code/testing"
import { resetShellArgv, shellArgv, type Runner } from "./io.ts"

/** A fresh probe over a Runner that maps argv[0] to an exit code and records each one tried. */
const prober = (behavior: Record<string, number>) => {
  resetShellArgv()
  const seen: string[] = []
  const run: Runner = async (argv) => {
    seen.push(argv[0]!)
    return { code: behavior[argv[0]!] ?? 127, stdout: "", stderr: "" }
  }
  return { run, seen }
}

test("shellArgv: plain sh wins where it starts, probed once per process", async () => {
  const { run, seen } = prober({ sh: 0 })
  expect(await shellArgv(run)).toEqual(["sh"])
  await shellArgv(run)
  expect(seen).toEqual(["sh"])
})

test("shellArgv: on a machine with no sh, the first Git sh that starts wins", async () => {
  const { run, seen } = prober({ "C:\\Program Files\\Git\\bin\\sh.exe": 0 })
  expect(await shellArgv(run)).toEqual(["C:\\Program Files\\Git\\bin\\sh.exe"])
  expect(seen).toEqual(["sh", "C:\\Program Files\\Git\\bin\\sh.exe"])
})

test("shellArgv: a machine with no shell at all keeps sh as the last resort", async () => {
  const { run, seen } = prober({})
  expect(await shellArgv(run)).toEqual(["sh"])
  expect(seen[0]).toBe("sh")
})
