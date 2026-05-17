import { describe, expect, test } from "bun:test"
import { Memory } from "../../src/memory"
import { ProjectID } from "../../src/project/schema"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { WorkspaceID } from "../../src/control-plane/schema"

describe("memory schema", () => {
  test("parses session memory records", () => {
    const now = Date.now()
    const item = Memory.Record.parse({
      id: Memory.ID.ascending(),
      kind: "session",
      privacy: "project",
      projectID: ProjectID.make("project"),
      workspaceID: WorkspaceID.ascending(),
      sessionID: SessionID.descending(),
      text: "Remember the architecture decision.",
      topics: ["architecture"],
      source: {
        sessionID: SessionID.descending(),
      },
      time: {
        created: now,
        updated: now,
      },
    })

    expect(item.kind).toBe("session")
    expect(item.topics).toEqual(["architecture"])
  })

  test("parses chunk memory records", () => {
    const sessionID = SessionID.descending()
    const chunk = Memory.Record.parse({
      id: Memory.ChunkID.ascending(),
      kind: "chunk",
      privacy: "session",
      projectID: ProjectID.make("project"),
      sessionID,
      text: "A compact chunk.",
      topics: ["chunk"],
      source: {
        sessionID,
        messageID: MessageID.ascending(),
        partID: PartID.ascending(),
        agent: "build",
      },
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
    })

    expect(chunk.kind).toBe("chunk")
    expect(chunk.source.agent).toBe("build")
  })
})
