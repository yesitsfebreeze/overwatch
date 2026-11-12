import type { Register } from "claude-code"
import { sessionIo as io, type Io } from "./io.ts"
import { clean, disk, MIN_MIB } from "./gardener.ts"
import { hygiene } from "./hygiene.ts"
import { loadout } from "./loadout.ts"
import { launch, launched } from "./launch.ts"
import { asBlock, checklist, evaluation, firedBy, learned, mistake, rate, report, scan, status, surface, tally, VERDICTS } from "./surface.ts"
import { TOOL_PREFIX, type ToolSpec } from "./catalog.ts"

/** One tool over one of overwatch's commands: its schema and what it runs. A thrown Error is an error result. */
type CommandTool = ToolSpec & { run: (io: Io, e: any) => Promise<string> }

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "")

/** The commands exposed as `mcp__overwatch__<name>`; bin/overwatch runs the same functions from a terminal. */
export const COMMAND_TOOLS: Record<string, CommandTool> = {
  checks: {
    description: "The checklist to run before saying a change is done: this repo's frozen test/lint/build commands plus the recorded mistakes to avoid. Run from the repo root. Read-only. Empty until scan froze the checks.",
    run: checklist,
  },
  scan: {
    description: "Discover this repo's test/lint/build commands (package.json scripts, Cargo.toml, go.mod, Makefile, justfile, pyproject.toml) and freeze them into .overwatch/checks.json for checks. A discovery pass, not law: a wrong guess is fixed by editing checks.json.",
    run: scan,
  },
  status: {
    description: "Git state, the frozen checks, what overwatch caught in the last 30 days, search-guard blocks and language servers over 500MB (orphaned rust-analyzer, tsserver …). Use when the machine feels loaded or before a long run. Read-only.",
    run: status,
  },
  report: {
    description: "What overwatch recorded in this project: how often each tool and shell binary fired, the verdicts given, the learned trigger lines, and the misbehaviour caught in the last 30 days (edits before a plan, stops with work open, invalid calls, failed turns) with the newest catches. Read-only.",
    run: report,
  },
  rate: {
    description: "Record a verdict on the tool the 'Evaluation due' question named, judged against the work actually done in this session. useful: it should have been reached here and was not (trigger required: that line ships into every later session). situational: correct to sit idle. dead: nothing needs it. With no basis to judge, say so as the reason; never invent a trigger.",
    properties: {
      name: { type: "string", description: "The tool or binary as the 'Evaluation due' question named it, e.g. \"WebFetch\" or \"sh:units\"." },
      verdict: { type: "string", enum: [...VERDICTS], description: "useful, situational or dead." },
      reason: { type: "string", description: "One line why, from this session's work." },
      trigger: { type: "string", description: "Required for useful: the situation that should have fired it, e.g. \"a unit conversion in a shell pipeline\"." },
    },
    required: ["name", "verdict", "reason"],
    run: (io, e) => rate(io, text(e.name), text(e.verdict), text(e.reason), text(e.trigger) || undefined),
  },
  mistake: {
    description: "Record a mistake that cost time twice, with the why, so every later session in this repo starts with it and every checklist carries it, e.g. \"ran the whole suite while a peer held the cargo lock: use the built test binary\". Not for typos. Writes .overwatch/mistakes.md in this directory.",
    properties: { text: { type: "string", description: "The mistake and what to do instead, one line." } },
    required: ["text"],
    run: (io, e) => mistake(io, text(e.text)),
  },
  loadout: {
    description: "Which Claude Code plugins are active per layer (global, each account, project, local) as one table. Cells: x enabled there, / inherited from global, * global and listed, . off. Read-only; print the table verbatim.",
    run: (io) => loadout(io),
  },
  hygiene_ledger: {
    description: "Lint and rank the skills in a repository's skills/ folder and write <repo>/LEDGER.md (ranking, duplicates, dependencies, findings). Returns the summary; read LEDGER.md for the tables. The hygiene skill covers judging the findings and syncing GitHub issues.",
    properties: { repo: { type: "string", description: "The folder that holds skills/; leave out for the current directory." } },
    run: async (io, e) => {
      const r = await hygiene(io, text(e.repo) ? [text(e.repo)] : [])
      if (r.code) throw new Error(r.text)
      return r.text
    },
  },
  disk: {
    description: "The disk gardener's survey: how full the disk is and what can go, each unit proven and judged. Leftover (idle temp entries, build output of projects not committed to for 30 days) and rebuildable (node_modules, target, .venv … with their manifest beside them) are what disk_clean deletes; in-use, kept and unverified units, caches with their owner's command, large files and what grew since the last survey are report-only. scope project (default, seconds) looks at the working directory, disk at the home folder, temp folders, caches and app data (minutes). Deletes nothing.",
    properties: {
      scope: { type: "string", enum: ["project", "disk"], description: "project: the working directory, the first step. disk: the whole disk, when the project did not free enough." },
      min_mib: { type: "number", description: `Smallest unit listed, in MiB. Default ${MIN_MIB}.` },
    },
    run: (io, e) => disk(io, e.scope === "disk" ? "disk" : "project", Number(e.min_mib) > 0 ? Number(e.min_mib) : MIN_MIB),
  },
  disk_clean: {
    description: "Delete paths the disk survey listed as leftover or rebuildable. Each path is judged again at this moment and refused unless it is a temp entry or proven build output that nothing uses: no link, no git-tracked file, no checkout with uncommitted or unpushed work inside, no open file, not changed in the last 2 hours, not in a kept project. A dry run unless apply is true; deletion is permanent. Returns one line per path and the free space before and after.",
    properties: {
      paths: { type: "array", items: { type: "string" }, minItems: 1, description: "Absolute paths, as the disk survey printed them." },
      apply: { type: "boolean", description: "true deletes; left out, it only says what would go." },
    },
    required: ["paths"],
    run: (io, e) => clean(io, (Array.isArray(e.paths) ? e.paths : []).map(text).filter(Boolean), e.apply === true),
  },
  launch: {
    description: "Run a shell command in the background and return at once with its id and log path, so builds, test suites, servers and anything slow never block you. Runs from the project directory; output goes to .overwatch/launch/<id>/log. Read it back with launched. wait: true runs it in the foreground instead (up to 10 minutes) and returns the exit code and output tail.",
    properties: {
      command: { type: "string", description: "The shell command, e.g. \"cargo build --release\"." },
      wait: { type: "boolean", description: "true blocks until it ends; left out, it runs in the background." },
    },
    required: ["command"],
    run: (io, e) => launch(io, text(e.command), e.wait === true),
  },
  launched: {
    description: "State of background runs started with launch: running, exit <code>, or gone. With an id: that run and the last 30 lines of its log. Without: the 10 newest runs, one line each. Read-only.",
    properties: { id: { type: "string", description: "The id launch returned; leave out to list runs." } },
    run: (io, e) => launched(io, text(e.id)),
  },
}

const SURFACE = { plugin: "overwatch", key: "surface" } as const

/**
 * The block added to this session's system prompt: the tool surface and the lessons
 * of earlier sessions. Built once from the session's tools (the request's and
 * `$.tool.list()`'s) and kept in $.state: a reload neither redraws the tool up for
 * rating nor changes the prompt mid-session.
 */
async function surfaceBlock($: any, offered: readonly string[]): Promise<string> {
  const { value } = await $.state.get(SURFACE)
  if (typeof value === "string") return value
  const [listed, at]: [string[], Io] = await Promise.all([$.tool.list().then((ts: { name: string }[]) => ts.map((t) => t.name), () => []), io($)])
  const parts = await Promise.all([surface(at, [...new Set([...offered, ...listed])]), learned(at)]).catch(() => undefined)
  if (parts === undefined) return "" // a failed build is retried on the next request, not cached
  const [{ sections, drawn }, lessons] = parts
  const block = [asBlock(sections), lessons].filter(Boolean).join("\n\n")
  // The rating question waits for takeEvaluation. An empty block is cached too: it is this session's answer.
  await Promise.all([$.state.set(SURFACE, block), drawn && $.state.set(EVALUATION, evaluation(drawn))])
  return block
}

/** Main-thread tool calls (shell binaries not counted twice) before the rating question rides a prompt. */
export const EVALUATE_AFTER_CALLS = 5
const EVALUATION = { plugin: "overwatch", key: "evaluation" } as const
const CALLS = { plugin: "overwatch", key: "calls" } as const

/** The rating question, once, on the first prompt after EVALUATE_AFTER_CALLS calls: a chat-only session is never asked. */
export async function takeEvaluation($: any): Promise<string | undefined> {
  const [{ value: text }, { value: calls }] = await Promise.all([$.state.get(EVALUATION), $.state.get(CALLS)])
  if (!text || (calls ?? 0) < EVALUATE_AFTER_CALLS) return undefined
  await $.state.set(EVALUATION, "")
  return text
}

/** The main thread's calls this turn, by tool and shell binary. */
let fired: Record<string, number> = {}

export function countCall(e: { tool: string; agentId?: string; command?: unknown }): void {
  if (!e.agentId) for (const n of firedBy(e.tool, e)) fired[n] = (fired[n] ?? 0) + 1
}

/** Folds the turn's counts into the ledger. */
export async function flushCalls($: any, e: { agentId?: string }): Promise<void> {
  if (e.agentId || !Object.keys(fired).length) return
  const batch = fired
  fired = {}
  const calls = Object.entries(batch).reduce((n, [k, c]) => (k.startsWith("sh:") ? n : n + c), 0)
  try { const { value } = await $.state.get(CALLS); await $.state.set(CALLS, (value ?? 0) + calls) } catch {}
  // Best-effort: a session that ended under it loses this turn's counts, never the hook.
  try { await tally(await io($), batch) } catch {}
}

export const register: Register = (on) => {
  // The surface block: after the cache boundary, naming only active tools.
  on("prompt.compose", async ($, e, next) => {
    const [r, block] = await Promise.all([next(e), surfaceBlock($, e.tools)])
    return block ? { ...r, sections: [...r.sections, { id: "overwatch:surface", text: block, scope: "session" as const }] } : r
  })

  for (const [name, t] of Object.entries(COMMAND_TOOLS))
    on("tool.call", { tool: TOOL_PREFIX + name }, async ($, e: any) => {
      try {
        return { result: (await t.run(await io($), e)) || "(no output)" }
      } catch (err: any) {
        return { result: String(err?.message ?? err), isError: true as const }
      }
    })
}
