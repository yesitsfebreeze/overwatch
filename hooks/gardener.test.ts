import { test, expect } from "claude-code/testing"
import { ACTIVE_MINUTES, SCRIPTS, STALE_DAYS, clean, fileKind, fullNotice, judge, ownerOf, parseDf, render, survey, type Facts } from "./gardener.ts"
import { memIo, type Io } from "./io.ts"

const NOW = Date.now() // survey and clean read the clock themselves
const DAY = 86400
const F = (over: Partial<Facts> = {}): Facts => ({ type: "d", top: "", ignored: false, tracked: false, active: false, unsaved: "", ...over })
const CTX = { keep: ["/home/u/dev/keep"], cwds: ["/home/u/dev/live/src"], now: NOW, home: "/home/u" }
const out = (path: string, f: Facts, proven = true) => judge({ path, temp: false, proven }, f, CTX)
const tmp = (path: string, f: Facts) => judge({ path, temp: true, proven: true }, f, CTX)
const old = NOW / 1000 - (STALE_DAYS + 5) * DAY

test("judge: only proven, unused units may go; everything else names its reason", () => {
  expect(out("/home/u/dev/a/target", F({ commit: old }))).toEqual({ status: "leftover", why: `project's last commit ${STALE_DAYS + 5}d ago` })
  expect(out("/home/u/dev/a/target", F({ commit: NOW / 1000 - DAY })).status).toBe("regenerable")
  expect(out("/home/u/dev/a/target", F()).status).toBe("regenerable") // no git history: nothing says it is stale
  expect(out("/home/u/dev/a/node_modules", F({ commit: old }), false).status).toBe("unverified")
  expect(out("/home/u/dev/a/build", F({ commit: old, tracked: true })).why).toBe("git tracks files in it")
  expect(out("/home/u/dev/a/.venv", F({ commit: old, unsaved: "/home/u/dev/a/.venv/src/lib" })).why).toContain("unpushed work in /home/u/dev/a/.venv/src/lib")
  expect(out("/home/u/dev/a/target", F({ commit: old, active: true }))).toEqual({ status: "busy", why: `changed in the last ${ACTIVE_MINUTES} min` })
  expect(out("/home/u/dev/live/target", F({ commit: old })).why).toBe("a process works in /home/u/dev/live/src")
  expect(out("/home/u/dev/keep/app/target", F({ commit: old })).status).toBe("kept")
  expect(out("/home/u/.tool/ext/node_modules", F({ commit: old })).why).toContain("inside ~/.tool")
  expect(tmp("/tmp/x", F()).status).toBe("leftover")
  expect(tmp("/tmp/x", F({ active: true })).status).toBe("busy")
  expect(tmp("/tmp/clone", F({ top: "/tmp/clone", unsaved: "/tmp/clone" })).status).toBe("unverified")
  expect(tmp("/tmp/clone", F({ top: "/tmp/clone" })).status).toBe("leftover") // clean and pushed
  expect(tmp("/tmp/clone/src", F({ top: "/tmp/clone" })).why).toContain("part of the checkout")
  expect(tmp("/tmp/clone/target", F({ top: "/tmp/clone", ignored: true })).status).toBe("leftover")
})

test("parseDf, ownerOf, fileKind", () => {
  expect(parseDf("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 482746452 403899268 48691916 90% /System/Volumes/Data\n")).toEqual({ totalKib: 482746452, freeKib: 48691916, percent: 90, mount: "/System/Volumes/Data" })
  expect(parseDf("")).toBeUndefined()
  expect(ownerOf("Library/Caches/Homebrew")).toBe("brew cleanup -s")
  expect(ownerOf("Library/Caches/Homebrew/downloads")).toBe("brew cleanup -s")
  expect(ownerOf("Library/Developer/Xcode")).toBe("DerivedData: delete it; Xcode rebuilds")
  expect(ownerOf("Library/Caches/kache", { "Library/Caches/kache": "kache gc" })).toBe("kache gc")
  expect(ownerOf("Library/Caches/unknown")).toBe("")
  expect(fileKind("/home/u/Downloads/big.iso.crdownload")).toContain("partial download")
  expect(fileKind("/home/u/dev/a/core.123")).toBe("crash dump")
  expect(fileKind("/home/u/data.mdb")).toBe("large file")
})

/** An Io whose shell answers from tables: sizes per path for the walk, facts per path for the probe. */
function scripted(files: Record<string, string>, sizes: Record<string, number>, facts: Record<string, Partial<Facts>>, percent = 91) {
  const io = memIo(files, "/mem")
  const ran: string[][] = []
  const run: Io["run"] = async (argv) => {
    ran.push([...argv])
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" })
    if (argv[0] === "df") return ok(`Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/d 1000000 ${percent * 10000} ${(100 - percent) * 10000} ${percent}% /data\n`)
    if (argv[0] === "rm") return ok("")
    if (argv[0] !== "sh") return { code: 127, stdout: "", stderr: "" }
    const [script, , ...args] = argv.slice(2) as [string, string, ...string[]]
    const line = (p: string) => (sizes[p] ? `${sizes[p]}\t${p}\n` : "")
    if (script === SCRIPTS.walk) return ok(Object.keys(sizes).map(line).join(""))
    if (script === SCRIPTS.sizes) return ok(args.slice(1).map(line).join(""))
    if (script === SCRIPTS.real) return ok(args.map((d) => `${d}\t${d}\n`).join(""))
    if (script === SCRIPTS.open) return ok(args.map((p) => `${p}\t\n`).join(""))
    if (script === SCRIPTS.probe) return ok(args.slice(1).filter((p) => p in facts).map((p) => { const f = F(facts[p]); return [p, f.type, f.commit ?? "", f.top, +f.ignored, +f.tracked, +f.active, f.unsaved].join("\t") + "\n" }).join(""))
    return ok("")
  }
  return Object.assign(io, { run, ran })
}

test("survey (project): proven output is judged, the sizes are kept, the next survey names what grew", async () => {
  const sizes: Record<string, number> = { "/mem/app/node_modules": 204800, "/mem/gone/node_modules": 307200, "/mem/data/dump.bin": 2 << 20 }
  const io = scripted({ "/mem/app/package.json": "{}" }, sizes, { "/mem/app/node_modules": { commit: old }, "/mem/gone/node_modules": { commit: old }, "/mem/data/dump.bin": { type: "f" } })
  const s = await survey(io, "project")
  expect(s.units.map((u) => [u.path, u.status])).toEqual([["/mem/gone/node_modules", "unverified"], ["/mem/app/node_modules", "leftover"]])
  expect(s.files).toEqual([{ path: "/mem/data/dump.bin", kib: 2 << 20, note: "large file" }])
  expect(s.grew).toEqual([])
  expect(JSON.parse(io.files["/mem/.overwatch/disk.json"]!).project.kib["/mem/app/node_modules"]).toBe(204800)
  const text = render(s)
  expect(text).toContain("/data: 91% used")
  expect(text).toContain("## Leftover: nothing uses it; disk_clean deletes it (1, 200 MiB)")
  expect(text).toContain('mcp__overwatch__disk {scope: "disk"}') // still nearly full: the whole disk is next
  sizes["/mem/app/node_modules"] = 204800 + 512000
  expect((await survey(io, "project")).grew).toEqual([{ path: "/mem/app/node_modules", kib: 512000, note: "now 700 MiB" }])
})

test("clean: judged again, refused with the reason, deleted only with apply", async () => {
  const facts = { "/mem/app/node_modules": { commit: old }, "/mem/src": { tracked: true }, "/mem/app/target": { commit: old, active: true } }
  const io = scripted({ "/mem/app/package.json": "{}", "/mem/app/Cargo.toml": "" }, { "/mem/app/node_modules": 204800 }, facts)
  const paths = ["/mem/app/node_modules", "/mem/src", "/mem/app/target", "/mem/missing"]
  const dry = await clean(io, paths)
  expect(dry).toContain("would delete     200 MiB  /mem/app/node_modules")
  expect(dry).toContain("refused  /mem/src: neither in a temp folder nor a known build output folder")
  expect(dry).toContain(`refused  /mem/app/target: changed in the last ${ACTIVE_MINUTES} min`)
  expect(dry).toContain("refused  /mem/missing: not found")
  expect(io.ran.filter((a) => a[0] === "rm")).toEqual([])
  const done = await clean(io, paths, true)
  expect(io.ran.filter((a) => a[0] === "rm")).toEqual([["rm", "-rf", "--", "/mem/app/node_modules"]])
  expect(done).toContain("1 deleted, 200 MiB")
  expect(JSON.parse(io.files["/mem/.overwatch/disk.json"]!).cleaned[0]).toMatchObject({ path: "/mem/app/node_modules", kib: 204800 })
  await expect(clean(io, ["/mem/app/../app/node_modules"], true)).rejects.toThrow("absolute paths without . or ..")
  await expect(clean(io, ["node_modules"], true)).rejects.toThrow("absolute paths")
})

test("fullNotice: silent below the threshold and when switched off", async () => {
  const io = scripted({}, {}, {}, 91)
  expect(await fullNotice(io, 88)).toContain("is 91% full")
  expect(await fullNotice(io, 88)).toContain("mcp__overwatch__disk (this project first)")
  expect(await fullNotice(io, 95)).toBe("")
  expect(await fullNotice(io, 0)).toBe("")
})
