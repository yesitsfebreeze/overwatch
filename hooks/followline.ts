import type { Register } from "claude-code"
import type { FollowlineSlot } from "../types/index.d.ts"

const SLOTS = { plugin: "overwatch", key: "slots" } as const

// Five moods, worst first, by the mean of the drawn gauges.
const FACES = [":(", ":/", ":|", ":)", ":D"]
export const face = (pct: number) => FACES[Math.max(0, Math.min(4, Math.floor(pct / 20)))]

type Seg = { text: string; color?: string; backgroundColor?: string; dimColor?: boolean }

// tmux-sys's gauge: `w` cells, fill on base16 slot 8, trough on slot 18 (base01),
// the percent centred. With `saved`, the fill covers `used` percent and the next
// `saved` percent take slot 3 (yellow): compaction's context kept, folded away and
// free. Slots, never hex: the terminal's base16 theme paints them.
export function gauge(pct: number, w = 10, used?: number, saved?: number): Seg[] {
  const c = (x: number) => Math.max(0, Math.min(100, Math.round(x)))
  const p = c(pct), t = `${p}%`, l = Math.floor((w - t.length) / 2)
  const n = Math.round((c(saved === undefined ? p : used ?? 0) * w) / 100)
  const m = saved === undefined ? n : Math.min(w, n + Math.round((c(saved) * w) / 100))
  const s = (" ".repeat(Math.max(0, l)) + t).padEnd(w)
  return [
    { text: s.slice(0, n), color: "ansi256(0)", backgroundColor: "ansi256(8)" },
    { text: s.slice(n, m), color: "ansi256(0)", backgroundColor: "ansi256(3)" },
    { text: s.slice(m), color: "ansi256(8)", backgroundColor: "ansi256(18)" },
  ].filter(x => x.text)
}

// The line: the face, then each slot named in `order` that has published.
export function line(slots: Record<string, FollowlineSlot>, order: readonly string[]): Seg[] {
  const shown = order.map(id => slots[id]).filter((s): s is FollowlineSlot => !!s)
  if (!shown.length) return []
  const mean = shown.reduce((a, s) => a + s.pct, 0) / shown.length
  const out: Seg[] = [{ text: face(mean) }]
  for (const s of shown) {
    out.push({ text: ` ${s.label ?? s.id} `, ...(s.color ? { color: s.color } : { dimColor: true }) }, ...gauge(s.pct, 10, s.used, s.saved))
    if (s.detail) out.push({ text: ` ${s.detail}`, dimColor: true })
  }
  return out
}

/** The `slots` setting as slot ids in draw order. */
export const slotOrder = (setting: unknown): string[] => [...new Set(String(setting ?? "").split(",").map(s => s.trim()).filter(Boolean))]

export const register: Register = (on, options) => {
  const order = slotOrder(options.slots)

  // $.followline.put is an event: the core answers nothing, this hook stores
  // the slot, so a producer's call redraws the line.
  on("engine.create", async (_, e, next) => ({ ...(await next(e)), followline: { put: async () => ({}) } }))
  on("followline.put", async ($, slot) => {
    const { value = {} } = await $.state.get(SLOTS)
    await $.state.set(SLOTS, { ...value, [slot.id]: slot })
    return { value: {} }
  })

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { value = {} } = await $.state.get(SLOTS)
    const segs = line(value, order)
    if (!segs.length) return next(e)
    const { Text } = $.ui.resolve(e)
    return Text({ wrap: "truncate", children: segs.map(({ text, ...style }) => Text({ ...style, children: text })) })
  })
}
