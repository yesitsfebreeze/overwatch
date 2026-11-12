/**
 * The note layer the spec vault and its PRDs share: the YAML subset in frontmatter, `## section`
 * read/replace, UTC dates, note-name rules, and the string/list coercion every tool argument
 * goes through. One format, so a note written by unit_new reads the same as one from prd_add.
 */
import { today, type Io } from "./io.ts"
import { trimmed } from "./plan.ts"

// --- frontmatter: the YAML subset the vault uses (scalars, inline and block lists) ---

const FRONT = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
export type Value = string | number | boolean | null | Value[]
export type Fields = Record<string, Value>

function splitList(inner: string): string[] {
  const items: string[] = []
  let current = "", quote: string | null = null
  for (const c of inner) {
    if (quote) { current += c; if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") { quote = c; current += c; continue }
    if (c === ",") { items.push(current); current = ""; continue }
    current += c
  }
  items.push(current)
  return items.map((s) => s.trim()).filter(Boolean)
}

function scalar(value: string): Value {
  const v = value.trim()
  if (v.startsWith("[") && v.endsWith("]")) return splitList(v.slice(1, -1)).map(scalar)
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v) } catch { return v.slice(1, -1) }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  if (/^-?\d+$/.test(v)) return Number(v)
  if (v === "true") return true
  if (v === "false") return false
  if (v === "" || v === "null" || v === "~") return null
  return v
}

export function serialize(value: Value | undefined): string {
  if (Array.isArray(value)) return `[${value.map(serialize).join(", ")}]`
  if (value === null || value === undefined) return ""
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  const s = String(value)
  const plain = s !== "" && !/^[\s\-?:,\[\]{}#&*!|>'"%@`]/.test(s) && !/[:#]\s|:$/.test(s) && !/\s$/.test(s) &&
    !/^(?:true|false|null|~|-?\d+(?:\.\d+)?)$/.test(s) && !/[\r\n,]/.test(s)
  return plain ? s : JSON.stringify(s)
}

export function frontmatter(text: string): { fields: Fields; end: number } {
  const m = FRONT.exec(text)
  if (!m) return { fields: {}, end: 0 }
  const lines = m[1].split(/\r?\n/)
  const fields: Fields = {}
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(lines[i])
    if (!kv) continue
    const value = (kv[2] ?? "").trim()
    if (value === "") {
      const items: Value[] = []
      while (i + 1 < lines.length && /^\s*-\s/.test(lines[i + 1])) items.push(scalar(lines[++i].replace(/^\s*-\s/, "")))
      fields[kv[1]] = items.length ? items : null
    } else fields[kv[1]] = scalar(value)
  }
  return { fields, end: m[0].length }
}

/** Replace, add (value) or remove (null) frontmatter keys; everything else is kept byte for byte. */
export function patchFrontmatter(text: string, changes: Record<string, Value | undefined>): string {
  const nl = text.includes("\r\n") ? "\r\n" : "\n"
  const m = FRONT.exec(text)
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : ""
  const lines = m ? m[1].split(/\r?\n/) : []
  const body = m ? text.slice(m[0].length) : text.replace(/^\uFEFF/, "")
  for (const [key, value] of Object.entries(changes)) {
    const index = lines.findIndex((line) => {
      if (!line.startsWith(`${key}:`)) return false
      const next = line[key.length + 1]
      return next === undefined || /\s/.test(next)
    })
    if (index >= 0) {
      let end = index + 1
      while (end < lines.length && /^\s*-\s/.test(lines[end])) end++
      if (value === null || value === undefined) lines.splice(index, end - index)
      else lines.splice(index, end - index, `${key}: ${serialize(value)}`)
    } else if (value !== null && value !== undefined) lines.push(`${key}: ${serialize(value)}`)
  }
  return `${bom}---${nl}${lines.join(nl)}${nl}---${nl}${body}`
}

// --- sections ---

const heading = (name: string) => new RegExp(`^## ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "m")

/** The body of `## name` up to the next `## ` heading, or undefined when the note has none. */
export function section(text: string, name: string): string | undefined {
  const m = heading(name).exec(text)
  if (!m) return undefined
  const rest = text.slice(m.index + m[0].length)
  const next = /^## /m.exec(rest)
  return (next ? rest.slice(0, next.index) : rest).replace(/^\r?\n/, "").replace(/\s+$/, "")
}

/** Replaces the body of `## name`, or appends the section when the note has none. */
export function replaceSection(text: string, name: string, body: string): string {
  const nl = text.includes("\r\n") ? "\r\n" : "\n"
  const m = heading(name).exec(text)
  if (!m) return `${text.replace(/\s+$/, "")}${nl}${nl}## ${name}${nl}${nl}${body}${nl}`
  const start = m.index + m[0].length
  const next = /^## /m.exec(text.slice(start))
  const end = next ? start + next.index : text.length
  return `${text.slice(0, start)}${nl}${nl}${body}${nl}${next ? nl : ""}${text.slice(end)}`
}

// --- values, names and dates ---

/** The one checklist line: `- [ ] text`, shared by the vault Plan, PRD acceptance and the changelog. */
export const CHECKBOX = /^\s*- \[([ xX])\] (.+?)\s*$/

export function checkbox(line: string): { done: boolean; text: string } | undefined {
  const m = CHECKBOX.exec(line)
  return m ? { done: m[1] !== " ", text: m[2]!.trim() } : undefined
}

export const strings = (v: Value | undefined): string[] => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map(String).filter(Boolean)
export const str = (v: Value | undefined) => (v == null ? "" : String(v))

/** A tool-argument list: one entry per value, trimmed, blanks dropped. `collapse` folds inner whitespace so a value cannot split a note line. */
export function toList(v: unknown, collapse = false): string[] {
  const one = (x: unknown): string => {
    const s = typeof x === "string" ? x : x == null ? "" : String(x)
    return collapse ? s.replace(/\s+/g, " ").trim() : trimmed(s)
  }
  return (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map(one).filter(Boolean)
}

/** Today in UTC, the form every note's date and updated field uses. */
export { today } from "./io.ts"

/** Characters Obsidian refuses in a note name, and the leading . or _ it hides. */
export const BAD_NAME = /[\\/:*?"<>|#^[\]]/
export const badName = (title: string) => !title || BAD_NAME.test(title) || /^[._]/.test(title)
export const NAME_RULE = `none of \\ / : * ? " < > | # ^ [ ]; not starting with . or _`

/** One note from a template: {{title}} and {{date}}, frontmatter fields, then section bodies. */
export async function writeNote(io: Io, n: {
  template: string
  file: string
  title: string
  /** How the refusal names the existing note, e.g. `01 Specs/Parser.md`. */
  exists: string
  fields?: Record<string, Value | undefined>
  sections?: Record<string, string | undefined>
}): Promise<void> {
  if (await io.exists(n.file)) throw new Error(`${n.exists} exists; edit it instead`)
  // The date pass runs before the title pass, so a title containing `$&` or `{{date}}` is never
  // read as a replacement pattern or re-substituted.
  let text = n.template.replaceAll("{{date}}", today()).replaceAll("{{title}}", () => n.title)
  if (n.fields && Object.keys(n.fields).length) text = patchFrontmatter(text, n.fields)
  for (const [name, body] of Object.entries(n.sections ?? {})) if (body) text = replaceSection(text, name, body)
  await io.write(n.file, text)
}
