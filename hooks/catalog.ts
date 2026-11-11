/**
 * Every overwatch tool goes through one catalog, so a hot reload can never leave
 * an agent calling yesterday's schema unnoticed:
 *
 * - each tool's spec has a fingerprint, the catalog a version (both content hashes);
 * - `declare` (session.start, which a reload runs again) re-registers every tool,
 *   which the engine treats as a replacement visible from the next prompt on, and
 *   compares against the version stored for this session: a change leaves a notice
 *   naming the tools added, changed and removed;
 * - the notice rides the next prompt and the next overwatch tool result, once;
 * - every overwatch tool result carries the version stamp as context beside it;
 * - a call whose input does not fit the current schema (a missing or unknown
 *   argument, a wrong type, a value outside the enum) is refused with that schema,
 *   and a call to a tool the catalog dropped is refused with what is left.
 */
import { cmp } from "./io.ts"
import { incident } from "./incidents.ts"

export const TOOL_PREFIX = "mcp__overwatch__"

export type ToolSpec = { description: string; properties?: Record<string, any>; required?: readonly string[] }
type Stored = { version: string; tools: Record<string, string>; notice?: string }

const STATE = { plugin: "overwatch", key: "tools" } as const
/** Keys the engine sets on a call beside the arguments. */
const RESERVED = new Set(["tool", "tool_use_id", "consent", "agentId", "requestMeta"])

/** FNV-1a, 32 bit, hex: a content hash small enough to print in every result. */
export function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, "0")
}

export const schemaOf = (t: ToolSpec) => ({ type: "object", properties: t.properties ?? {}, ...(t.required?.length ? { required: [...t.required] } : {}) })

/** One tool's fingerprint; the order of keys in its source does not count. */
const fingerprint = (t: ToolSpec) => hash(JSON.stringify([t.description, schemaOf(t)], (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => cmp(a, b))) : v)))

const typeOk = (want: unknown, v: unknown) =>
  want === undefined ||
  (want === "string" && typeof v === "string") ||
  (want === "number" && typeof v === "number") ||
  (want === "integer" && Number.isInteger(v)) ||
  (want === "boolean" && typeof v === "boolean") ||
  (want === "array" && Array.isArray(v)) ||
  (want === "object" && !!v && typeof v === "object" && !Array.isArray(v))

/** Why `input` does not fit `spec`, or undefined when it does. Top level only: the shape a stale schema breaks. */
export function misfit(spec: ToolSpec, input: Record<string, unknown>): string | undefined {
  const props = spec.properties ?? {}
  for (const r of spec.required ?? []) if (input[r] === undefined) return `missing required \`${r}\``
  for (const [k, v] of Object.entries(input)) {
    if (RESERVED.has(k) || v === undefined) continue
    const p = props[k]
    if (!p) return `unknown argument \`${k}\``
    if (!typeOk(p.type, v)) return `\`${k}\` must be ${p.type}`
    if (p.enum && !p.enum.includes(v)) return `\`${k}\` must be one of ${p.enum.join(" | ")}`
  }
  return undefined
}

export type Catalog = ReturnType<typeof catalog>

/** The catalog over every part's tools, keyed by short name (no prefix). */
export function catalog(specs: Record<string, ToolSpec>) {
  const tools = Object.fromEntries(Object.entries(specs).map(([n, t]) => [n, fingerprint(t)]))
  const version = hash(Object.entries(tools).sort().map(([n, f]) => `${n}:${f}`).join(","))
  const stamp = `overwatch tools v${version}`

  /** What changed from the stored catalog to this one, or undefined when nothing did. */
  const diff = (old: Stored | undefined): string | undefined => {
    if (!old?.version || old.version === version) return undefined
    const names = (f: (n: string) => boolean, from: Record<string, string>) => Object.keys(from).filter(f).sort()
    const added = names((n) => !(n in old.tools), tools)
    const removed = names((n) => !(n in tools), old.tools)
    const changed = names((n) => n in old.tools && old.tools[n] !== tools[n], tools)
    const part = (label: string, ns: string[]) => (ns.length ? `${label} ${ns.map((n) => TOOL_PREFIX + n).join(", ")}` : "")
    const what = [part("changed", changed), part("added", added), part("removed", removed)].filter(Boolean).join("; ")
    return `[overwatch tools reloaded v${old.version} → v${version}: ${what || "descriptions only"}. The tool list now holds the current schemas: re-read them before the next call; a call on an old schema is refused with the new one.]`
  }

  return {
    version,
    stamp,
    specs,
    tools,
    diff,

    /** Refusal for a call that does not fit the catalog, or undefined to let it run. */
    refusal(e: Record<string, unknown> & { tool: string }): string | undefined {
      const name = e.tool.slice(TOOL_PREFIX.length)
      const spec = specs[name]
      if (!spec) return `${e.tool} is gone (${stamp}); overwatch has ${Object.keys(specs).map((n) => TOOL_PREFIX + n).join(", ")}`
      const why = misfit(spec, e)
      return why && `stale or invalid call to ${e.tool}: ${why}. Current schema (${stamp}): ${JSON.stringify(schemaOf(spec))}`
    },
  }
}

/**
 * A matched hook per catalog tool, registered before the parts' own: a stale call is
 * refused before the part sees it, and the result carries the stamp and any notice.
 */
export async function guardCall(c: Catalog, $: any, e: any, next: (e: any) => Promise<any>) {
  const deny = c.refusal(e)
  if (deny) {
    await incident($, "invalid_call", deny)
    return { deny }
  }
  const r = await next(e)
  // A refused call leaves the notice pending: it is taken only when it can ride a result.
  if (r?.deny !== undefined) return r
  const notice = await takeNotice($)
  // Beside the result, never in it: decompress and loadout answer text meant to be read back exactly.
  return { ...r, context: [...(r.context ?? []), ...(notice ? [notice] : []), c.stamp] }
}

/** Whether a notice waits in state; set by declareCatalog, which every load and reload runs at session.start. */
let pending = false

/** Registers every tool (a reload replaces them) and records a notice when the catalog changed. */
export async function declareCatalog($: any, c: Catalog): Promise<string | undefined> {
  const { value } = await $.state.get(STATE)
  const notice = c.diff(value as Stored | undefined) ?? (value as Stored | undefined)?.notice
  pending = !!notice
  await Promise.all([
    $.state.set(STATE, { version: c.version, tools: c.tools, ...(notice ? { notice } : {}) } satisfies Stored),
    ...Object.entries(c.specs).map(([name, t]) => $.tool.register({ name, description: `${t.description} (v${c.tools[name]})`, inputSchema: schemaOf(t) })),
  ])
  return notice
}

/** The pending reload notice, cleared: it is delivered once, to whichever comes first, a prompt or an overwatch tool result. */
export async function takeNotice($: any): Promise<string | undefined> {
  if (!pending) return undefined // the hot paths (every prompt, every overwatch call) skip the state read
  pending = false
  const { value } = await $.state.get(STATE)
  const v = value as Stored | undefined
  if (!v?.notice) return undefined
  const { notice, ...rest } = v
  await $.state.set(STATE, rest)
  return notice
}
