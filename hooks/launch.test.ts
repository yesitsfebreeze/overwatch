import { test, expect } from "claude-code/testing"
import { memIo } from "./io.ts"
import { launch, launched } from "./launch.ts"

// The real shell end to end is in host/host.check.ts; here the bookkeeping over a fake process table.
test("launch: records cmd and pid; launched tells running, exit and killed runs apart", async () => {
  const alive = new Set(["11"])
  const io = { ...memIo({}), run: async (argv: readonly string[]) => (argv[0] === "kill" ? { code: alive.has(argv[2]!) ? 0 : 1, stdout: "", stderr: "" } : { code: 0, stdout: "11\n", stderr: "" }) }
  const out = await launch(io, "cargo build")
  const id = /launched id (\w+)/.exec(out)?.[1] ?? ""
  expect(io.files[`/mem/.overwatch/launch/${id}/cmd`]).toBe("cargo build")
  expect(io.files[`/mem/.overwatch/launch/${id}/pid`]).toBe("11")
  io.files["/mem/.overwatch/launch/1/cmd"] = "make test"
  io.files["/mem/.overwatch/launch/1/exit"] = "2\n"
  io.files["/mem/.overwatch/launch/2/cmd"] = "npm run dev"
  io.files["/mem/.overwatch/launch/2/pid"] = "99"
  const list = (await launched(io)).split("\n")
  expect(list[0]).toStartWith(`${id}  running`)
  expect(list.slice(1).map((l) => l.split("  ").slice(0, 2).join(" "))).toEqual(["2 gone (killed, no exit code)", "1 exit 2"])
  await expect(launched(io, "nope")).rejects.toThrow("no launched run")
  await expect(launch(io, "")).rejects.toThrow("needs a command")
})
