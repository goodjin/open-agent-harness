import { describe, expect, test } from "bun:test"
import type { PermissionRequest, Session } from "@open-agent-harness/sdk/v2/client"
import { trimSessions } from "./session-trim"

const session = (input: { id: string; parentID?: string; created: number; updated?: number; archived?: number }) =>
  ({
    id: input.id,
    parentID: input.parentID,
    time: {
      created: input.created,
      updated: input.updated,
      archived: input.archived,
    },
  }) as Session

describe("trimSessions", () => {
  test("keeps roots within the limit", () => {
    const now = 1_000_000
    const list = [
      session({ id: "a", created: now - 100_000 }),
      session({ id: "b", created: now - 90_000 }),
      session({ id: "c", created: now - 80_000 }),
      session({ id: "d", created: now - 70_000, updated: now - 1_000 }),
      session({ id: "e", created: now - 60_000, archived: now - 10 }),
    ]

    const result = trimSessions(list, { limit: 2, permission: {}, now })
    expect(result.map((x) => x.id)).toEqual(["a", "b"])
  })

  test("keeps children when root is kept, permission exists, or child is recent", () => {
    const now = 1_000_000
    const list = [
      session({ id: "root-1", created: now - 1000 }),
      session({ id: "root-2", created: now - 2000 }),
      session({ id: "z-root", created: now - 30_000_000 }),
      session({ id: "child-kept-by-root", parentID: "root-1", created: now - 20_000_000 }),
      session({ id: "child-kept-by-permission", parentID: "z-root", created: now - 20_000_000 }),
      session({ id: "child-kept-by-recency", parentID: "z-root", created: now - 500 }),
      session({ id: "child-trimmed", parentID: "z-root", created: now - 20_000_000 }),
    ]

    const result = trimSessions(list, {
      limit: 2,
      permission: {
        "child-kept-by-permission": [{ id: "perm-1" } as PermissionRequest],
      },
      now,
    })

    expect(result.map((x) => x.id)).toEqual([
      "child-kept-by-permission",
      "child-kept-by-recency",
      "child-kept-by-root",
      "root-1",
      "root-2",
    ])
  })

  test("keeps full descendant closure for retained sessions", () => {
    const now = 1_000_000
    const list = [
      session({ id: "root", created: now - 1000 }),
      session({ id: "z-root", created: now - 30_000_000 }),
      session({ id: "child", parentID: "root", created: now - 20_000_000 }),
      session({ id: "grand", parentID: "child", created: now - 20_000_000 }),
      session({ id: "perm", parentID: "z-root", created: now - 20_000_000 }),
      session({ id: "perm-grand", parentID: "perm", created: now - 20_000_000 }),
    ]

    const result = trimSessions(list, {
      limit: 1,
      permission: {
        perm: [{ id: "perm-1" } as PermissionRequest],
      },
      now,
    })

    expect(result.map((x) => x.id)).toEqual(["child", "grand", "perm", "perm-grand", "root"])
  })
})
