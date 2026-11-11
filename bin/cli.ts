// overwatch's one binary: every command over the same modules the hooks run (hooks/*.ts), through the bun Io.
import { clean, disk } from "../hooks/gardener.ts"
import { hygiene } from "../hooks/hygiene.ts"
import { loadout } from "../hooks/loadout.ts"
import { checklist, index, mistake, rate, report, scan, status } from "../hooks/surface.ts"
import { fromNode } from "./node-io.ts"
import { serve } from "../host/mcp.ts"
import { hook } from "../host/hooks.ts"

const USAGE = `overwatch — the terminal side of the overwatch plugin (the same code its tools run)

  overwatch status                 git state, frozen checks, guard blocks, memory hogs
  overwatch scan                   discover this repo's checks and freeze them
  overwatch checks                 the frozen checks plus the mistakes to avoid
  overwatch mistake <text>         record one mistake, folded into every later checklist
  overwatch report                 tool-surface usage, verdicts, learned triggers
  overwatch index [--active]       the tool-surface block; --active reads a JSON list of tool names on stdin
  overwatch rate <name> <useful|situational|dead> <reason> [--trigger <situation>]
  overwatch loadout                active plugins per layer
  overwatch hygiene [repo] [--issues] [--selftest]   skill ledger for a repo's skills/
  overwatch disk [disk] [--min-mib <n>]   what can go: this project, or the whole disk
  overwatch disk-clean [--apply] <path…>  delete surveyed leftovers; a dry run without --apply
  overwatch mcp                    stdio MCP server with every overwatch tool (other agents)
  overwatch hook <host> <event>    command hook for another agent: host event JSON on stdin

State: .overwatch/ in the working directory (gitignore it).`

async function main(argv: string[]): Promise<{ text: string; code: number }> {
  const io = fromNode()
  const [act = "status", ...args] = argv
  const rest = args.join(" ")
  const ok = (text: string) => ({ text, code: 0 })
  switch (act) {
    case "status": return ok(await status(io))
    case "scan": return ok(await scan(io))
    case "checks": return ok(await checklist(io))
    case "mistake": return ok(await mistake(io, rest))
    case "report": return ok(await report(io))
    case "loadout": return ok(await loadout(io))
    case "hygiene": return hygiene(io, args)
    case "disk": {
      const m = args.indexOf("--min-mib")
      return ok(await disk(io, args[0] === "disk" ? "disk" : "project", m < 0 ? undefined : Number(args[m + 1]) || undefined))
    }
    case "disk-clean": return ok(await clean(io, args.filter((a) => a !== "--apply"), args.includes("--apply")))
    case "mcp": await serve(io); return { text: "", code: 0 }
    case "hook": return hook(io, args[0] ?? "", args[1] ?? "", await Bun.stdin.text())
    case "index": return ok(await index(io, args.includes("--active") ? JSON.parse(await Bun.stdin.text()) : undefined))
    case "rate": {
      const t = args.indexOf("--trigger")
      const [name = "", verdict = "", ...why] = t < 0 ? args : args.slice(0, t)
      return ok(await rate(io, name, verdict, why.join(" "), t < 0 ? undefined : args.slice(t + 1).join(" ")))
    }
    case "help": case "-h": case "--help": return ok(USAGE)
    default: return { text: `unknown command: ${act}\n\n${USAGE}`, code: 2 }
  }
}

main(process.argv.slice(2)).then(
  ({ text, code }) => { if (text) (code ? console.error : console.log)(text); process.exit(code) },
  (err) => { console.error(err?.message ?? String(err)); process.exit(1) },
)
