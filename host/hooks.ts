/**
 * `overwatch hook <host> <event>`: one command hook for every host that runs shell
 * hooks. Reads the host's event JSON on stdin, maps it to an `Event`, answers in that
 * host's output shape. Fails open: a payload it cannot read lets the host go on.
 */
import type { Io } from "../hooks/io.ts"
import { onEvent, type Event, type Outcome } from "./core.ts"

type Kind = Event["kind"]
type Out = { text: string; code: number }
type Host = {
  /** Host event name → kind. */
  events: Record<string, Kind>
  /** The tool name in a pre-tool payload. */
  tool?: (p: any) => string
  render: (kind: Kind, o: Outcome, event: string) => Out
}

const none: Out = { text: "", code: 0 }
const json = (o: object): Out => ({ text: JSON.stringify(o), code: 0 })

/**
 * Claude Code's command-hook protocol, which Codex and Factory Droid follow too:
 * additionalContext through hookSpecificOutput, permissionDecision on PreToolUse,
 * decision "block" with a reason on Stop.
 */
const claudeShape = (events: Record<string, Kind>): Host => ({
  events,
  tool: (p) => p.tool_name ?? "",
  render: (kind, o, event) => {
    if (kind === "pre_tool")
      return o.deny ? json({ hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: o.deny } }) : none
    if (kind === "stop")
      return o.block ? json({ decision: "block", reason: o.block }) : o.notify ? json({ systemMessage: o.notify }) : none
    return o.context ? json({ hookSpecificOutput: { hookEventName: event, additionalContext: o.context } }) : none
  },
})

export const HOSTS: Record<string, Host> = {
  claude: claudeShape({ SessionStart: "start", UserPromptSubmit: "prompt", PreToolUse: "pre_tool", Stop: "stop" }),
  codex: claudeShape({ SessionStart: "start", UserPromptSubmit: "prompt", PreToolUse: "pre_tool", Stop: "stop" }),
  droid: claudeShape({ SessionStart: "start", UserPromptSubmit: "prompt", PreToolUse: "pre_tool", Stop: "stop" }),
  gemini: {
    events: { SessionStart: "start", BeforeAgent: "prompt", BeforeTool: "pre_tool", AfterAgent: "stop" },
    tool: (p) => p.tool_name ?? "",
    render: (kind, o, event) => {
      if (kind === "pre_tool") return o.deny ? json({ decision: "deny", reason: o.deny }) : none
      // AfterAgent: "deny" rejects the answer and sends the reason back as a new prompt.
      if (kind === "stop") return o.block ? json({ decision: "deny", reason: o.block }) : o.notify ? json({ systemMessage: o.notify }) : none
      return o.context ? json({ hookSpecificOutput: { hookEventName: event, additionalContext: o.context } }) : none
    },
  },
  copilot: {
    events: { sessionStart: "start", preToolUse: "pre_tool", agentStop: "stop" },
    tool: (p) => p.toolName ?? p.tool_name ?? "",
    // userPromptSubmitted output is dropped by the CLI, so the reminder rides sessionStart; agentStop blocks (the CLI ends after 8 blocks).
    render: (kind, o) => {
      if (kind === "pre_tool") return o.deny ? json({ permissionDecision: "deny", permissionDecisionReason: o.deny }) : none
      if (kind === "stop") return o.block ? json({ decision: "block", reason: o.block }) : none
      return o.context ? json({ additionalContext: o.context }) : none
    },
  },
  cursor: {
    events: { sessionStart: "start", preToolUse: "pre_tool", stop: "stop" },
    tool: (p) => p.tool_name ?? "",
    render: (kind, o) => {
      if (kind === "pre_tool") return o.deny ? json({ permission: "deny", user_message: o.deny, agent_message: o.deny }) : json({ permission: "allow" })
      // stop: a followup_message is sent as the next user message (Cursor caps the loop).
      if (kind === "stop") return o.block ? json({ followup_message: o.block }) : none
      // beforeSubmitPrompt cannot add context; the reminder rides sessionStart instead.
      return kind === "start" && o.context ? json({ additional_context: o.context }) : none
    },
  },
}

export async function hook(io: Io, hostName: string, event: string, stdin: string): Promise<Out> {
  const host = HOSTS[hostName]
  if (!host) return { text: `unknown host ${hostName}; known: ${Object.keys(HOSTS).join(", ")}`, code: 2 }
  const kind = host.events[event]
  if (!kind) return none
  let p: any = {}
  try { p = stdin.trim() ? JSON.parse(stdin) : {} } catch { return none }
  const cwd = p.cwd ?? p.workspace_roots?.[0] ?? io.cwd
  const e: Event =
    kind === "pre_tool" ? { kind, cwd, tool: host.tool?.(p) ?? "" } : kind === "prompt" ? { kind, cwd, person: true } : { kind, cwd }
  // Claude Code and Codex set stop_hook_active on a stop that a block already continued; the stop verdict's own caps end the loop.
  try {
    return host.render(kind, await onEvent(io, e), event)
  } catch (err: any) {
    return { text: `overwatch hook failed open: ${err?.message ?? err}`, code: 0 }
  }
}
