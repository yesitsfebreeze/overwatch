// Run with bun test adapters/opencode/overwatch.check.ts; only the external SDK is stubbed.
import { expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

mock.module("@opencode/plugin", () => ({ Plugin: { define: (plugin: any) => plugin } }))
const { default: plugin } = await import("./index.ts")

async function session() {
  const dir = mkdtempSync(join(tmpdir(), "overwatch-opencode-"))
  const hooks: Record<string, (event: any) => Promise<void>> = {}
  const tools: Record<string, any> = {}
  const prompts: any[] = []
  let send!: (event: IteratorResult<any>) => void
  let consumed = () => {}
  const stop = await plugin.setup({
    location: { directory: dir },
    tool: { transform: async (f: any) => f({ add: (t: any) => { tools[t.name] = t } }) },
    permission: { hook: async () => {} },
    session: {
      hook: async (name: string, f: any) => { hooks[name] = f },
      prompt: async (input: any) => {
        prompts.push(input)
        // SessionPrompt from @opencode/plugin 2.0.14 carries the submitted metadata.
        await hooks.prompt({ sessionID: input.sessionID, messageID: `msg-${prompts.length}`, prompt: { text: input.text }, metadata: input.metadata })
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => {
        signal.addEventListener("abort", () => send({ done: true, value: undefined }))
        return {
          [Symbol.asyncIterator]() { return this },
          next() {
            const done = consumed
            consumed = () => {}
            done()
            return new Promise<IteratorResult<any>>((resolve) => { send = resolve })
          },
        }
      },
    },
  })
  return {
    prompts,
    call: (name: string, args: any) => tools[`overwatch_${name}`].execute(args),
    human: () => hooks.prompt({ sessionID: "session", messageID: "human", prompt: { text: "continue" } }),
    context: async () => {
      const event = { system: [] }
      await hooks.context(event)
      return event
    },
    idle: () => new Promise<void>((resolve) => {
      consumed = resolve
      send({ done: false, value: { type: "session.idle", data: { sessionID: "session" } } })
    }),
    close: () => {
      stop()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test("opencode: automatic prompts preserve the unchanged-stop cap; a human prompt resets it", async () => {
  const s = await session()
  try {
    await s.call("task_add", { titles: ["Finish the task"] })
    await s.human()
    for (let n = 0; n < 4; n++) {
      expect((await s.context()).system.length).toBe(1)
      await s.idle()
    }
    expect(s.prompts).toHaveLength(3)
    expect(s.prompts.every((p) => p.metadata?.overwatch === "continuation")).toBe(true)
    await s.human()
    await s.idle()
    expect(s.prompts).toHaveLength(4)
  } finally { s.close() }
})

test("opencode: changing progress cannot bypass the eight-continuation cap", async () => {
  const s = await session()
  try {
    await s.call("task_add", { titles: ["Finish the task"] })
    await s.human()
    for (let progress = 1; progress <= 9; progress++) {
      await s.call("task_progress", { task_id: 1, progress })
      await s.idle()
    }
    expect(s.prompts).toHaveLength(8)
    await s.human()
    await s.idle()
    expect(s.prompts).toHaveLength(9)
  } finally { s.close() }
})
