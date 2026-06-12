import { describe, expect, test } from "bun:test"
import type { SessionLogResponse } from "@open-agent-harness/sdk/v2/client"
import {
  compactLogs,
  describeLog,
  detailSections,
  duration,
  durationLabel,
  groupLogs,
  mergeLogs,
  preserveScroll,
  summarizeLogs,
} from "./session-log-timeline"

type Log = SessionLogResponse[number]

const record = (id: string, time: number, type: string, data: Log["data"]): Log => ({
  id,
  time,
  sessionID: "session",
  messageID: "message",
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
      title: "LLM Request",
      meta: [],
    })

    expect(describeLog(record("response", 4, "llm.finish", { finish: "tool-calls", cost: 0.0042 }))).toEqual({
      title: "LLM Response",
      meta: ["Tool call", "$0.0042"],
    })

    expect(describeLog(record("final", 5, "llm.finish", { finish: "stop", cost: 0.001 }))).toEqual({
      title: "LLM Response",
      meta: ["Final", "$0.0010"],
    })
  })

  test("splits llm request details into focused sections", () => {
    const sections = detailSections([
      record("llm", 3, "llm.start", {
        providerID: "openai",
        modelID: "gpt-test",
        messages: 4,
        tools: 2,
        request: {
          system: ["system prompt"],
          messages: [{ role: "user", content: "hello" }],
          user: { id: "msg_1", role: "user" },
          tools: ["bash", "edit"],
          toolChoice: "auto",
        },
      }),
    ])

    expect(sections.map((item) => item.id)).toEqual(["overview", "system", "messages", "user", "tools", "raw"])
    expect(sections.find((item) => item.id === "system")?.data).toEqual(["system prompt"])
    expect(sections.find((item) => item.id === "tools")?.data).toEqual({
      available: ["bash", "edit"],
      toolChoice: "auto",
    })
  })

  test("keeps model output out of llm request details", () => {
    const sections = detailSections([
      record("llm", 3, "llm.start", {
        providerID: "openai",
        modelID: "gpt-test",
        messages: 4,
        tools: 0,
        request: {},
      }),
      record("text", 4, "text.end", {
        text: [
          "Intro",
          "```json agent-protocol",
          JSON.stringify({ type: "agent.protocol.output", version: "1", intent: "respond" }),
          "```",
        ].join("\n"),
      }),
    ])

    expect(sections.map((item) => item.id)).toEqual(["overview", "system", "messages", "user", "tools", "raw"])
  })

  test("splits llm response details into response and token sections", () => {
    const sections = detailSections([
      record("reason", 2, "reasoning.end", {
        text: "I should answer directly.",
        chars: 25,
      }),
      record("text", 3, "text.end", {
        text: [
          "Intro",
          "```json agent-protocol",
          JSON.stringify({ type: "agent.protocol.output", version: "1", intent: "respond" }),
          "```",
        ].join("\n"),
      }),
      record("done", 4, "llm.finish", {
        finish: "tool-calls",
        cost: 0.0042,
        tokens: {
          input: 10,
          output: 20,
          reasoning: 5,
          cache: {
            read: 1,
            write: 2,
          },
        },
      }),
    ])

    expect(sections.map((item) => item.id)).toEqual(["overview", "text", "reasoning", "protocol", "tokens", "raw"])
    expect(sections.find((item) => item.id === "overview")?.data).toEqual({
      finish: "tool-calls",
      status: "Tool call",
      cost: 0.0042,
    })
    expect(sections.find((item) => item.id === "text")?.data).toContain("Intro")
    expect(sections.find((item) => item.id === "reasoning")?.data).toBe("I should answer directly.")
    expect(sections.find((item) => item.id === "protocol")?.data).toContain("agent.protocol.output")
    expect(sections.find((item) => item.id === "tokens")?.data).toEqual({
      input: 10,
      output: 20,
      reasoning: 5,
      cache: {
        read: 1,
        write: 2,
      },
    })
  })

  test("adds tool and step sections to llm response details", () => {
    const sections = detailSections([
      record("step", 2, "step.finish", { reason: "tool-calls", cost: 0.001 }),
      record("tool", 3, "tool.finish", { tool: "read", title: "Read file", callID: "call_1" }),
      record("done", 4, "llm.finish", { finish: "tool-calls" }),
    ])

    expect(sections.map((item) => item.id)).toEqual(["overview", "tools", "steps", "tokens", "raw"])
    expect(sections.find((item) => item.id === "tools")?.data).toEqual([
      {
        time: 3,
        type: "tool.finish",
        data: { tool: "read", title: "Read file", callID: "call_1" },
      },
    ])
    expect(sections.find((item) => item.id === "steps")?.data).toEqual([
      {
        time: 2,
        type: "step.finish",
        data: { reason: "tool-calls", cost: 0.001 },
      },
    ])
  })

  test("describes protocol events and counts internal tool calls separately", () => {
    expect(
      describeLog(
        record("p", 1, "protocol.action.completed", {
          runID: "apr_1",
          actionID: "inspect",
          operation: "search",
          status: "completed",
        }),
      ),
    ).toEqual({
      title: "Protocol action completed",
      detail: "inspect",
      meta: ["search", "apr_1"],
    })

    expect(
      summarizeLogs([
        record("a", 1, "tool.start", {}),
        record("b", 2, "tool.start", { protocol: true, actionID: "inspect", callID: "call_1", tool: "read" }),
        record("c", 3, "protocol.action.tool_call", { runID: "apr_1", callID: "call_1" }),
      ]),
    ).toMatchObject({ tools: 1, protocol: { runs: 1, internalTools: 1 } })

    expect(
      describeLog(record("t", 4, "tool.start", { protocol: true, actionID: "inspect", callID: "call_1", tool: "read" })),
    ).toEqual({
      title: "Protocol internal tool started",
      detail: "read",
      meta: ["inspect", "call_1"],
    })

    expect(describeLog(record("f", 5, "protocol.final.completed", { runID: "apr_1" }))).toEqual({
      title: "Protocol final response completed",
      detail: "apr_1",
      meta: [],
    })

    expect(describeLog(record("plain", 6, "protocol.final.plain", { runID: "apr_1" }))).toEqual({
      title: "Protocol final plain text",
      detail: "apr_1",
      meta: [],
    })

    expect(describeLog(record("bad", 7, "agent.metadata.output_validation_failed", { agent: "tester", status: "failed" }))).toEqual({
      title: "Protocol output validation failed",
      detail: "tester",
      meta: ["failed"],
    })
  })

  test("describes and filters session status transitions", () => {
    const logs = [
      record("a", 1, "session.status.changed", {
        from: "idle",
        to: "running",
        reason: "User submitted a prompt.",
      }),
      record("b", 2, "llm.start", {}),
      record("c", 3, "protocol.started", { runID: "apr_1" }),
    ]

    expect(describeLog(logs[0]!)).toEqual({
      title: "Session status changed",
      detail: "User submitted a prompt.",
      meta: ["idle -> running"],
    })
    expect(groupLogs(logs).map((row) => row.id)).toEqual(["b", "a"])
    expect(groupLogs(logs, "status").map((row) => row.id)).toEqual(["a"])
    expect(summarizeLogs(logs).status).toBe(1)
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

  test("keeps llm request and response as separate timeline rows", () => {
    const rows = groupLogs([
      record("a", 1, "llm.start", { providerID: "openai", modelID: "gpt", messages: 1, tools: 0 }),
      record("b", 2, "step.start", {}),
      record("c", 3, "reasoning.start", {}),
      record("d", 4, "reasoning.end", { chars: 12 }),
      record("e", 5, "text.start", {}),
      record("f", 6, "text.end", { chars: 4 }),
      record("g", 7, "llm.finish", { finish: "stop" }),
      { ...record("h", 8, "memory.captured", { count: 1 }), messageID: "other" },
    ])

    expect(rows.map((row) => [row.id, row.logs.length])).toEqual([
      ["h", 1],
      ["g", 6],
      ["a", 1],
    ])
  })

  test("hides protocol lifecycle noise unless protocol filter is active", () => {
    const logs = [
      record("a", 1, "protocol.started", { runID: "apr_1", title: "Run" }),
      record("b", 2, "protocol.completed", { runID: "apr_1" }),
      record("c", 3, "protocol.final.started", { runID: "apr_1" }),
      record("d", 4, "protocol.final.plain", { runID: "apr_1" }),
      record("e", 5, "protocol.final.completed", { runID: "apr_1" }),
      record("f", 6, "memory.captured", { count: 1 }),
      record("g", 7, "agent.metadata.output_validated", { agent: "tester" }),
    ]

    expect(groupLogs(logs).map((row) => [row.id, row.logs.map((log) => log.type)])).toEqual([
      ["f", ["memory.captured"]],
    ])
    expect(groupLogs(logs, "protocol").map((row) => row.id)).toEqual(["g", "e", "d", "c", "b", "a"])
  })

  test("keeps output validation diagnostics in the protocol timeline", () => {
    const logs = [
      record("a", 1, "protocol.action.completed", { runID: "apr_1", actionID: "ok" }),
      record("b", 2, "protocol.action.tool_call", { runID: "apr_1", callID: "call_1" }),
      record("c", 3, "protocol.action.failed", { runID: "apr_1", actionID: "bad" }),
      record("d", 4, "tool.finish", { protocol: true, callID: "call_1", tool: "read" }),
      record("e", 5, "tool.error", { protocol: true, callID: "call_2", tool: "read", error: "boom" }),
      record("f", 6, "agent.metadata.output_validation_failed", { agent: "tester" }),
    ]

    expect(groupLogs(logs).map((row) => row.id)).toEqual(["e", "c", "b"])
    expect(groupLogs(logs, "protocol").map((row) => row.id)).toEqual(["f", "e", "d", "c", "b", "a"])
  })

  test("compacts start end lifecycle pairs in details", () => {
    const logs = [
      record("a", 1, "llm.start", { providerID: "openai", modelID: "gpt", messages: 1, tools: 0 }),
      record("b", 2, "step.start", { snapshot: "snap" }),
      record("c", 3, "step.finish", { reason: "stop", cost: 0.01 }),
      record("d", 4, "text.start", { partID: "part" }),
      record("e", 5, "text.end", { partID: "part", chars: 12 }),
      record("f", 6, "llm.finish", { finish: "stop" }),
    ]

    expect(compactLogs(logs).map((item) => [item.type, item.logs.length, item.summary.title])).toEqual([
      ["llm.start", 1, "LLM Request"],
      ["step.start", 2, "Step"],
      ["text.start", 2, "Text"],
      ["llm.finish", 1, "LLM Response"],
    ])
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
      protocol: {
        runs: 0,
        internalTools: 0,
      },
      status: 0,
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

  test("formats row durations from explicit metrics or event span", () => {
    expect(duration([record("a", 1, "protocol.action.completed", { durationMs: 42 })])).toBe(42)
    expect(duration([
      record("a", 10, "llm.start", {}),
      record("b", 30, "llm.finish", {}),
    ])).toBe(20)
    expect(durationLabel(42)).toBe("42ms")
    expect(durationLabel(1200)).toBe("1.2s")
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
