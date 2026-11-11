import { test, expect } from "claude-code/testing"
import { resetShellArgv, shellArgv, type Runner } from "./io.ts"

/** A Runner whose behavior is a map from argv[0] to exit code; counts probes. */
const prober = (behavior: Record<string, number>) => {
  const seen: string[] = []
  const run: Runner = async (argv) => {
    seen.push(argv[0]!)
    return { code: behavior[argv[0]!] ?? 127, stdout: "", stderr: "" }
  }
  return { run, seen }
}

test("shellArgv: plain sh wins where it starts", async () => {
  resetShellArgv()
  const { run, seen } = prober({ sh: 0 })
  expect(await shellArgv(run)).toEqual(["sh"])
  expect(seen).toEqual(["sh"])
})

test("shellArgv: on a machine with no sh, the first Git sh that starts wins", async () => {
  resetShellArgv()
  const { run, seen } = prober({ "C:\\Program Files\\Git\\bin\\sh.exe": 0 })
  expect(await shellArgv(run)).toEqual(["C:\\Program Files\\Git\\bin\\sh.exe"])
  expect(seen).toEqual(["sh", "C:\\Program Files\\Git\\bin\\sh.exe"])
})

test("shellArgv: a machine with no shell at all keeps sh as the last resort", async () => {
  resetShellArgv()
  const { run, seen } = prober({})
  expect(await shellArgv(run)).toEqual(["sh"])
  expect(seen[0]).toBe("sh")
})

test("shellArgv: the probe runs once per process, then the answer is cached", async () => {
  resetShellArgv()
  const { run, seen } = prober({ sh: 0 })
  await shellArgv(run)
  await shellArgv(run)
  expect(seen).toEqual(["sh"])
})
