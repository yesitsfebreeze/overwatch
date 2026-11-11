/** One gauge: `pct` 0–100 is how well this plugin did the last turn. */
export type FollowlineSlot = {
  /** The slot id, matched against the `slots` setting. */
  id: string
  /** The label drawn before the gauge; the id when absent. */
  label?: string
  pct: number
  /** An ANSI colour name for the label (`yellow` to watch, `red` to act). */
  color?: "green" | "yellow" | "red"
  /** With `saved`: the percent of the gauge filled, instead of `pct`. */
  used?: number
  /** Percent of the gauge after the fill drawn in the savings colour (base16 yellow). */
  saved?: number
  /** Dim text drawn after the gauge, e.g. `48k now · 1000k window`. */
  detail?: string
}

export type Followline = {
  /** Publish or replace one slot; the line redraws. */
  put: (slot: FollowlineSlot) => Promise<{}>
}

declare module "claude-code" {
  interface EngineInterface {
    followline: Followline
  }
  interface PluginState {
    overwatch: { slots: Record<string, FollowlineSlot> }
  }
}
