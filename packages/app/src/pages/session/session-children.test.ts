import { describe, expect, test } from "bun:test"
import type { Session } from "@open-agent-harness/sdk/v2/client"
import { childSessionCount, childSessions } from "./session-children"

const session = (input: { id: string; parentID?: string; archived?: boolean }): Session =>
  ({
    id: input.id,
    projectID: "project",
    directory: "/workspace",
    title: input.id,
    version: "dev",
    time: {
      created: 1,
      updated: 1,
      ...(input.archived ? { archived: 2 } : {}),
    },
    ...(input.parentID ? { parentID: input.parentID } : {}),
  }) as Session

describe("session children", () => {
  test("counts actual direct child sessions", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child-1", parentID: "root" }),
      session({ id: "child-2", parentID: "root" }),
      session({ id: "grand", parentID: "child-1" }),
      session({ id: "archived", parentID: "root", archived: true }),
      session({ id: "other-child", parentID: "other" }),
    ]

    expect(childSessions(sessions, "root").map((item) => item.id)).toEqual(["child-1", "child-2"])
    expect(childSessionCount(sessions, "root")).toBe(2)
  })

  test("does not read protocol run totals", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const ctx = {
      protocol: {
        runs: [
          {
            runID: "run",
            completed: 2,
            total: 2,
          },
        ],
      },
    }

    expect(ctx.protocol.runs[0]?.total).toBe(2)
    expect(childSessionCount(sessions, "root")).toBe(1)
  })
})
