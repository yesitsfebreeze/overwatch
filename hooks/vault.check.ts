/**
 * Runnable proof for the vault's claim and evidence path, runnable without the host's
 * `claude-code/testing` module: `bun hooks/vault.check.ts`.
 */
import type { Plan } from "../types/index.d.ts"
import { memIo, type Runner } from "./io.ts"
import { EMPTY } from "./plan.ts"
import { claimStale, frontmatter, unitClaim, unitLoad, unitNew, unitRecord, unitRelease, unitVerify } from "./vault.ts"

const V = "/p/.overwatch/vault"
const TEMPLATE = "---\ntitle: {{title}}\ncategory:\nstatus: target\nupdated: {{date}}\n---\n\n# {{title}}\n\n## Summary\n\nOne paragraph.\n\n## Plan\n\n- [ ] placeholder\n\n## Status\n\nNothing yet.\n\n## Open questions\n\n-\n"
const scaffold = {
  "/plug/data/vault/00 Meta/Spec Template.md": TEMPLATE,
  "/plug/data/vault/Home.md": "# Home\n",
  "/plug/data/vault/.obsidian/community-plugins.json": '["dataview", "plan-view"]',
}

const ok = (yes: boolean, what: string) => { if (!yes) throw new Error(`FAIL: ${what}`) }
const has = (text: string, part: string, what: string) => ok(text.includes(part), `${what}: expected ${part} in ${text}`)

let commit = "a".repeat(40)
const run: Runner = async (argv) => {
  if (argv[0] === "git" && argv[1] === "rev-parse") return { code: 0, stdout: `${commit}\n`, stderr: "" }
  if (argv[0] === "git" && argv[1] === "status") return { code: 0, stdout: "", stderr: "" }
  return { code: 0, stdout: "ok", stderr: "" }
}
const io = { ...memIo({ ...scaffold }, "/p"), root: "/plug", run }
const note = () => io.files[`${V}/01 Specs/Parser.md`] ?? ""

async function main() {
  ok(claimStale("2000-01-01T00:00:00Z"), "an old since is stale")
  ok(!claimStale(new Date().toISOString()), "a fresh since is live")

  await unitNew(io, { title: "Parser", category: "behavior", summary: "Parse things.", tasks: ["lex tokens", "build tree"], checks: ["bun test parser"] })

  // claim: one owner, refused for another, stale takeover needs the flag, release needs the owner
  ok(!(await unitClaim(io, EMPTY, { unit: "Parser", owner: "a@1" })).warn, "first claim is accepted")
  ok(frontmatter(note()).fields.owner === "a@1", "claim writes the owner")
  has((await unitClaim(io, EMPTY, { unit: "Parser", owner: "b@1" })).text, "claimed by a@1", "live claim refused")
  io.files[`${V}/01 Specs/Parser.md`] = note().replace(/^since: .*$/m, "since: 2000-01-01T00:00:00Z")
  has((await unitClaim(io, EMPTY, { unit: "Parser", owner: "c@1" })).text, "stale", "stale claim needs takeover")
  ok(!(await unitClaim(io, EMPTY, { unit: "Parser", owner: "c@1", takeover: true })).warn, "takeover takes a stale claim")
  ok(frontmatter(note()).fields.owner === "c@1", "takeover writes the new owner")
  has((await unitRelease(io, EMPTY, { unit: "Parser", owner: "a@1" })).text, "claimed by c@1", "release refuses the wrong owner")
  ok(!(await unitRelease(io, EMPTY, { unit: "Parser", owner: "c@1" })).warn, "the owner releases")
  ok(frontmatter(note()).fields.owner === undefined, "release clears the owner")

  // load with an owner claims it, tiers the check guards, and records an evidence run
  const loaded = await unitLoad(io, EMPTY, { unit: "Parser", owner: "d@1" })
  ok(!loaded.warn, `load accepted: ${loaded.text}`)
  ok(frontmatter(note()).fields.owner === "d@1", "unit_load claims for its owner")
  ok(loaded.state.guards[0]?.tier === "unit", "spec checks become unit-tier guards")
  const done: Plan = { ...loaded.state, tasks: loaded.state.tasks.map((t) => ({ ...t, status: "done" as const, progress: 100 })) }
  const rec = await unitRecord(io, done, { summary: "Parses tokens into a tree.", limitations: "none" })
  ok(!rec.warn, `record accepted: ${rec.text}`)
  has(rec.text, "run ", "record names its run")
  has(rec.text, "as implemented", "record sets implemented")
  ok(frontmatter(note()).fields.owner === undefined, "record releases the claim")
  const evidence = io.files["/p/.overwatch/evidence/Parser.json"] ?? ""
  ok(evidence.includes('"run"'), "evidence file written")
  ok(evidence.includes("bun test parser"), "evidence keeps the check")
  ok(evidence.includes('"commit": "' + commit + '"'), "evidence keeps the commit")

  // verify: same commit is current, a moved HEAD is stale, rerun re-runs the recorded check
  has((await unitVerify(io, EMPTY, { unit: "Parser" })).text, "current", "verify sees a current run")
  commit = "b".repeat(40)
  has((await unitVerify(io, EMPTY, { unit: "Parser" })).text, "stale", "verify sees a moved HEAD")
  has((await unitVerify(io, EMPTY, { unit: "Parser", rerun: true })).text, "upheld", "verify reruns the recorded check")

  console.log("vault check ok")
}

await main()
