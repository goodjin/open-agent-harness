import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import {
  automaticResumeMode,
  createOpenReviewFile,
  createOpenSessionFileTab,
  createSessionTabs,
  deriveSessionLiveStatus,
  deriveTurnStats,
  focusTerminalById,
  getTabReorderIndex,
  isSessionBusy,
  resumePrompt,
  turnDone,
} from "./helpers"
import type { Message, Part } from "@open-agent-harness/sdk/v2/client"

describe("isSessionBusy", () => {
  test("uses session status as the source of truth", () => {
    expect(
      isSessionBusy({ type: "idle" }, [
        {
          id: "msg_1",
          sessionID: "ses_1",
          role: "assistant",
          path: { cwd: "/tmp", root: "/tmp" },
          time: { created: 1 },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "model",
          providerID: "provider",
          parentID: "msg_0",
          agent: "build",
          mode: "build",
        },
      ]),
    ).toBe(false)

    expect(isSessionBusy({ type: "running" })).toBe(true)
    expect(isSessionBusy({ type: "waiting_child" })).toBe(true)
    expect(isSessionBusy({ type: "timeout", message: "timed out" })).toBe(false)
    expect(isSessionBusy(undefined)).toBe(false)
  })
})

describe("resumePrompt", () => {
  test("uses automatic fallback for continue actions", () => {
    expect(automaticResumeMode()).toBe("auto")
  })

  test("does not show while bootstrap can auto continue", () => {
    expect(resumePrompt({ type: "running" })).toBeUndefined()
    expect(resumePrompt({ type: "queued" })).toBeUndefined()
    expect(resumePrompt({ type: "starting" })).toBeUndefined()
    expect(
      resumePrompt({
        type: "rate_limited",
        providerID: "p",
        modelID: "m",
        scope: "model",
        active: 1,
        limit: 1,
        queued: 1,
      }),
    ).toBeUndefined()
    expect(resumePrompt({ type: "retry", attempt: 1, message: "try again", next: 1 })).toBeUndefined()
  })

  test("shows interrupted sessions as manually continuable", () => {
    expect(resumePrompt({ type: "interrupted", prior: "running" })).toEqual({
      label: "会话中断",
      description: "系统或进程中断了这个会话，确认后从可恢复状态继续。",
      action: "继续",
    })
  })

  test("shows abnormal stopped sessions as manually continuable", () => {
    expect(resumePrompt({ type: "error", message: "tool failed" })).toEqual({
      label: "会话异常中断",
      description: "tool failed",
      action: "继续",
    })
    expect(resumePrompt({ type: "completed" })).toBeUndefined()
    expect(resumePrompt({ type: "waiting_user" })).toBeUndefined()
  })
})

describe("turnDone", () => {
  const user = (id: string) =>
    ({
      id,
      sessionID: "ses_1",
      role: "user",
      time: { created: 1 },
    }) as Message
  const assistant = (input: {
    id: string
    parentID: string
    completed?: number
    error?: boolean
  }) =>
    ({
      id: input.id,
      sessionID: "ses_1",
      role: "assistant",
      parentID: input.parentID,
      time: { created: 2, completed: input.completed },
      error: input.error ? { name: "UnknownError", data: { message: "failed" } } : undefined,
    }) as Message

  test("uses the last assistant in the user turn and ignores stale shells", () => {
    expect(
      turnDone(
        [
          user("u1"),
          assistant({ id: "a1", parentID: "u1" }),
          assistant({ id: "a2", parentID: "u1" }),
          assistant({ id: "a3", parentID: "u1", completed: 4 }),
        ],
        "u1",
        { type: "completed" },
      ),
    ).toBe(true)
  })

  test("does not mark failed final assistants as complete", () => {
    expect(
      turnDone(
        [user("u1"), assistant({ id: "a1", parentID: "u1", completed: 3, error: true })],
        "u1",
        { type: "completed" },
      ),
    ).toBe(false)
  })

  test("uses explicit turn metadata as request completion", () => {
    expect(
      turnDone(
        [
          {
            ...user("u1"),
            metadata: {
              turn: {
                kind: "user",
                status: "done",
                outcome: "waiting_child",
                time: { queued: 1, started: 2, completed: 3 },
              },
            },
          } as Message,
        ],
        "u1",
        { type: "running" },
      ),
    ).toBe(true)
  })
})

describe("deriveTurnStats", () => {
  const user = (id: string) =>
    ({
      id,
      sessionID: "ses_1",
      role: "user",
      time: { created: 1 },
    }) as Message
  const assistant = (id: string, parentID: string) =>
    ({
      id,
      sessionID: "ses_1",
      role: "assistant",
      parentID,
      time: { created: 2, completed: 3 },
    }) as Message

  test("counts assistant tools and protocol actions in the same turn", () => {
    expect(
      deriveTurnStats([user("u1"), assistant("a1", "u1"), user("u2"), assistant("a2", "u2")], "u1", {
        a1: [
          { id: "p1", sessionID: "ses_1", messageID: "a1", type: "tool" },
          { id: "p2", sessionID: "ses_1", messageID: "a1", type: "text", text: "done", metadata: { protocol: true } },
        ] as Part[],
        a2: [{ id: "p3", sessionID: "ses_1", messageID: "a2", type: "tool" }] as Part[],
      }),
    ).toEqual({
      actions: 1,
      tools: 1,
    })
  })
})

describe("deriveSessionLiveStatus", () => {
  const user = (id: string, created = 1) =>
    ({
      id,
      sessionID: "ses_1",
      role: "user",
      time: { created },
    }) as Message
  const assistant = (id: string, parentID: string, completed?: number) =>
    ({
      id,
      sessionID: "ses_1",
      role: "assistant",
      parentID,
      time: { created: 2, completed },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "model",
      providerID: "provider",
      agent: "build",
      mode: "build",
      path: { cwd: "/tmp", root: "/tmp" },
    }) as Message
  const done = (id: string) =>
    ({
      ...user(id),
      metadata: {
        turn: {
          kind: "user",
          status: "done",
          outcome: "completed",
          reason: "assistant",
          time: { queued: 1, started: 2, completed: 3 },
        },
      },
    }) as Message

  test("describes precise wait states before generic running state", () => {
    expect(deriveSessionLiveStatus({ status: { type: "waiting_user" }, messages: [], parts: {} })).toMatchObject({
      label: "等待用户确认",
      description: "模型请求已暂停，正在等待你的回复。",
    })
    expect(
      deriveSessionLiveStatus({
        status: {
          type: "rate_limited",
          providerID: "anthropic",
          modelID: "claude",
          scope: "model",
          kind: "concurrency",
          active: 2,
          limit: 2,
          queued: 3,
        },
        messages: [],
        parts: {},
      }),
    ).toMatchObject({
      label: "并发额度已满",
      description: "模型并发 2/2，队列中 3 个请求，anthropic/claude 正在等待可用额度。",
    })
    expect(
      deriveSessionLiveStatus({
        status: {
          type: "rate_limited",
          providerID: "anthropic",
          modelID: "claude",
          scope: "model",
          kind: "rpm",
          active: 20,
          limit: 20,
          queued: 4,
        },
        messages: [],
        parts: {},
      }),
    ).toMatchObject({
      label: "请求频率已满",
      description: "模型最近一分钟已达 20 次请求，队列中 4 个请求。",
    })
  })

  test("uses latest unfinished assistant parts for thinking, tools, and text", () => {
    expect(
      deriveSessionLiveStatus({
        status: { type: "running" },
        now: 5_000,
        messages: [user("u1"), assistant("a1", "u1")],
        parts: {
          a1: [{ id: "p1", sessionID: "ses_1", messageID: "a1", type: "reasoning", text: "thinking", time: { start: 2_000 } }],
        },
      }),
    ).toMatchObject({ label: "思考中", metrics: ["用时 3s", "已接收 8 B"] })

    expect(
      deriveSessionLiveStatus({
        status: { type: "running" },
        now: 5_000,
        messages: [user("u1"), assistant("a1", "u1")],
        parts: {
          a1: [
            {
              id: "p1",
              sessionID: "ses_1",
              messageID: "a1",
              type: "tool",
              callID: "call_1",
              tool: "bash",
              state: { status: "running", input: {}, time: { start: 2_000 }, title: "Run tests" },
            },
          ],
        },
      }),
    ).toMatchObject({ label: "工具调用中", description: "正在执行 bash：Run tests", metrics: ["用时 3s"] })

    expect(
      deriveSessionLiveStatus({
        status: { type: "running" },
        now: 5_000,
        messages: [user("u1"), assistant("a1", "u1")],
        parts: {
          a1: [{ id: "p1", sessionID: "ses_1", messageID: "a1", type: "text", text: "partial", time: { start: 2_000 } }],
        },
      }),
    ).toMatchObject({ label: "文本回复中", metrics: ["用时 3s", "已接收 7 B"] })
  })

  test("shows request progress before any assistant part arrives", () => {
    expect(
      deriveSessionLiveStatus({
        status: { type: "running" },
        now: 5_000,
        messages: [
          {
            ...user("u1", 1_000),
            metadata: {
              turn: {
                kind: "user",
                status: "running",
                time: { queued: 1_000, started: 2_000 },
              },
            },
          } as Message,
        ],
        parts: {
          u1: [{ id: "p1", sessionID: "ses_1", messageID: "u1", type: "text", text: "hello" }],
        },
      }),
    ).toMatchObject({
      label: "请求已发出",
      description: "用户消息已进入会话，正在等待模型开始响应。",
      metrics: ["用时 3s", "已发送 5 B"],
    })

    expect(deriveSessionLiveStatus({ status: { type: "completed" }, messages: [user("u1")], parts: {} })).toBeUndefined()
  })

  test("keeps a persisted queued turn distinct from a started request", () => {
    expect(
      deriveSessionLiveStatus({
        status: { type: "running" },
        now: 5_000,
        messages: [
          {
            ...user("u1", 1_000),
            metadata: {
              turn: {
                kind: "user",
                status: "queued",
                time: { queued: 1_000 },
              },
            },
          } as Message,
        ],
        parts: {
          u1: [{ id: "p1", sessionID: "ses_1", messageID: "u1", type: "text", text: "hello" }],
        },
      }),
    ).toMatchObject({
      label: "请求排队中",
      description: "请求已持久化，等待当前运行结束后消费。",
    })
  })

  test("adds elapsed duration for non-output live states when turn timing exists", () => {
    expect(
      deriveSessionLiveStatus({
        status: { type: "waiting_user" },
        now: 5_000,
        messages: [
          {
            ...user("u1", 1_000),
            metadata: {
              turn: {
                kind: "user",
                status: "running",
                time: { queued: 1_000, started: 2_000 },
              },
            },
          } as Message,
        ],
        parts: {},
      }),
    ).toMatchObject({
      label: "等待用户确认",
      metrics: ["用时 3s"],
    })
  })

  test("does not show responding after the turn or session has ended", () => {
    expect(
      deriveSessionLiveStatus({
        status: { type: "completed" },
        messages: [user("u1"), assistant("a1", "u1")],
        parts: {
          a1: [{ id: "p1", sessionID: "ses_1", messageID: "a1", type: "text", text: "partial" }],
        },
      }),
    ).toBeUndefined()

    expect(
      deriveSessionLiveStatus({
        status: { type: "running" },
        messages: [done("u1"), assistant("a1", "u1")],
        parts: {
          a1: [{ id: "p1", sessionID: "ses_1", messageID: "a1", type: "reasoning", text: "thinking", time: { start: 2 } }],
        },
      }),
    ).toBeUndefined()
  })
})

describe("createOpenReviewFile", () => {
  test("opens and loads selected review file", () => {
    const calls: string[] = []
    const openReviewFile = createOpenReviewFile({
      showAllFiles: () => calls.push("show"),
      tabForPath: (path) => {
        calls.push(`tab:${path}`)
        return `file://${path}`
      },
      openTab: (tab) => calls.push(`open:${tab}`),
      setActive: (tab) => calls.push(`active:${tab}`),
      loadFile: (path) => calls.push(`load:${path}`),
    })

    openReviewFile("src/a.ts")

    expect(calls).toEqual(["show", "load:src/a.ts", "tab:src/a.ts", "open:file://src/a.ts", "active:file://src/a.ts"])
  })
})

describe("createOpenSessionFileTab", () => {
  test("activates the opened file tab", () => {
    const calls: string[] = []
    const openTab = createOpenSessionFileTab({
      normalizeTab: (value) => {
        calls.push(`normalize:${value}`)
        return `file://${value}`
      },
      openTab: (tab) => calls.push(`open:${tab}`),
      pathFromTab: (tab) => {
        calls.push(`path:${tab}`)
        return tab.slice("file://".length)
      },
      loadFile: (path) => calls.push(`load:${path}`),
      openReviewPanel: () => calls.push("review"),
      setActive: (tab) => calls.push(`active:${tab}`),
    })

    openTab("src/a.ts")

    expect(calls).toEqual([
      "normalize:src/a.ts",
      "open:file://src/a.ts",
      "path:file://src/a.ts",
      "load:src/a.ts",
      "review",
      "active:file://src/a.ts",
    ])
  })
})

describe("focusTerminalById", () => {
  test("focuses textarea when present", () => {
    document.body.innerHTML = `<div id="terminal-wrapper-one"><div data-component="terminal"><textarea></textarea></div></div>`

    const focused = focusTerminalById("one")

    expect(focused).toBe(true)
    expect(document.activeElement?.tagName).toBe("TEXTAREA")
  })

  test("falls back to terminal element focus", () => {
    document.body.innerHTML = `<div id="terminal-wrapper-two"><div data-component="terminal" tabindex="0"></div></div>`
    const terminal = document.querySelector('[data-component="terminal"]') as HTMLElement
    let pointerDown = false
    terminal.addEventListener("pointerdown", () => {
      pointerDown = true
    })

    const focused = focusTerminalById("two")

    expect(focused).toBe(true)
    expect(document.activeElement).toBe(terminal)
    expect(pointerDown).toBe(true)
  })
})

describe("getTabReorderIndex", () => {
  test("returns target index for valid drag reorder", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "c")).toBe(2)
  })

  test("returns undefined for unknown droppable id", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "missing")).toBeUndefined()
  })
})

describe("createSessionTabs", () => {
  test("normalizes the effective file tab", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: ["file://src/a.ts", "context"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
        normalizeTab: (tab) => (tab.startsWith("file://") ? `norm:${tab.slice("file://".length)}` : tab),
      })

      expect(result.activeTab()).toBe("norm:src/a.ts")
      expect(result.activeFileTab()).toBe("norm:src/a.ts")
      expect(result.closableTab()).toBe("norm:src/a.ts")
      dispose()
    })
  })

  test("prefers context and review fallbacks when no file tab is active", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: ["context"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: () => undefined,
        normalizeTab: (tab) => tab,
        review: () => true,
        hasReview: () => true,
      })

      expect(result.activeTab()).toBe("context")
      expect(result.closableTab()).toBe("context")
      dispose()
    })

    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: [],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: () => undefined,
        normalizeTab: (tab) => tab,
        review: () => true,
        hasReview: () => true,
      })

      expect(result.activeTab()).toBe("review")
      expect(result.activeFileTab()).toBeUndefined()
      expect(result.closableTab()).toBeUndefined()
      dispose()
    })
  })

  test("keeps logs out of sortable file tabs", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: "logs" as string | undefined,
        all: ["logs", "file://src/a.ts"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
        normalizeTab: (tab) => (tab.startsWith("file://") ? `norm:${tab.slice("file://".length)}` : tab),
        logs: () => true,
      })

      expect(result.activeTab()).toBe("logs")
      expect(result.openedTabs()).toEqual(["norm:src/a.ts"])
      expect(result.closableTab()).toBeUndefined()
      dispose()
    })
  })

  test("keeps graph out of sortable file tabs", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: "graph" as string | undefined,
        all: ["graph", "file://src/a.ts"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
        normalizeTab: (tab) => (tab.startsWith("file://") ? `norm:${tab.slice("file://".length)}` : tab),
        graph: () => true,
      })

      expect(result.activeTab()).toBe("graph")
      expect(result.openedTabs()).toEqual(["norm:src/a.ts"])
      expect(result.closableTab()).toBeUndefined()
      dispose()
    })
  })

  test("maps legacy workflow and protocol tabs to graph", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: "workflow" as string | undefined,
        all: ["workflow", "protocol", "file://src/a.ts"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
        normalizeTab: (tab) => (tab.startsWith("file://") ? `norm:${tab.slice("file://".length)}` : tab),
        graph: () => true,
      })

      expect(result.activeTab()).toBe("graph")
      expect(result.openedTabs()).toEqual(["norm:src/a.ts"])
      expect(result.closableTab()).toBeUndefined()
      dispose()
    })
  })

  test("falls back through graph visibility", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: [],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: () => undefined,
        normalizeTab: (tab) => tab,
        graph: () => true,
        logs: () => true,
      })

      expect(result.activeTab()).toBe("graph")
      expect(result.activeFileTab()).toBeUndefined()
      expect(result.closableTab()).toBeUndefined()
      dispose()
    })

    createRoot((dispose) => {
      const [state] = createStore({
        active: "graph" as string | undefined,
        all: [],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: () => undefined,
        normalizeTab: (tab) => tab,
        graph: () => false,
        logs: () => true,
      })

      expect(result.activeTab()).toBe("logs")
      expect(result.activeFileTab()).toBeUndefined()
      expect(result.closableTab()).toBeUndefined()
      dispose()
    })
  })

  test("uses session as the default unified tab", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: ["file://src/a.ts", "session"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
        normalizeTab: (tab) => (tab.startsWith("file://") ? `norm:${tab.slice("file://".length)}` : tab),
        session: () => true,
      })

      expect(result.activeTab()).toBe("session")
      expect(result.openedTabs()).toEqual(["norm:src/a.ts"])
      expect(result.activeFileTab()).toBeUndefined()
      dispose()
    })
  })
})
