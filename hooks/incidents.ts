/**
 * The incident ledger: every time overwatch catches an agent misbehaving (an edit
 * before a plan, a stop with work open, a call that does not fit its schema, a turn
 * with failed tool calls) the catch is recorded, and a kind that keeps happening
 * rides every later session's prompt as one lesson line. That is the loop:
 * catch → record → remind.
 *
 * State: .overwatch/incidents.json in the working directory, counts per day plus the
 * newest entries. Ceiling: read-modify-write with no lock, so two sessions recording
 * in the same millisecond can lose one count; move to an append-only log once `Io`
 * has an append.
 */
import { readJson, sessionIo, state, type Io } from "./io.ts"

/** What is caught. `lesson` is the line a repeat offence adds to the prompt; a kind without one is only counted. */
export const KINDS = {
  unplanned_edit: { label: "edit before a plan", lesson: "Plan before the first file change: task_add and guard_add first, then edit." },
  early_stop: { label: "stop with work open", lesson: "Before ending a turn: complete every task, confirm the guards with guard_check, run the review pass that is due." },
  stalled: { label: "gave up with work open", lesson: "Stuck on an open task or a failing guard: ask the user, do not stop on the same open items again." },
  invalid_call: { label: "call that did not fit the tool's schema", lesson: "Read an overwatch tool's current schema before calling it." },
  failed_turn: { label: "turn with failed tool calls", lesson: "" },
} as const
export type Kind = keyof typeof KINDS

/** A kind caught this often inside the window is a habit: its lesson goes into the prompt. */
export const REPEAT_AT = 3
export const WINDOW_DAYS = 30
const RECENT_MAX = 40

export type Incident = { at: string; kind: Kind; detail: string }
export type Incidents = { days: Record<string, Partial<Record<Kind, number>>>; recent: Incident[] }

const path = (io: Io) => state(io, "incidents.json")
const day = (d: Date) => d.toISOString().slice(0, 10)
/** The last day outside the window: a day counts while it is later. */
const oldest = (now: Date) => day(new Date(now.getTime() - WINDOW_DAYS * 86_400_000))

export async function load(io: Io): Promise<Incidents> {
  const raw = await readJson<any>(io, path(io), {})
  return { days: raw.days ?? {}, recent: Array.isArray(raw.recent) ? raw.recent : [] }
}

/** The ledger with one more incident: days past the window and entries past RECENT_MAX fall out. */
export function add(st: Incidents, kind: Kind, detail: string, now = new Date()): Incidents {
  const today = day(now)
  const days = Object.fromEntries(Object.entries(st.days).filter(([d]) => d > oldest(now)))
  days[today] = { ...days[today], [kind]: (days[today]?.[kind] ?? 0) + 1 }
  const entry: Incident = { at: now.toISOString(), kind, detail: detail.replace(/\s+/g, " ").trim().slice(0, 200) }
  return { days, recent: [...st.recent, entry].slice(-RECENT_MAX) }
}

/** Records one catch. Best-effort: recording never breaks the hook that caught it. */
export async function note(io: Io, kind: Kind, detail = ""): Promise<void> {
  try {
    await io.write(path(io), JSON.stringify(add(await load(io), kind, detail), null, 1) + "\n")
  } catch { /* the catch itself already happened; only its record is lost */ }
}

/** `note` from a hook; a function declaration, the one form `$` may be handed to. */
export async function incident($: any, kind: Kind, detail = ""): Promise<void> {
  try { await note(await sessionIo($), kind, detail) } catch { /* best-effort */ }
}

/** Catches per kind inside the window, most frequent first. */
export function totals(st: Incidents, now = new Date()): [Kind, number][] {
  const sum: Partial<Record<Kind, number>> = {}
  for (const [d, counts] of Object.entries(st.days))
    if (d > oldest(now)) for (const [k, n] of Object.entries(counts)) if (k in KINDS) sum[k as Kind] = (sum[k as Kind] ?? 0) + (n ?? 0)
  return (Object.entries(sum) as [Kind, number][]).sort((a, b) => b[1] - a[1])
}

/** One lesson line per habit: what the prompt carries so the next session does better. */
export const lessons = (st: Incidents, now = new Date()): string[] =>
  totals(st, now).filter(([k, n]) => n >= REPEAT_AT && KINDS[k].lesson).map(([k, n]) => `- ${KINDS[k].lesson} (caught ${n}× in ${WINDOW_DAYS} days)`)

/** The counts in one line, for status. */
export const tallyLine = (st: Incidents, now = new Date()): string => {
  const t = totals(st, now)
  return t.length ? `caught (${WINDOW_DAYS} days): ${t.map(([k, n]) => `${KINDS[k].label} ${n}`).join(" · ")}` : `caught (${WINDOW_DAYS} days): nothing`
}

/** Counts plus the newest catches, for report. */
export const incidentReport = (st: Incidents, now = new Date()): string =>
  [tallyLine(st, now), ...st.recent.slice(-8).reverse().map((i) => `  ${i.at.slice(0, 16).replace("T", " ")} ${KINDS[i.kind]?.label ?? i.kind}${i.detail ? `: ${i.detail}` : ""}`)].join("\n")
