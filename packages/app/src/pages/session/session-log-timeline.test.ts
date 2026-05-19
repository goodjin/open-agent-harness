import { describe, expect, test } from "bun:test"
import type { SessionLogResponse } from "@opencode-ai/sdk/v2/client"
import { describeLog, mergeLogs, preserveScroll, summarizeLogs } from "./session-log-timeline"

type Log = SessionLogResponse[number]

const record = (id: string, time: number, type: string, data: Log["data"]): Log => ({
  id,
  time,
  sessionID: "session",
  level: "info",
  type,
  data,
})

describe("session log timeline", () => {
  test("describes permission and memory events", () => {
    expect(
      describeLog(
        record("a", 1, "permission.asked", {
          requestID: "perm",
          permission: "bash",
          patternCount: 2,
          patternHash: "hash",
          patternKinds: ["command", "path"],
        }),
      ),
    ).toEqual({
      title: "Permission requested",
      detail: "bash",
      meta: ["2 patterns", "command, path"],
    })

    expect(describeLog(record("b", 2, "memory.captured", { count: 3 }))).toEqual({
      title: "Memory captured",
      detail: "3 memories",
      meta: [],
    })
  })

  test("describes detailed llm events", () => {
    expect(
      describeLog(
        record("llm", 3, "llm.start", {
          providerID: "openai",
          modelID: "gpt-test",
          messages: 4,
          tools: 2,
          request: {
            system: ["system prompt"],
            messages: [{ role: "user", content: "hello" }],
          },
        }),
      ),
    ).toEqual({
      title: "LLM request started",
      detail: "openai / gpt-test",
      meta: ["4 messages", "2 tools"],
    })
  })

  test("merges records by id and orders the timeline newest first", () => {
    const logs = mergeLogs(
      [
        record("b", 20, "restore.completed", { hash: "new" }),
        record("a", 10, "memory.captured", { count: 1 }),
      ],
      [
        record("b", 5, "restore.completed", { hash: "old" }),
        record("c", 15, "workflow.completed", { workflowID: "wf", runID: "run" }),
      ],
    )

    expect(logs.map((log) => log.id)).toEqual(["b", "c", "a"])
    expect(logs[0].data).toEqual({ hash: "new" })
  })

  test("summarizes requests tools and token usage", () => {
    expect(
      summarizeLogs([
        record("a", 1, "llm.start", {}),
        record("b", 2, "llm.start", {}),
        record("c", 3, "tool.start", {}),
        record("d", 4, "tool.start", {}),
        record("e", 5, "tool.finish", {}),
        record("f", 6, "step.finish", {
          tokens: {
            input: 100,
            output: 20,
            reasoning: 5,
            total: 140,
            cache: {
              read: 10,
              write: 5,
            },
          },
        }),
        record("g", 7, "step.finish", {
          tokens: {
            input: 50,
            output: 30,
            reasoning: 10,
            cache: {
              read: 20,
              write: 10,
            },
          },
        }),
      ]),
    ).toEqual({
      requests: 2,
      tools: 2,
      tokens: {
        input: 150,
        output: 50,
        reasoning: 15,
        total: 260,
        cache: {
          read: 30,
          write: 15,
        },
      },
    })
  })

  test("preserves scroll position when new logs are inserted above the viewport", async () => {
    const scroller = {
      scrollTop: 80,
      scrollHeight: 300,
    }
    preserveScroll(scroller, () => {
      scroller.scrollHeight = 360
    })
    await Promise.resolve()
    expect(scroller.scrollTop).toBe(140)
  })

  test("keeps scroll at top when user is watching newest logs", async () => {
    const scroller = {
      scrollTop: 0,
      scrollHeight: 300,
    }
    preserveScroll(scroller, () => {
      scroller.scrollHeight = 360
    })
    await Promise.resolve()
    expect(scroller.scrollTop).toBe(0)
  })
})
