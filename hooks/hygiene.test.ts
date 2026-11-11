import { test, expect } from "claude-code/testing"
import { FIXTURE, fixed2, fm, hygiene, ratio, repr, selftest, title } from "./hygiene.ts"
import { memIo } from "./io.ts"
import { loadout } from "./loadout.ts"

test("hygiene: the selftest fixture raises every rule it checks", async () => {
  expect(await selftest()).toEqual([])
  expect(await hygiene(memIo({}), ["--selftest"])).toEqual({ text: "selftest ok", code: 0 })
})

test("hygiene: writes LEDGER.md for a repo and flags a near-duplicate pair", async () => {
  const desc = 'Review Vue components for style, naming and conventions in a pull request. Use for "vue review".'
  const io = memIo({
    "/r/skills/one/SKILL.md": `---\nname: one\ndescription: ${desc}\n---\nbody\n`,
    "/r/skills/two/SKILL.md": `---\nname: two\ndescription: ${desc.replace("style", "styling")}\n---\nbody\n`,
  })
  const r = await hygiene(io, ["/r"])
  expect(r).toEqual({ text: "2 skills, 1 findings -> LEDGER.md", code: 0 })
  const ledger = io.files["/r/LEDGER.md"]!
  expect(ledger).toContain("## Duplicates")
  expect(ledger).toMatch(/\| one \| overlaps with 'two' \(vocabulary 0\.78, text 0\.98\)/)
  expect(ledger).toContain("| one | duplicate | medium |")
})

test("hygiene: no skills/ is an error; cwd with skills/ is the default repo", async () => {
  expect((await hygiene(memIo({}), ["/nowhere"])).code).toBe(1)
  const io = memIo({ "/mem/skills/a/SKILL.md": "---\nname: a\ndescription: x\n---\n" })
  expect((await hygiene(io, [])).code).toBe(0)
  expect(io.files["/mem/LEDGER.md"]).toContain("| a |")
})

test("hygiene: Python parity helpers (ratio, repr, .2f, frontmatter, titles)", () => {
  // difflib.SequenceMatcher(None, a, b).ratio() values
  expect(ratio("abcd", "bcde")).toBe(0.75)
  expect(ratio("", "")).toBe(1)
  expect(ratio("tide", "diet")).toBe(0.25)
  expect(repr("x")).toBe("'x'")
  expect(repr("it's")).toBe('"it\'s"')
  expect(repr(undefined)).toBe("None")
  expect(repr(["a", "b"])).toBe("['a', 'b']")
  expect(fixed2(0.125)).toBe("0.12") // half to even, as Python
  expect(fixed2(0.375)).toBe("0.38")
  expect(fixed2(1 / 3)).toBe("0.33")
  const [meta, body] = fm(FIXTURE["/t/skills/alpha/SKILL.md"]!)
  expect(meta.requires).toEqual(["beta"])
  expect(meta.description).toBe('Review Vue components for style and conventions. Use for "vue review", "check my component".')
  expect(body.startsWith("Requires the omega skill.")).toBe(true)
  expect(title({ skill: "a", rule: "duplicate", severity: "medium", detail: "overlaps with 'b' (...)" })).toBe("[hygiene] a: duplicate (b)")
})

test("loadout: BASE is the global column; the installed file's lag is reported", async () => {
  const io = memIo({
    "/h/.claude/setup-plugins.sh": 'X=1\nBASE="overwatch@overwatch"\nPREPEND="$BASE sec-default@builtin"\n',
    "/h/.claude/settings.json": JSON.stringify({ enabledPlugins: { "kern@kern": true, "overwatch@overwatch": true } }),
    "/h/.claude/work/settings.json": JSON.stringify({ enabledPlugins: { "kern@kern": false } }),
  })
  io.env = async (n) => ({ HOME: "/h", CLAUDE_CONFIG_DIR: "/h/.claude/work" })[n]
  const lines = (await loadout(io)).split("\n")
  expect(lines[0]).toMatch(/^plugin +global +default +work\* +project +local$/)
  expect(lines[1]).toMatch(/^overwatch@overwatch +x +\* +\/ +\/ +\/$/)
  expect(lines[2]).toMatch(/^kern@kern +\. +x +\. +\. +\.$/)
  expect(lines.at(-1)).toBe("global not installed: 1 to add, 0 to drop. Run the sudo line from: sh ~/.claude/setup-plugins.sh")
})
