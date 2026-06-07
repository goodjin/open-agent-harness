import { describe, expect, test } from "bun:test"
import { canDisposeDirectory, pickDirectoriesToEvict } from "./global-sync/eviction"
import {
  estimateRootSessionTotal,
  loadRootSessionsWithFallback,
  loadSessionTreeWithFallback,
  sessionFromNode,
} from "./global-sync/session-load"

describe("pickDirectoriesToEvict", () => {
  test("keeps pinned stores and evicts idle stores", () => {
    const now = 5_000
    const picks = pickDirectoriesToEvict({
      stores: ["a", "b", "c", "d"],
      state: new Map([
        ["a", { lastAccessAt: 1_000 }],
        ["b", { lastAccessAt: 4_900 }],
        ["c", { lastAccessAt: 4_800 }],
        ["d", { lastAccessAt: 3_000 }],
      ]),
      pins: new Set(["a"]),
      max: 2,
      ttl: 1_500,
      now,
    })

    expect(picks).toEqual(["d", "c"])
  })
})

describe("loadRootSessionsWithFallback", () => {
  test("uses limited roots query when supported", async () => {
    const calls: Array<{ directory: string; roots: true; limit?: number }> = []

    const result = await loadRootSessionsWithFallback({
      directory: "dir",
      limit: 10,
      list: async (query) => {
        calls.push(query)
        return { data: [] }
      },
    })

    expect(result.data).toEqual([])
    expect(result.limited).toBe(true)
    expect(calls).toEqual([{ directory: "dir", roots: true, limit: 10 }])
  })

  test("falls back to full roots query on limited-query failure", async () => {
    const calls: Array<{ directory: string; roots: true; limit?: number }> = []

    const result = await loadRootSessionsWithFallback({
      directory: "dir",
      limit: 25,
      list: async (query) => {
        calls.push(query)
        if (query.limit) throw new Error("unsupported")
        return { data: [] }
      },
    })

    expect(result.data).toEqual([])
    expect(result.limited).toBe(false)
    expect(calls).toEqual([
      { directory: "dir", roots: true, limit: 25 },
      { directory: "dir", roots: true },
    ])
  })

  test("loads all roots without limit when requested", async () => {
    const calls: Array<{ directory: string; roots: true; limit?: number }> = []

    const result = await loadRootSessionsWithFallback({
      directory: "dir",
      limit: 10,
      all: true,
      list: async (query) => {
        calls.push(query)
        return { data: [{ id: "root", time: { created: 1, updated: 1 } }] as never }
      },
    })

    expect(result.limited).toBe(false)
    expect(result.ids).toEqual(["root"])
    expect(calls).toEqual([{ directory: "dir", roots: true }])
  })
})

describe("loadSessionTreeWithFallback", () => {
  test("loads roots without descendants by default", async () => {
    const calls: string[][] = []
    const result = await loadSessionTreeWithFallback({
      directory: "dir",
      limit: 10,
      list: async () => ({
        data: [
          { id: "root-a", time: { created: 1, updated: 1 } },
          { id: "root-b", time: { created: 2, updated: 2 } },
        ] as never,
      }),
      descendants: async (query) => {
        calls.push(query.ids)
        return {
          data: [{ id: "child", parentID: "root-a", time: { created: 3, updated: 3 } }] as never,
        }
      },
    })

    expect(calls).toEqual([])
    expect(result.data?.map((s) => s.id)).toEqual(["root-a", "root-b"])
  })

  test("loads descendants in one batch and merges them when enabled", async () => {
    const calls: string[][] = []
    const result = await loadSessionTreeWithFallback({
      directory: "dir",
      limit: 10,
      children: true,
      list: async () => ({
        data: [
          { id: "root-a", time: { created: 1, updated: 1 } },
          { id: "root-b", time: { created: 2, updated: 2 } },
        ] as never,
      }),
      descendants: async (query) => {
        calls.push(query.ids)
        return {
          data: [{ id: "child", parentID: "root-a", time: { created: 3, updated: 3 } }] as never,
        }
      },
    })

    expect(calls).toEqual([["root-a", "root-b"]])
    expect(result.data?.map((s) => s.id)).toEqual(["root-a", "root-b", "child"])
  })

  test("loads lightweight trees for roots and merges converted children", async () => {
    const calls: string[] = []
    const result = await loadSessionTreeWithFallback({
      directory: "dir",
      limit: 10,
      children: true,
      list: async () => ({
        data: [
          {
            id: "root-a",
            slug: "root-a",
            projectID: "proj",
            directory: "dir",
            title: "Root A",
            version: "v2",
            time: { created: 1, updated: 1 },
          },
        ] as never,
      }),
      tree: async (query) => {
        calls.push(query.root)
        return {
          data: {
            nodes: [
              {
                id: "root-a",
                root_id: "root-a",
                title: "Root A",
                status: { type: "idle" },
                stats: {
                  messages: 1,
                  tokens_input: 0,
                  tokens_output: 0,
                  tool_calls: 0,
                  files: 0,
                  additions: 0,
                  deletions: 0,
                },
                time: { created: 1, updated: 1 },
              },
              {
                id: "child-a",
                parent_id: "root-a",
                root_id: "root-a",
                title: "Child A",
                status: { type: "idle" },
                stats: {
                  messages: 2,
                  tokens_input: 0,
                  tokens_output: 0,
                  tool_calls: 0,
                  files: 3,
                  additions: 4,
                  deletions: 5,
                },
                time: { created: 2, updated: 3 },
              },
            ],
          },
        } as never
      },
    })

    expect(calls).toEqual(["root-a"])
    expect(result.data?.map((s) => s.id)).toEqual(["root-a", "child-a"])
    expect(result.data?.find((s) => s.id === "child-a")).toMatchObject({
      directory: "dir",
      parentID: "root-a",
      summary: { files: 3, additions: 4, deletions: 5 },
    })
  })

  test("loads descendants only for roots not loaded before", async () => {
    const calls: string[][] = []
    const result = await loadSessionTreeWithFallback({
      directory: "dir",
      limit: 10,
      children: true,
      loaded: new Set(["root-a"]),
      list: async () => ({
        data: [
          { id: "root-a", time: { created: 1, updated: 1 } },
          { id: "root-b", time: { created: 2, updated: 2 } },
        ] as never,
      }),
      descendants: async (query) => {
        calls.push(query.ids)
        return {
          data: [{ id: "child-b", parentID: "root-b", time: { created: 3, updated: 3 } }] as never,
        }
      },
    })

    expect(calls).toEqual([["root-b"]])
    expect(result.ids).toEqual(["root-a", "root-b"])
    expect(result.data?.map((s) => s.id)).toEqual(["root-a", "root-b", "child-b"])
  })
})

describe("sessionFromNode", () => {
  test("converts lightweight tree node into sidebar session shape", () => {
    const session = sessionFromNode(
      {
        id: "child",
        parent_id: "root",
        root_id: "root",
        title: "Child",
        status: { type: "idle" },
        stats: {
          messages: 0,
          tokens_input: 0,
          tokens_output: 0,
          tool_calls: 0,
          files: 1,
          additions: 2,
          deletions: 3,
        },
        time: { created: 10, updated: 20 },
      },
      {
        id: "root",
        slug: "root",
        projectID: "proj",
        directory: "dir",
        title: "Root",
        version: "v2",
        time: { created: 1, updated: 2 },
      } as never,
    )

    expect(session).toMatchObject({
      id: "child",
      slug: "child",
      projectID: "proj",
      directory: "dir",
      parentID: "root",
      title: "Child",
      version: "v2",
      summary: { files: 1, additions: 2, deletions: 3 },
      time: { created: 10, updated: 20 },
    })
  })
})

describe("estimateRootSessionTotal", () => {
  test("keeps exact total for full fetches", () => {
    expect(estimateRootSessionTotal({ count: 42, limit: 10, limited: false })).toBe(42)
  })

  test("marks has-more for full-limit limited fetches", () => {
    expect(estimateRootSessionTotal({ count: 10, limit: 10, limited: true })).toBe(11)
  })

  test("keeps exact total when limited fetch is under limit", () => {
    expect(estimateRootSessionTotal({ count: 9, limit: 10, limited: true })).toBe(9)
  })
})

describe("canDisposeDirectory", () => {
  test("rejects pinned or inflight directories", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: true,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: true,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: true,
      }),
    ).toBe(false)
  })

  test("accepts idle unpinned directory store", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(true)
  })
})
