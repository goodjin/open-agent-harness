import { describe, expect, test } from "bun:test"
import type { AuditRecord } from "@opencode-ai/sdk/v2/client"
import { describeLog, mergeLogs } from "./session-log-timeline"

const record = (id: string, time: number, event: AuditRecord["event"]): AuditRecord => ({
  id,
  time,
  projectID: "proj",
  sessionID: "ses",
  event,
})

describe("session log timeline", () => {
  test("describes permission and memory events", () => {
    expect(
      describeLog(
        record("a", 1, {
          type: "permission.asked",
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

    expect(describeLog(record("b", 2, { type: "memory.captured", count: 3 }))).toEqual({
      title: "Memory captured",
      detail: "3 memories",
      meta: [],
    })
  })

  test("merges records by id and orders the timeline by time", () => {
    const logs = mergeLogs(
      [
        record("b", 20, { type: "restore.completed", hash: "new" }),
        record("a", 10, { type: "memory.captured", count: 1 }),
      ],
      [
        record("b", 5, { type: "restore.completed", hash: "old" }),
        record("c", 15, { type: "workflow.completed", workflowID: "wf", runID: "run" }),
      ],
    )

    expect(logs.map((log) => log.id)).toEqual(["a", "c", "b"])
    expect(logs.at(-1)?.event).toEqual({ type: "restore.completed", hash: "new" })
  })
})
