// The bun side of hooks/io.ts: the same Io over node:fs and child processes, for the terminal.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import type { Io } from "../hooks/io.ts"

export function fromNode(cwd = process.cwd()): Io {
  const at = (p: string) => resolve(cwd, p)
  return {
    read: async (p) => { try { return readFileSync(at(p), "utf8") } catch { return undefined } },
    write: async (p, t) => { mkdirSync(dirname(at(p)), { recursive: true }); writeFileSync(at(p), t) },
    list: async (p) => {
      try {
        return readdirSync(at(p)).map((name) => {
          // statSync follows a link, so a linked skill or account folder lists as the dir it is.
          const s = (() => { try { return statSync(resolve(at(p), name)) } catch { return undefined } })()
          return { name, kind: s?.isFile() ? "file" : s?.isDirectory() ? "dir" : "other", mtimeMs: s?.isFile() ? s.mtimeMs : 0 }
        })
      } catch { return [] }
    },
    exists: async (p) => existsSync(at(p)),
    run: async (argv, init = {}) => {
      const r = spawnSync(argv[0]!, argv.slice(1), { cwd: init.cwd ? at(init.cwd) : cwd, input: init.stdin, timeout: init.timeoutMs ?? 30_000, encoding: "utf8", env: { ...process.env, ...init.env }, maxBuffer: 64 << 20 })
      const code = r.error ? ((r.error as any).code === "ETIMEDOUT" ? 124 : 127) : (r.status ?? 1)
      return { code, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error?.message ?? "") }
    },
    env: async (n) => process.env[n],
    cwd,
    // import.meta.dir is bun-only; pi and other node hosts load this module too.
    root: resolve((import.meta as any).dir ?? dirname(fileURLToPath(import.meta.url)), ".."),
  }
}
