/**
 * overwatch for opencode 2.x (`@opencode/plugin`) over host/core.ts: the tools, the plan reminder in
 * every model request, the edit gate (permission "edit" denied while the plan is empty) and the stop
 * hold (on session.idle an open plan prompts the session again). opencode runs plugins on bun.
 */
import { Plugin } from "@opencode/plugin"
import { fromNode } from "../../bin/node-io.ts"
import { callTool, onEvent, schemaOf, TOOLS } from "../../host/core.ts"

export default Plugin.define({
  id: "overwatch",
  async setup(ctx: any) {
    const dir: string = ctx?.location?.directory ?? process.cwd()
    const io = fromNode(dir)

    await ctx.tool.transform((ed: any) => {
      for (const [name, spec] of Object.entries(TOOLS))
        ed.add({
          name: `overwatch_${name}`,
          description: spec.description,
          input: schemaOf(spec),
          execute: async (input: any) => {
            const r = await callTool(io, name, input ?? {})
            if (r.error) throw new Error(r.text)
            return { content: r.text }
          },
        })
    })

    // Only a human prompt resets the stop rounds; our continuations retain both caps.
    await ctx.session.hook("prompt", async (e: any) => {
      await onEvent(io, { kind: "prompt", cwd: dir, person: e.metadata?.overwatch !== "continuation" })
    })

    await ctx.session.hook("context", async (e: any) => {
      const o = await onEvent(io, { kind: "prompt", cwd: dir, person: false })
      if (o.context) e.system.push({ type: "text", text: o.context })
    })

    // edit, write and patch all ask for the "edit" permission.
    await ctx.permission.hook("evaluate", async (e: any) => {
      if (e.action !== "edit") return
      const o = await onEvent(io, { kind: "pre_tool", cwd: dir, tool: "edit" })
      if (o.deny) {
        e.effect = "deny"
        e.message = o.deny
      }
    })

    // No hook vetoes the end of a turn: on idle, an open plan sends the reason as the next prompt.
    // The verdict's caps (3 unchanged, 8 per prompt) end a stuck loop.
    const ac = new AbortController()
    ;(async () => {
      for await (const ev of ctx.event.subscribe({ signal: ac.signal, types: ["session.idle"] }) as AsyncIterable<any>) {
        if (ev?.type !== "session.idle") continue
        const o = await onEvent(io, { kind: "stop", cwd: dir })
        if (o.block) await ctx.session.prompt({ sessionID: ev.data.sessionID, text: o.block, metadata: { overwatch: "continuation" } }).catch(() => {})
      }
    })().catch(() => {})
    return () => ac.abort()
  },
})
