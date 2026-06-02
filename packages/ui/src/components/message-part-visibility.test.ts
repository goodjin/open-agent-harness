import { describe, expect, test } from "bun:test"
import type { Part as PartType } from "@open-agent-harness/sdk/v2"
import { partView } from "./message-part-view"

const text = (input: { ignored?: boolean; text?: string }) =>
  ({
    id: "prt_text",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "text",
    text: input.text ?? "hello",
    ignored: input.ignored,
  }) as PartType

const reasoning = () =>
  ({
    id: "prt_reason",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "reasoning",
    text: "I should inspect the code.",
  }) as PartType

const tool = (name: string) =>
  ({
    id: "prt_tool",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    tool: name,
    state: {
      status: "completed",
      input: {},
      output: "",
    },
  }) as PartType

describe("partView", () => {
  test("keeps normal text visible", () => {
    expect(partView(text({}))).toEqual({ kind: "visible" })
  })

  test("collapses ignored text instead of hiding it", () => {
    expect(partView(text({ ignored: true }))).toEqual({ kind: "collapsed", reason: "ignored_text" })
  })

  test("collapses reasoning when summaries are disabled", () => {
    expect(partView(reasoning(), false)).toEqual({ kind: "collapsed", reason: "reasoning" })
  })

  test("keeps internal todo tools hidden", () => {
    expect(partView(tool("todowrite"))).toEqual({ kind: "hidden" })
  })
})
