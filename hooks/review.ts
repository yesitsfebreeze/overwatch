import type { Verify } from "../types/index.d.ts"
import type { Io } from "./io.ts"
import { CLEAN, LARGE_CHANGE_LINES, edited } from "./plan.ts"

const lines = (s: string) => s ? s.match(/[^\n]*\n|[^\n]+$/g)! : []

/** Net line changes, exact below the review threshold; bounded Myers avoids quadratic work on rewrites. */
export function lineChanges(before: string, after: string): number {
  if (before === after) return 0
  const a = lines(before), b = lines(after)
  let start = 0, endA = a.length, endB = b.length
  while (start < endA && start < endB && a[start] === b[start]) start++
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const n = endA - start, m = endB - start, delta = Math.abs(n - m)
  if (delta >= LARGE_CHANGE_LINES) return LARGE_CHANGE_LINES
  let previous = new Map<number, number>([[1, 0]])
  for (let d = 0; d < 2 * LARGE_CHANGE_LINES; d++) {
    const current = new Map<number, number>()
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (previous.get(k - 1) ?? -1) < (previous.get(k + 1) ?? -1))
        ? (previous.get(k + 1) ?? 0) : (previous.get(k - 1) ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[start + x] === b[start + y]) { x++; y++ }
      if (x >= n && y >= m) return Math.min(LARGE_CHANGE_LINES, (d + delta) / 2)
      current.set(k, x)
    }
    previous = current
  }
  return LARGE_CHANGE_LINES
}

function pathKey(path: string, cwd: string): string {
  const p = path.replaceAll("\\", "/")
  const full = /^(?:\/|[A-Za-z]:\/)/.test(p) ? p : `${cwd.replaceAll("\\", "/")}/${p}`
  const parts: string[] = []
  for (const part of full.split("/")) {
    if (part === "." || (!part && parts.length)) continue
    if (part === "..") { if (parts.length > 1) parts.pop(); continue }
    parts.push(part)
  }
  return parts.join("/")
}

export function editPaths(input: any, cwd: string): string[] {
  const paths = new Set<string>()
  const visit = (i: any, inherited?: string) => {
    const path = i?.file_path ?? i?.path ?? i?.notebook_path ?? inherited
    if (typeof path === "string" && path) paths.add(pathKey(path, cwd))
    for (const list of [i?.items, i?.edits]) if (Array.isArray(list)) for (const item of list) visit(item, path)
  }
  visit(input)
  return [...paths]
}

type Snapshot = Record<string, string | undefined>
async function snapshot(io: Pick<Io, "read" | "exists">, paths: string[]): Promise<Snapshot> {
  return Object.fromEntries(await Promise.all(paths.map(async (path) => {
    try {
      const text = await io.read(path)
      return [path, text === undefined && !(await io.exists(path)) ? "" : text]
    } catch { return [path, undefined] }
  })))
}

export function measured(v: Verify, before: Snapshot, after: Snapshot, failed = false): Verify {
  const files = { ...v.files }
  let changed = false, unknown = !Object.keys(before).length && !failed
  for (const [path, old] of Object.entries(before)) {
    const current = after[path]
    if (old === undefined || current === undefined) { unknown = true; continue }
    if (old === current) continue
    changed = true
    files[path] = { ...(files[path] ?? { review: old, simplify: old }), current }
  }
  if (!changed && !unknown) return v
  const base = v.dirty ? v : CLEAN
  let count = 0, unreviewed = 0
  for (const f of Object.values(files)) {
    count = Math.min(LARGE_CHANGE_LINES, count + lineChanges(f.simplify, f.current))
    unreviewed = Math.min(LARGE_CHANGE_LINES, unreviewed + lineChanges(f.review, f.current))
  }
  return { ...edited(base, count, unreviewed), files, ...(unknown ? { unknown: { review: true, simplify: true } } : {}) }
}

/** Read after even a thrown/failed call: partial writes still need review. */
export async function trackEdit<T>(io: Pick<Io, "read" | "exists" | "cwd">, input: unknown, next: () => Promise<T>, record: (before: Snapshot, after: Snapshot, failed: boolean) => Promise<unknown>): Promise<T> {
  const paths = editPaths(input, io.cwd), before = await snapshot(io, paths)
  let failed = true
  try {
    const result: any = await next()
    failed = result?.deny !== undefined || result?.isError === true
    return result
  } finally { await record(before, await snapshot(io, paths), failed) }
}
