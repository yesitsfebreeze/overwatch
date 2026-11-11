/**
 * The one door overwatch's logic has to the machine. The hooks module runs with
 * no Node (everything goes through `$`); the CLI runs under bun. Each part's
 * logic takes an `Io` and so runs, unchanged, in both: `fromEngine($)` in a hook,
 * `fromNode()` (bin/node-io.ts) in a terminal.
 */
/** The environment variables overwatch reads; a new one is added here and in engineEnv. */
export type EnvName = "HOME" | "XDG_STATE_HOME" | "CLAUDE_CONFIG_DIR" | "HYGIENE_TRANSCRIPTS"
export type Run = { code: number; stdout: string; stderr: string }
export type Entry = { name: string; kind: "file" | "dir" | "other"; mtimeMs: number }

export type Io = {
  /** The file's text, or undefined when it is missing or unreadable. */
  read(path: string): Promise<string | undefined>
  /** Writes the whole file, creating its directories. */
  write(path: string, text: string): Promise<void>
  /** A directory's entries; empty when it is missing. A symbolic link has the kind of what it leads to. */
  list(path: string): Promise<Entry[]>
  exists(path: string): Promise<boolean>
  /** Runs argv; never rejects (a failure to start is code 127, a timeout 124). */
  run(argv: readonly string[], init?: { cwd?: string; stdin?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<Run>
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

/** The `Io` over the engine's `$`, for hooks. */
export function fromEngine($: any, cwd: string): Io {
  return {
    read: (p) => $.fs.read(p).then((t: unknown) => (typeof t === "string" ? t : undefined), () => undefined),
    write: (p, t) => $.fs.write(p, t),
    list: (p) => engineList($, p),
    exists: (p) => $.fs.exists(p).catch(() => false),
    run: (argv, init = {}) =>
      $.process.run(argv, { cwd: init.cwd ?? cwd, ...init }).then(
        (r: any) => ({ code: r.exitCode ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }),
        (err: any) => ({ code: /timed? ?out/i.test(String(err?.message)) ? 124 : 127, stdout: "", stderr: String(err?.message ?? err) }),
      ),
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

/**
 * The engine lists the variables a module reads, so each is read by its literal
 * name; a name not listed here reads as unset.
 */
async function engineEnv($: any, name: EnvName): Promise<string | undefined> {
  switch (name) {
    case "HOME": return $.env.get("HOME")
    case "XDG_STATE_HOME": return $.env.get("XDG_STATE_HOME")
    case "CLAUDE_CONFIG_DIR": return $.env.get("CLAUDE_CONFIG_DIR")
    case "HYGIENE_TRANSCRIPTS": return $.env.get("HYGIENE_TRANSCRIPTS")
  }
}

/** Which of `names` are on PATH, in one shell. */
export async function onPath(io: Io, names: readonly string[]): Promise<Set<string>> {
  const safe = names.filter((n) => /^[\w.+-]+$/.test(n))
  if (!safe.length) return new Set()
  const r = await io.run(["sh", "-c", 'for b; do command -v "$b" >/dev/null 2>&1 && echo "$b"; done', "sh", ...safe])
  return new Set(r.stdout.split("\n").filter(Boolean))
}

/** An Io over a map of absolute paths to text: tests and hygiene's selftest. */
export function memIo(files: Record<string, string>, cwd = "/mem"): Io & { files: Record<string, string> } {
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
    run: async () => ({ code: 127, stdout: "", stderr: "no processes in memory" }),
    env: async () => undefined,
    cwd,
    root: cwd,
  }
}
