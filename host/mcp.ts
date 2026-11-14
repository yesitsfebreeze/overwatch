/**
 * overwatch's tools as a stdio MCP server (newline-delimited JSON-RPC 2.0) for every host with an
 * MCP client. Hand-rolled: initialize, tools/list, tools/call and ping are the whole surface used.
 */
import type { Io } from "../hooks/io.ts"
import { callTool, schemaOf, TOOLS } from "./core.ts"
import pkg from "../package.json" with { type: "json" }
import { captureSyncRuntime, syncAutomatic, syncNotice } from "../hooks/sync.ts"

const initialized = new WeakSet<Io>()

type Req = { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: any }

async function answer(io: Io, req: Req): Promise<object | undefined> {
  const ok = (result: object) => ({ jsonrpc: "2.0", id: req.id, result })
  if (req.id === undefined || req.id === null) return undefined // a notification
  switch (req.method) {
    case "initialize": {
      const reason = initialized.has(io) ? "reconnect" : "initialize"
      const instructions = await syncAutomatic(io, { reason }).then(syncNotice, (e) => "[overwatch] synchronization failed: " + String(e?.message ?? e))
      initialized.add(io)
      return ok({
        protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "overwatch", version: pkg.version },
        ...(instructions ? { instructions } : {}),
      })
    }
    case "ping":
      return ok({})
    case "tools/list":
      return ok({ tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: schemaOf(t) })) })
    case "tools/call": {
      const r = await callTool(io, String(req.params?.name ?? ""), req.params?.arguments ?? {})
      return ok({ content: [{ type: "text", text: r.text }], isError: !!r.error })
    }
    default:
      return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } }
  }
}

export async function serve(io: Io): Promise<void> {
  await captureSyncRuntime(io).catch(() => {})
  const send = (o: object) => process.stdout.write(JSON.stringify(o) + "\n")
  let buf = ""
  // Calls answer in arrival order: the plan file is read-modify-write.
  let queue = Promise.resolve()
  for await (const chunk of process.stdin) {
    buf += chunk.toString()
    let nl: number
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      queue = queue.then(async () => {
        let req: Req
        try { req = JSON.parse(line) } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) }
        const out = await answer(io, req).catch((err) => ({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: String(err?.message ?? err) } }))
        if (out) send(out)
      })
    }
  }
  await queue
}
