import { expect, test } from "claude-code/testing"
import { memIo, type Runner } from "./io.ts"
import { EMPTY } from "./plan.ts"
import { addChange, changelog, changelogStatus, groupCommits, parseChangelog, renderChangelog, versionCmp } from "./changelog.ts"

const io = (files: Record<string, string>, run?: Runner) => ({
  ...memIo(files, "/p"),
  ...(run ? { run } : {}),
})
const plan = EMPTY
/** A git whose log lists `commits` (newest first) and whose package.json holds `versions` by sha. */
const fakeGit = (commits: string[][], versions: Record<string, string>): Runner => async (argv) => {
  const cmd = argv.join(" ")
  if (argv[0] === "git" && argv[1] === "log" && argv[3] === "--format=%H")
    return { code: 0, stdout: commits.map((c) => c[0]!).filter((sha) => versions[sha]).join("\n") + "\n", stderr: "" }
  if (cmd.startsWith("git log")) return { code: 0, stdout: commits.map((c) => c.join("\u001f")).join("\n") + "\n", stderr: "" }
  const shown = /^git show (\w+):package\.json$/.exec(cmd)
  if (shown && versions[shown[1]!]) return { code: 0, stdout: `{"version":"${versions[shown[1]!]}"}`, stderr: "" }
  return { code: 128, stdout: "", stderr: "no such object" }
}

test("changelog: add creates the current version's section, newest first, without duplicates", async () => {
  const files = {
    "/p/package.json": '{"version":"0.2.0"}',
    "/p/CHANGELOG.md": "# Changelog\n\nAll notable changes.\n\n## [0.1.0] - 2026-01-01\n\n- old\n",
  }
  const at = io(files)
  const first = await changelog(at, plan, { what_changed: "vault scaffold\n- spec note per unit", date: "2026-02-02" })
  expect(first.warn).toBeUndefined()
  const text = at.files["/p/CHANGELOG.md"]!
  expect(text).toContain("## [0.2.0] - 2026-02-02")
  expect(text).toContain("- vault scaffold")
  expect(text).toContain("- spec note per unit")
  expect(text.indexOf("## [0.2.0]")).toBeLessThan(text.indexOf("## [0.1.0]"))
  const again = await changelog(at, plan, { what_changed: "vault scaffold", date: "2026-02-03" })
  expect(again.text).toContain("Already in CHANGELOG.md under 0.2.0")
  expect(at.files["/p/CHANGELOG.md"]!.match(/vault scaffold/g)!.length).toBe(1)
})

test("changelog: LTS section parses and renders, and version order is numeric", () => {
  expect(versionCmp("0.10.0", "0.9.0")).toBeGreaterThan(0)
  expect(versionCmp("1.0.0", "1.0.0-rc")).toBeGreaterThan(0)
  const f = parseChangelog("## [0.1.0] - 2026-01-01 (LTS)\n\n- one\n")
  expect(f.entries[0]).toEqual({ version: "0.1.0", date: "2026-01-01", lts: true, body: ["- one"] })
  addChange(f, "0.2.0", ["two"], "2026-02-01")
  addChange(f, "0.1.0", ["one"], "2026-03-01", true)
  const text = renderChangelog(f)
  expect(text).toContain("## [0.2.0] - 2026-02-01")
  expect(text).toContain("## [0.1.0] - 2026-01-01 (LTS)")
  expect(parseChangelog(text).entries.find((e) => e.version === "0.1.0")!.body).toEqual(["- one"])
})

test("changelog: status reports the current and LTS versions", async () => {
  const at = io({
    "/p/package.json": '{"version":"0.2.0"}',
    "/p/CHANGELOG.md": "## [0.2.0] - 2026-02-01\n\n- a\n- b\n\n## [0.1.0] - 2026-01-01 (LTS)\n\n- c\n",
  })
  const text = await changelogStatus(at, "CHANGELOG.md")
  expect(text).toContain("current version: 0.2.0 (package.json)")
  expect(text).toContain("lts: 0.1.0")
  expect(text).toContain("versions: 0.2.0 (2 changes), 0.1.0 (1 change)")
})

test("changelog: backfill groups commits by the version each commit saw, idempotently", async () => {
  const commits = [
    ["c3aaaaaa", "2026-02-01T00:00:00+00:00", "add vault"],
    ["c2bbbbbb", "2026-01-20T00:00:00+00:00", "bump to 0.2.0"],
    ["c1cccccc", "2026-01-01T00:00:00+00:00", "first"],
  ]
  const run = fakeGit(commits, { c2bbbbbb: "0.2.0", c1cccccc: "0.1.0" })
  const at = io({ "/p/package.json": '{"version":"0.2.0"}' }, run)
  const grouped = await groupCommits(at)
  expect(typeof grouped).toBe("object")
  if (typeof grouped === "string") return
  expect(grouped.groups.map(([v, cs]) => [v, cs.map((c) => c.subject)])).toEqual([
    ["0.2.0", ["add vault", "bump to 0.2.0"]],
    ["0.1.0", ["first"]],
  ])
  const first = await changelog(at, plan, { backfill: true })
  expect(first.warn).toBeUndefined()
  expect(first.text).toContain("2 version(s), 3 commit(s), 3 bullet(s) added")
  expect(at.files["/p/CHANGELOG.md"]).toContain("## [0.2.0] - 2026-02-01")
  expect(at.files["/p/CHANGELOG.md"]).toContain("- add vault (c3aaaaa)")
  const again = await changelog(at, plan, { backfill: true })
  expect(again.text).toContain("0 bullet(s) added, 3 already present")
})

test("changelog: a commit before a bump stays under the version it saw", async () => {
  const commits = [
    ["e5eeeeee", "2026-03-01T00:00:00+00:00", "feature after"],
    ["e4dddddd", "2026-02-20T00:00:00+00:00", "bump to 0.3.0"],
    ["e3cccccc", "2026-02-10T00:00:00+00:00", "feature before"],
    ["e2bbbbbb", "2026-02-01T00:00:00+00:00", "bump to 0.2.0"],
    ["e1aaaaaa", "2026-01-01T00:00:00+00:00", "first"],
  ]
  const run = fakeGit(commits, { e4dddddd: "0.3.0", e2bbbbbb: "0.2.0", e1aaaaaa: "0.1.0" })
  const grouped = await groupCommits(io({ "/p/package.json": '{"version":"0.3.0"}' }, run))
  expect(typeof grouped).toBe("object")
  if (typeof grouped === "string") return
  expect(grouped.groups.map(([v, cs]) => [v, cs.map((c) => c.subject)])).toEqual([
    ["0.3.0", ["feature after", "bump to 0.3.0"]],
    ["0.2.0", ["feature before", "bump to 0.2.0"]],
    ["0.1.0", ["first"]],
  ])
  expect(versionCmp("1.0.0-rc.10", "1.0.0-rc.2")).toBeGreaterThan(0)
})

test("changelog: an LTS-only call persists without new bullets, and a foreign file is refused", async () => {
  const at = io({ "/p/package.json": '{"version":"0.2.0"}', "/p/CHANGELOG.md": "# Changelog\n\n## [0.1.0] - 2026-01-01\n\n- one\n" })
  const r = await changelog(at, plan, { version: "0.1.0", lts: true })
  expect(r.warn).toBeUndefined()
  expect(at.files["/p/CHANGELOG.md"]).toContain("## [0.1.0] - 2026-01-01 (LTS)")
  const bad = io({ "/p/other.md": '{"not":"a changelog"}' })
  const refused = await changelog(bad, plan, { file: "other.md", what_changed: "x" })
  expect(refused.warn).toBe(true)
  expect(bad.files["/p/other.md"]).toBe('{"not":"a changelog"}')
})
