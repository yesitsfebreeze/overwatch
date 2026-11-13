/**
 * The one door overwatch's logic has to the machine. The hooks module has no Node
 * (everything goes through `$`); the CLI runs under bun. Each part's logic takes an
 * `Io` and runs unchanged in both: `sessionIo($)` in a hook, `fromNode()`
 * (bin/node-io.ts) in a terminal.
 */
/** The environment variables overwatch reads; a new one is added here and in engineEnv. */
type EnvName = "HOME" | "XDG_STATE_HOME" | "CLAUDE_CONFIG_DIR" | "TMPDIR"
export type Run = { code: number; stdout: string; stderr: string; timedOut?: boolean }
export type Entry = { name: string; kind: "file" | "dir" | "other"; mtimeMs: number }
/** Runs argv; never rejects: a failure to start is code 127, a timeout has timedOut=true (code 124 is not proof of timeout). */
export type Runner = (argv: readonly string[], init?: { cwd?: string; stdin?: string; timeoutMs?: number; env?: Record<string, string> }) => Promise<Run>

export type Io = {
  /** The file's text, or undefined when it is missing or unreadable. */
  read(path: string): Promise<string | undefined>
  /** Writes the whole file, creating its directories. */
  write(path: string, text: string): Promise<void>
  /** A directory's entries; empty when it is missing. A symbolic link has the kind of what it leads to. */
  list(path: string): Promise<Entry[]>
  exists(path: string): Promise<boolean>
  run: Runner
  /** Only the names in EnvName: the engine reads each by its literal name (engineEnv). */
  env(name: EnvName): Promise<string | undefined>
  /** The directory relative paths resolve against: the session's, or the shell's. */
  cwd: string
  /** The plugin's own folder (data/, skills/). */
  root: string
}

export const join = (...parts: string[]) => parts.filter(Boolean).join("/").replace(/\/{2,}/g, "/")
/** The one string order (sorts, stable output). */
export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** A JSON file's value, or `fallback` when it is missing or not JSON. */
export async function readJson<T>(io: Io, path: string, fallback: T): Promise<T> {
  try { return JSON.parse((await io.read(path)) ?? "") ?? fallback } catch { return fallback }
}

export const abs = (io: Io, p: string) => (p.startsWith("/") ? p : join(io.cwd, p))

/** Probed on native Windows, where the engine's PATH has no `sh`: the Git installs' own shells, which find their msys runtime through their install prefix. */
const WINDOWS_SH = ["C:\\Program Files\\Git\\bin\\sh.exe", "C:\\Program Files (x86)\\Git\\bin\\sh.exe"] as const
let shellProbed: Promise<readonly string[]> | undefined

/** Tests only: forget the probe so the next `shellArgv` re-probes. */
export const resetShellArgv = () => { shellProbed = undefined }

/**
 * The argv prefix that runs a POSIX `-c` script: `sh`, or on native Windows the
 * first Git `sh` the host can start. Probed once per process. `sh` stays the last
 * resort, so a machine with no shell reports the same failure as before.
 */
export function shellArgv(run: Runner): Promise<readonly string[]> {
  shellProbed ??= (async () => {
    for (const sh of ["sh", ...WINDOWS_SH]) if ((await run([sh, "-c", "true"], { timeoutMs: 5_000 })).code === 0) return [sh]
    return ["sh"]
  })()
  return shellProbed
}

/** All of overwatch's working data, inside the working directory: nothing goes to the home folder. */
export const STATE_DIR = ".overwatch"
/** The spec vault folder under STATE_DIR, the one part git tracks. */
export const VAULT_DIR = "vault"
export const state = (io: Io, ...parts: string[]) => join(io.cwd, STATE_DIR, ...parts)

/**
 * The line that asks the agent to gitignore the state folder but keep the spec vault
 * (.overwatch/vault) tracked; empty outside a git repo and once both hold
 * (`git check-ignore -q`: 0 ignored, 1 not ignored, 128 no repo). A plain `.overwatch/`
 * line hides the vault for good (git cannot re-include under an excluded folder), so it is
 * asked to become `.overwatch/*`. A shell command, so the edit gate does not ask for a plan first.
 */
export async function ignoreHint(io: Io): Promise<string> {
  const ignored = async (p: string) => (await io.run(["git", "check-ignore", "-q", p], { timeoutMs: 5000 })).code
  const state = await ignored(`${STATE_DIR}/plan.json`)
  if (state === 1) return `[overwatch] overwatch keeps its working data in \`${STATE_DIR}/\` in this directory, and git does not ignore it yet. Ignore it now, before anything else, keeping the spec vault tracked: \`printf '\\n${STATE_DIR}/*\\n!${STATE_DIR}/vault/\\n' >> .gitignore\`.`
  if (state === 0 && (await io.exists(join(io.cwd, STATE_DIR, "vault"))) && (await ignored(`${STATE_DIR}/vault/Home.md`)) === 0)
    return `[overwatch] .gitignore hides the spec vault \`${STATE_DIR}/vault/\`. Keep it tracked, before anything else: replace the \`${STATE_DIR}/\` line with \`${STATE_DIR}/*\` and \`!${STATE_DIR}/vault/\`.`
  return ""
}

/** The session's Io in a hook. A function declaration: the one form `$` may be handed to. */
export async function sessionIo($: any): Promise<Io> {
  return fromEngine($, await $.session.cwd())
}

/** `$.process.run` as a `Runner`. */
export function engineRun($: any): Runner {
  return (argv, init = {}) =>
    $.process.run(argv, init).then(
      (r: any) => ({ code: r.exitCode ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }),
      (err: any) => {
        const timedOut = err?.code === "ETIMEDOUT" || /timed? ?out/i.test(String(err?.message))
        return { code: timedOut ? 124 : 127, stdout: "", stderr: String(err?.message ?? err), timedOut }
      },
    )
}

function fromEngine($: any, cwd: string): Io {
  const run = engineRun($)
  return {
    read: (p) => $.fs.read(p).then((t: unknown) => (typeof t === "string" ? t : undefined), () => undefined),
    write: (p, t) => $.fs.write(p, t),
    list: (p) => engineList($, p),
    exists: (p) => $.fs.exists(p).catch(() => false),
    run: (argv, init) => run(argv, { cwd, ...init }),
    env: (n) => engineEnv($, n),
    cwd,
    root: $.plugin.root,
  }
}

/** `$.fs.list`, a link resolved to the kind it leads to (skills and accounts are often linked in). */
async function engineList($: any, path: string): Promise<Entry[]> {
  const es: any[] = await $.fs.list(path).catch(() => [])
  return Promise.all(
    es.map(async ({ name, kind, mtimeMs, isLink }) => ({
      name,
      kind: isLink ? await $.fs.stat(`${path}/${name}`, { resolve: true }).then((s: any) => s.kind, () => "other") : kind,
      mtimeMs,
    })),
  )
}

/** The engine lists the variables a module reads, so each is read by its literal name; any other reads as unset. */
async function engineEnv($: any, name: EnvName): Promise<string | undefined> {
  switch (name) {
    case "HOME": return $.env.get("HOME")
    case "XDG_STATE_HOME": return $.env.get("XDG_STATE_HOME")
    case "CLAUDE_CONFIG_DIR": return $.env.get("CLAUDE_CONFIG_DIR")
    case "TMPDIR": return $.env.get("TMPDIR")
  }
}

/** Which of `names` are on PATH, in one shell. */
export async function onPath(io: Io, names: readonly string[]): Promise<Set<string>> {
  const safe = names.filter((n) => /^[\w.+-]+$/.test(n))
  if (!safe.length) return new Set()
  const r = await io.run([...await shellArgv(io.run), "-c", 'for b; do command -v "$b" >/dev/null 2>&1 && echo "$b"; done', "sh", ...safe])
  return new Set(r.stdout.split("\n").filter(Boolean))
}

/** Today in UTC, the form every note date, ledger stamp and changelog section uses. */
export function today(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/** An Io over a map of absolute paths to text: tests and hygiene's selftest. */
export function memIo(files: Record<string, string>, cwd = "/mem", runner?: Runner): Io & { files: Record<string, string> } {
  const dirOf = (p: string) => p.replace(/\/+$/, "") + "/"
  return {
    files,
    read: async (p) => files[p],
    write: async (p, t) => void (files[p] = t),
    list: async (p) => {
      const pre = dirOf(p)
      const seen = new Map<string, Entry>()
      for (const f of Object.keys(files)) {
        if (!f.startsWith(pre)) continue
        const [head, ...rest] = f.slice(pre.length).split("/")
        seen.set(head, { name: head, kind: rest.length ? "dir" : "file", mtimeMs: 0 })
      }
      return [...seen.values()]
    },
    exists: async (p) => p in files || Object.keys(files).some((f) => f.startsWith(dirOf(p))),
    run: runner ?? (async () => ({ code: 127, stdout: "", stderr: "no processes in memory" })),
    env: async () => undefined,
    cwd,
    root: cwd,
  }
}
