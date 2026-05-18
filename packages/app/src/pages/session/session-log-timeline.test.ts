import { describe, expect, test } from "bun:test"
import type { SessionLogResponse } from "@opencode-ai/sdk/v2/client"
import { describeLog, mergeLogs } from "./session-log-timeline"

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

  test("merges records by id and orders the timeline by time", () => {
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

    expect(logs.map((log) => log.id)).toEqual(["a", "c", "b"])
    expect(logs.at(-1)?.data).toEqual({ hash: "new" })
  })
})
