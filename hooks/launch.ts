import { shellArgv, state, type Io } from "./io.ts"

/**
 * Background commands: `launch` starts a shell command detached and returns at once, so a
 * build or a long test run never blocks the agent; `launched` reads its state and log back.
 * Each run keeps `cmd`, `pid`, `log` and `exit` in .overwatch/launch/<id>/.
 * Ceiling: nothing wakes the agent when a run ends, it polls `launched`; old runs are never
 * pruned (delete .overwatch/launch/ by hand). Upgrade: a host notification on the exit file.
 */
const DIR = "launch"
const TAIL = 30
const LIST = 10
/** `wait: true` runs in the foreground, bounded like a shell tool call. */
const WAIT_MS = 10 * 60_000

/**
 * $1 the command, $2 the run folder. nohup and the closed stdio let this shell exit at once
 * while the run goes on; the inner shell writes the exit code when the command ends.
 */
const START = `mkdir -p "$2" && nohup sh -c 'sh -c "$1" >"$2/log" 2>&1 </dev/null; echo $? >"$2/exit"' sh "$1" "$2" >/dev/null 2>&1 </dev/null & echo $!`

const ago = (ms: number) => { const s = Math.round(ms / 1000); return s < 120 ? `${s}s` : `${Math.round(s / 60)}m` }

/** Ids are base-36 start times, so they sort and date themselves. */
const startedAt = (id: string) => parseInt(id, 36)

export async function launch(io: Io, command: string, wait = false): Promise<string> {
  if (!command) throw new Error("launch needs a command")
  const sh = await shellArgv(io.run)
  if (wait) {
    const r = await io.run([...sh, "-c", command], { timeoutMs: WAIT_MS })
    // 124 = the runner's timeout code (io.ts Runner).
    return `${r.code === 124 ? "did not finish" : `exit ${r.code}`}\n${tail(r.stdout + r.stderr)}`.trim()
  }
  const id = Date.now().toString(36)
  const dir = state(io, DIR, id)
  await io.write(`${dir}/cmd`, command)
  const r = await io.run([...sh, "-c", START, "sh", command, dir], { timeoutMs: 10_000 })
  const pid = r.stdout.trim()
  if (r.code !== 0 || !/^\d+$/.test(pid)) throw new Error(`launch failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`)
  await io.write(`${dir}/pid`, pid)
  return `launched id ${id} (pid ${pid}) in the background: ${command}\nlog ${dir}/log\nIt does not block: keep working and read it back with launched {id: "${id}"}.`
}

const tail = (text: string) => text.trimEnd().split("\n").slice(-TAIL).join("\n")

/** running, exit <code>, or gone: the process ended without writing its exit code (killed). */
async function runState(io: Io, dir: string): Promise<string> {
  const exit = (await io.read(`${dir}/exit`))?.trim()
  if (exit) return `exit ${exit}`
  const pid = (await io.read(`${dir}/pid`))?.trim()
  if (!pid) return "starting"
  return (await io.run(["kill", "-0", pid], { timeoutMs: 5000 })).code === 0 ? "running" : "gone (killed, no exit code)"
}

/** One run in full with its log tail, or the newest runs one line each. */
export async function launched(io: Io, id = ""): Promise<string> {
  const now = Date.now()
  if (id) {
    const dir = state(io, DIR, id)
    const cmd = await io.read(`${dir}/cmd`)
    if (cmd === undefined) throw new Error(`no launched run ${id}; launched without an id lists them`)
    // `tail`, not a read: a build log can be larger than anything worth loading.
    const [log, st] = await Promise.all([io.run(["tail", "-n", String(TAIL), `${dir}/log`], { timeoutMs: 5000 }), runState(io, dir)])
    return `${id} ${st}, started ${ago(now - startedAt(id))} ago: ${cmd}\nlog ${dir}/log, last ${TAIL} lines:\n${log.stdout.trimEnd() || "(empty)"}`
  }
  const ids = (await io.list(state(io, DIR))).filter((e) => e.kind === "dir").map((e) => e.name).sort((a, b) => startedAt(b) - startedAt(a)).slice(0, LIST)
  if (!ids.length) return "nothing launched in this project yet"
  const rows = await Promise.all(ids.map(async (i) => {
    const dir = state(io, DIR, i)
    const [st, cmd] = await Promise.all([runState(io, dir), io.read(`${dir}/cmd`)])
    return `${i}  ${st}  ${ago(now - startedAt(i))} ago  ${cmd?.split("\n")[0] ?? ""}`
  }))
  return rows.join("\n")
}
