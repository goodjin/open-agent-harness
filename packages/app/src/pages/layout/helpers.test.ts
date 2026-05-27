import { describe, expect, test } from "bun:test"
import {
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  drainPendingDeepLinks,
  parseDeepLink,
  parseNewSessionDeepLink,
} from "./deep-links"
import { type Message, type Session } from "@open-agent-harness/sdk/v2/client"
import {
  childSessionSummary,
  displayName,
  displaySessionTitle,
  childMapByParent,
  effectiveSessionExpansion,
  effectiveWorkspaceOrder,
  errorMessage,
  hasProjectPermissions,
  latestRootSession,
  sessionLineage,
  visibleSessionTree,
  workspaceKey,
} from "./helpers"

const session = (input: Partial<Session> & Pick<Session, "id" | "directory">) =>
  ({
    title: "",
    version: "v2",
    parentID: undefined,
    messageCount: 0,
    permissions: { session: {}, share: {} },
    time: { created: 0, updated: 0, archived: undefined },
    ...input,
  }) as Session

const message = (input: Partial<Message> & Pick<Message, "id" | "sessionID">) =>
  ({
    role: "assistant",
    time: { created: 0, completed: undefined },
    ...input,
  }) as Message

describe("layout deep links", () => {
  test("parses open-project deep links", () => {
    expect(parseDeepLink("opencode://open-project?directory=/tmp/demo")).toBe("/tmp/demo")
  })

  test("ignores non-project deep links", () => {
    expect(parseDeepLink("opencode://other?directory=/tmp/demo")).toBeUndefined()
    expect(parseDeepLink("https://example.com")).toBeUndefined()
  })

  test("ignores malformed deep links safely", () => {
    expect(() => parseDeepLink("opencode://open-project/%E0%A4%A%")).not.toThrow()
    expect(parseDeepLink("opencode://open-project/%E0%A4%A%")).toBeUndefined()
  })

  test("parses links when URL.canParse is unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(URL, "canParse")
    Object.defineProperty(URL, "canParse", { configurable: true, value: undefined })
    try {
      expect(parseDeepLink("opencode://open-project?directory=/tmp/demo")).toBe("/tmp/demo")
    } finally {
      if (original) Object.defineProperty(URL, "canParse", original)
      if (!original) Reflect.deleteProperty(URL, "canParse")
    }
  })

  test("ignores open-project deep links without directory", () => {
    expect(parseDeepLink("opencode://open-project")).toBeUndefined()
    expect(parseDeepLink("opencode://open-project?directory=")).toBeUndefined()
  })

  test("collects only valid open-project directories", () => {
    const result = collectOpenProjectDeepLinks([
      "opencode://open-project?directory=/a",
      "opencode://other?directory=/b",
      "opencode://open-project?directory=/c",
    ])
    expect(result).toEqual(["/a", "/c"])
  })

  test("parses new-session deep links with optional prompt", () => {
    expect(parseNewSessionDeepLink("opencode://new-session?directory=/tmp/demo")).toEqual({ directory: "/tmp/demo" })
    expect(parseNewSessionDeepLink("opencode://new-session?directory=/tmp/demo&prompt=hello%20world")).toEqual({
      directory: "/tmp/demo",
      prompt: "hello world",
    })
  })

  test("ignores new-session deep links without directory", () => {
    expect(parseNewSessionDeepLink("opencode://new-session")).toBeUndefined()
    expect(parseNewSessionDeepLink("opencode://new-session?directory=")).toBeUndefined()
  })

  test("collects only valid new-session deep links", () => {
    const result = collectNewSessionDeepLinks([
      "opencode://new-session?directory=/a",
      "opencode://open-project?directory=/b",
      "opencode://new-session?directory=/c&prompt=ship%20it",
    ])
    expect(result).toEqual([{ directory: "/a" }, { directory: "/c", prompt: "ship it" }])
  })

  test("drains global deep links once", () => {
    const target = {
      __OPENCODE__: {
        deepLinks: ["opencode://open-project?directory=/a"],
      },
    } as unknown as Window & { __OPENCODE__?: { deepLinks?: string[] } }

    expect(drainPendingDeepLinks(target)).toEqual(["opencode://open-project?directory=/a"])
    expect(drainPendingDeepLinks(target)).toEqual([])
  })
})

describe("layout workspace helpers", () => {
  test("normalizes trailing slash in workspace key", () => {
    expect(workspaceKey("/tmp/demo///")).toBe("/tmp/demo")
    expect(workspaceKey("C:\\tmp\\demo\\\\")).toBe("C:\\tmp\\demo")
  })

  test("preserves posix and drive roots in workspace key", () => {
    expect(workspaceKey("/")).toBe("/")
    expect(workspaceKey("///")).toBe("/")
    expect(workspaceKey("C:\\")).toBe("C:\\")
    expect(workspaceKey("C:\\\\\\")).toBe("C:\\")
    expect(workspaceKey("C:///")).toBe("C:/")
  })

  test("keeps local first while preserving known order", () => {
    const result = effectiveWorkspaceOrder("/root", ["/root", "/b", "/c"], ["/root", "/c", "/a", "/b"])
    expect(result).toEqual(["/root", "/c", "/b"])
  })

  test("finds the latest root session across workspaces", () => {
    const result = latestRootSession(
      [
        {
          path: { directory: "/root" },
          session: [session({ id: "root", directory: "/root", time: { created: 1, updated: 1, archived: undefined } })],
        },
        {
          path: { directory: "/workspace" },
          session: [
            session({
              id: "workspace",
              directory: "/workspace",
              time: { created: 2, updated: 2, archived: undefined },
            }),
          ],
        },
      ],
      120_000,
    )

    expect(result?.id).toBe("workspace")
  })

  test("detects project permissions with a filter", () => {
    const result = hasProjectPermissions(
      {
        root: [{ id: "perm-root" }, { id: "perm-hidden" }],
        child: [{ id: "perm-child" }],
      },
      (item) => item.id === "perm-child",
    )

    expect(result).toBe(true)
  })

  test("ignores project permissions filtered out", () => {
    const result = hasProjectPermissions(
      {
        root: [{ id: "perm-root" }],
      },
      () => false,
    )

    expect(result).toBe(false)
  })

  test("ignores archived and child sessions when finding latest root session", () => {
    const result = latestRootSession(
      [
        {
          path: { directory: "/workspace" },
          session: [
            session({
              id: "archived",
              directory: "/workspace",
              time: { created: 10, updated: 10, archived: 10 },
            }),
            session({
              id: "child",
              directory: "/workspace",
              parentID: "parent",
              time: { created: 20, updated: 20, archived: undefined },
            }),
            session({
              id: "root",
              directory: "/workspace",
              time: { created: 30, updated: 30, archived: undefined },
            }),
          ],
        },
      ],
      120_000,
    )

    expect(result?.id).toBe("root")
  })

  test("builds active session lineage across grandchildren", () => {
    const list = [
      session({ id: "root", directory: "/workspace" }),
      session({ id: "child", directory: "/workspace", parentID: "root" }),
      session({ id: "grand", directory: "/workspace", parentID: "child" }),
    ]

    expect([...sessionLineage(list, "grand")]).toEqual(["child", "root"])
  })

  test("flattens visible session tree with nested expansion", () => {
    const list = [
      session({ id: "root", directory: "/workspace" }),
      session({ id: "other", directory: "/workspace" }),
      session({ id: "child", directory: "/workspace", parentID: "root" }),
      session({ id: "grand", directory: "/workspace", parentID: "child" }),
    ]
    const map = new Map([
      ["root", ["child"]],
      ["child", ["grand"]],
    ])

    expect(
      visibleSessionTree([list[0], list[1]], list, map, new Set(["root", "child"])).map((item) => item.session.id),
    ).toEqual(["root", "child", "grand", "other"])
    expect(visibleSessionTree([list[0]], list, map, new Set(["root"])).map((item) => item.session.id)).toEqual([
      "root",
      "child",
    ])
  })

  test("sorts child sessions by creation time for stable numbering", () => {
    const map = childMapByParent([
      session({ id: "root", directory: "/workspace", time: { created: 1, updated: 1 } }),
      session({ id: "third", directory: "/workspace", parentID: "root", time: { created: 30, updated: 30 } }),
      session({ id: "first", directory: "/workspace", parentID: "root", time: { created: 10, updated: 10 } }),
      session({ id: "second", directory: "/workspace", parentID: "root", time: { created: 20, updated: 20 } }),
    ])

    expect(map.get("root")).toEqual(["first", "second", "third"])
  })

  test("summarizes completed child sessions", () => {
    const done = session({ id: "done", directory: "/workspace" })
    const running = session({ id: "running", directory: "/workspace" })
    const idle = session({ id: "idle", directory: "/workspace" })

    expect(
      childSessionSummary(
        [done, running, idle],
        {
          done: [message({ id: "done-message", sessionID: "done", time: { created: 0, completed: 1 } })],
          running: [message({ id: "running-message", sessionID: "running" })],
        },
        {
          done: { type: "idle" },
          running: { type: "retry" },
          idle: { type: "idle" },
        },
      ),
    ).toEqual({ completed: 1, total: 3 })
  })

  test("keeps active grandchild ancestors expanded in nav order after collapse", () => {
    const list = [
      session({ id: "root", directory: "/workspace" }),
      session({ id: "other", directory: "/workspace" }),
      session({ id: "child", directory: "/workspace", parentID: "root" }),
      session({ id: "grand", directory: "/workspace", parentID: "child" }),
    ]
    const map = new Map([
      ["root", ["child"]],
      ["child", ["grand"]],
    ])
    const expanded = effectiveSessionExpansion({ root: false, child: false }, sessionLineage(list, "grand"))

    expect([...expanded]).toEqual(["child", "root"])
    expect(visibleSessionTree([list[0], list[1]], list, map, expanded).map((item) => item.session.id)).toEqual([
      "root",
      "child",
      "grand",
      "other",
    ])
  })

  test("formats child session title with sibling sequence first", () => {
    expect(
      displaySessionTitle(
        session({
          id: "child",
          directory: "/workspace",
          parentID: "root",
          title: "Mission Build: MOD-17 Remove WorkspaceID Runtime (@build agent)",
        }),
        1,
      ),
    ).toBe("#2 MOD-17 Remove WorkspaceID Runtime · Mission Build (@build agent)")
  })

  test("keeps child title order when no shared context exists", () => {
    expect(
      displaySessionTitle(
        session({
          id: "child",
          directory: "/workspace",
          parentID: "root",
          title: "Fix the failing typecheck (@coder subagent)",
        }),
        0,
      ),
    ).toBe("#1 Fix the failing typecheck (@coder subagent)")
  })

  test("keeps workflow child title in workflow order", () => {
    expect(
      displaySessionTitle(
        session({
          id: "child",
          directory: "/workspace",
          parentID: "root",
          title: "Mission Build: #3 Fix typecheck (@coder subagent)",
        }),
        0,
      ),
    ).toBe("Mission Build #3 Fix typecheck (@coder subagent)")
  })

  test("formats fallback project display name", () => {
    expect(displayName({ worktree: "/tmp/app" })).toBe("app")
    expect(displayName({ worktree: "/tmp/app", name: "My App" })).toBe("My App")
  })

  test("extracts api error message and fallback", () => {
    expect(errorMessage({ data: { message: "boom" } }, "fallback")).toBe("boom")
    expect(errorMessage(new Error("broken"), "fallback")).toBe("broken")
    expect(errorMessage("unknown", "fallback")).toBe("fallback")
  })
})
