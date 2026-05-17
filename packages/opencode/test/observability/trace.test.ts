import { afterEach, describe, expect, test } from "bun:test"
import { Trace } from "../../src/observability/trace"
import { Instance } from "../../src/project/instance"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await resetDatabase()
  await Instance.disposeAll()
})

describe("observability traces", () => {
  test("tool call spans can be children of prompt loop spans", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Trace.clear()
        await Trace.run("session.prompt.loop", { sessionID: "ses_trace" }, async () => {
          await Trace.run("tool.call", { tool: "bash", sessionID: "ses_trace" }, async () => "ok")
        })

        const spans = Trace.list()
        const root = spans.find((span) => span.name === "session.prompt.loop")
        const child = spans.find((span) => span.name === "tool.call")

        expect(root?.time.end).toBeNumber()
        expect(child?.time.end).toBeNumber()
        expect(child?.parentID).toBe(root?.id)
      },
    })
  })
})
