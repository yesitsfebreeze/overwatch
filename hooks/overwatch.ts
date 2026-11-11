import type { Register } from "claude-code"
import { register as componion } from "./componion.ts"
import { register as followline } from "./followline.ts"

// One hooks module per plugin: overwatch's parts register in order on the same `on`.
// followline first, so its $.followline.put exists before componion publishes a slot.
export const register: Register = async (on, options) => {
  await followline(on, options)
  await componion(on, options)
}
