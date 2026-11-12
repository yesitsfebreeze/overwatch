import { abs, cmp, join, readJson, type Io } from "./io.ts"

/**
 * Which plugins are active per layer: global | each account | project | local.
 * Global = BASE in ~/.claude/setup-plugins.sh, else the managed-settings.json it renders.
 * Accounts = ~/.claude/<name>/settings.json (root = default; '*' marks the current one).
 * Project/local = ./.claude/settings*.json.
 * Cells: x enabled here, / inherited from global, * global and also enabled here, . off.
 */

/** What Claude Code applies; differs from BASE until the sudo cp ran. */
const INSTALLED = "/Library/Application Support/ClaudeCode/managed-settings.json"

async function enabled(io: Io, p: string): Promise<Set<string>> {
  const plugins: Record<string, unknown> = (await readJson<any>(io, p, {}))?.enabledPlugins ?? {}
  return new Set(Object.keys(plugins).filter((k) => plugins[k]))
}

/** BASE from setup-plugins.sh; null when the script or the variable is missing. */
async function base(io: Io, root: string): Promise<Set<string> | null> {
  const m = (await io.read(join(root, "setup-plugins.sh")))?.match(/^BASE="([^"]*)"/m)
  return m ? new Set(m[1].split(/\s+/).filter(Boolean)) : null
}

const minus = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).length
const norm = (p: string) => p.replace(/\/+$/, "")

/** The table, plus a `global not installed` line when the applied managed file lags BASE. */
export async function loadout(io: Io): Promise<string> {
  const root = join((await io.env("HOME")) ?? "", ".claude")
  const cur = norm((await io.env("CLAUDE_CONFIG_DIR")) ?? root)
  const glob = (await base(io, root)) ?? (await enabled(io, join(root, "managed-settings.json")))
  const accounts: string[] = []
  for (const e of (await io.list(root)).sort((a, b) => cmp(a.name, b.name)))
    if (e.kind === "dir" && (await io.exists(join(root, e.name, "settings.json")))) accounts.push(e.name)
  const cols: [string, Set<string>][] = [["global", glob]]
  for (const name of ["", ...accounts]) {
    const d = name ? join(root, name) : root
    cols.push([(name || "default") + (norm(d) === cur ? "*" : ""), await enabled(io, join(d, "settings.json"))])
  }
  cols.push(["project", await enabled(io, abs(io, ".claude/settings.json"))])
  cols.push(["local", await enabled(io, abs(io, ".claude/settings.local.json"))])

  const all = [...new Set(cols.flatMap(([, s]) => [...s]))]
  const cell = (p: string, s: Set<string>, i: number) =>
    i === 0 ? (s.has(p) ? "x" : ".") : glob.has(p) ? (s.has(p) ? "*" : "/") : s.has(p) ? "x" : "."
  const sig = (p: string) => cols.map(([, s], i) => cell(p, s, i)).join("")
  const dots = (p: string) => sig(p).split(".").length - 1
  const rows = all.sort((a, b) => dots(a) - dots(b) || cmp(sig(a), sig(b)) || cmp(a, b)) // widest first
  const w = Math.max(6, ...all.map((p) => p.length))
  const out = [`${"plugin".padEnd(w)}  ` + cols.map(([n]) => n.padStart(8)).join(" ")]
  for (const p of rows) out.push(`${p.padEnd(w)}  ` + [...sig(p)].map((c) => c.padStart(8)).join(" "))
  const installed = await enabled(io, INSTALLED)
  if (minus(glob, installed) || minus(installed, glob))
    out.push(`global not installed: ${minus(glob, installed)} to add, ${minus(installed, glob)} to drop. Run the sudo line from: sh ~/.claude/setup-plugins.sh`)
  return out.join("\n")
}
