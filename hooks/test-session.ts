/**
 * Session tests run only under the plugin harness (`claude plugin test .`): it supplies the
 * `$` fixture and the `on(event, handler)` registrar. Plain `bun test` resolves
 * `claude-code/testing` to bun:test, which passes bun's `done` as the first argument and no
 * `on` at all. The harness runs tests in a sandbox with no `process` global, so its absence
 * marks the harnessed run; everywhere else these tests are skipped, not failed.
 */
import { test } from "claude-code/testing"

const anyTest = test as any

/** A session test: the same signature bun:test takes, plus the harness's fixture arguments. */
export const session: (name: string, ...rest: any[]) => any =
  typeof process === "undefined" ? (name, ...rest) => anyTest(name, ...rest) : (name, ...rest) => anyTest.skip(name, ...rest)
