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

/** One task in the session's task view. */
export type Task = {
  /** Stable number; `replace` retires the old id and issues the next one. */
  id: number
  /** What the model distilled from the user's request, short. */
  title: string
  /** 0–100, the fill of the bar drawn beside the task. */
  progress: number
  /** `done` at 100, `active` while being worked, `todo` until first touched. */
  status: "todo" | "active" | "done"
}

/** One yes/no question about the finished work. */
export type Guard = {
  id: string
  question: string
  /** A shell command that decides it: exit 0 is upheld. Re-run at every stop, so a regression reopens it. */
  check?: string
  /** Files whose current content the judge sees, relative to the project. */
  files?: string[]
  /** Whether the last decision upheld it. A judged guard, once upheld, is retired. */
  met?: boolean
  /** The last decision: the check's exit code (null: did not finish) and output tail, or the judge's p. */
  last?: { exit?: number | null; p?: number; out?: string }
}

/** Tasks and guards: the whole plan the stop is held against. */
export type Plan = {
  tasks: Task[]
  nextId: number
  guards: Guard[]
}

/**
 * Whether changed code went through /code-review and /simplify. `dirty` is set
 * by the first file edit, which voids a pass run before it. `lines` sums the
 * lines the edit tools touched since /simplify last covered them and decides
 * whether /simplify is asked for; `unreviewed` is the same since /code-review.
 * New work after a skill ran starts that skill's count from 0. A stop that
 * passes clears all of it.
 */
export type Verify = { dirty: boolean; review: boolean; simplify: boolean; lines: number; unreviewed: number }

/** The stop bookkeeping: what the next stop compares against. */
export type StopBook = {
  /** The signature of what was still open at the last refused stop. */
  sig: string
  /** Consecutive refused stops with that signature unchanged. */
  stalls: number
  /** Refused stops since the user last spoke. */
  rounds: number
  /** The no-key notice is given once per session. */
  nokeyTold?: boolean
}

declare module "claude-code" {
  interface EngineInterface {
    followline: Followline
  }
  interface PluginState {
    overwatch: {
      slots: Record<string, FollowlineSlot>
      /** The session's tool-surface block, built once from its active tools; empty when there is none. */
      surface: string
      /** The rating question for the drawn tool, held until the session did real work; empty once delivered. */
      evaluation: string
      /** Main-thread tool calls this session, folded in once per turn. */
      calls: number
      /** The plan part: the plan, the review state, the stop bookkeeping and the session's start directory. */
      plan: Plan
      verify: Verify
      stop: StopBook
      root: string
      /** The plan part: the full reminder went out this session; later prompts carry one line. */
      told: boolean
      /** The tool catalog this session last declared (catalog.ts): its version, each tool's fingerprint, and a reload notice not yet delivered. */
      tools: { version: string; tools: Record<string, string>; notice?: string }
    }
  }
}
