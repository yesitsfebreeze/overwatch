/**
 * overwatch for pi: the plan and command tools as native pi tools, the plan reminder
 * before every run, the edit gate, and the stop hold (agent_before_settle continues the
 * run while tasks or guards are open). Same core as every other host (host/core.ts).
 * Install: `pi install <overwatch repo>` (package.json "pi") or `pi -e <this file>`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { fromNode } from "../../bin/node-io.ts"
import { callTool, onEvent, schemaOf, TOOLS } from "../../host/core.ts"

export default function overwatch(pi: ExtensionAPI) {
  const io = (cwd: string) => fromNode(cwd)

  for (const [name, spec] of Object.entries(TOOLS))
    pi.registerTool({
      name: `overwatch_${name}`,
      label: `overwatch ${name}`,
      description: spec.description,
      parameters: Type.Unsafe(schemaOf(spec)) as any,
      async execute(_id, params, _signal, _update, ctx) {
        const r = await callTool(io(ctx.cwd), name, (params ?? {}) as Record<string, unknown>)
        if (r.error) throw new Error(r.text)
        return { content: [{ type: "text", text: r.text }], details: undefined }
      },
    })

  pi.on("session_start", async (_e, ctx) => {
    ctx.ui.setStatus("overwatch", "overwatch")
  })

  pi.on("before_agent_start", async (e: any, ctx) => {
    const o = await onEvent(io(ctx.cwd), { kind: "prompt", cwd: ctx.cwd, person: e.messageType === "user" })
    return o.context ? { message: { customType: "overwatch", content: o.context, display: false } } : undefined
  })

  pi.on("tool_call", async (e, ctx) => {
    const o = await onEvent(io(ctx.cwd), { kind: "pre_tool", cwd: ctx.cwd, tool: e.toolName })
    return o.deny ? { block: true, reason: o.deny } : undefined
  })

  // The stop: an open plan continues the run with the reason; the verdict's own caps end a stuck loop.
  pi.on("agent_before_settle", async (e: any, ctx) => {
    if (String(e.outcome ?? "").includes("abort")) return undefined
    const o = await onEvent(io(ctx.cwd), { kind: "stop", cwd: ctx.cwd })
    if (o.notify) ctx.ui.notify?.(o.notify, "warning")
    return o.block ? { continue: true, entries: [{ type: "custom_message", customType: "overwatch", content: o.block, display: true }] } : undefined
  })
}
