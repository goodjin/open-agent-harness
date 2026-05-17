import { describe, expect, test } from "bun:test"
import { MemoryAdapter } from "../../src/memory"

describe("memory adapter contract", () => {
  test("upserts, searches, ranks, and removes entries without external services", async () => {
    const adapter = new MemoryAdapter.Local()
    await adapter.upsert([
      { id: "a", text: "qdrant adapter contract memory" },
      { id: "b", text: "unrelated session note" },
    ])

    const hits = await adapter.search({ query: "qdrant memory", limit: 2 })
    expect(hits[0].id).toBe("a")
    expect(hits[0].score).toBeGreaterThan(0)

    await adapter.remove(["a"])
    const next = await adapter.search({ query: "qdrant memory", limit: 2 })
    expect(next.map((hit) => hit.id)).not.toContain("a")
  })

  test("uses vectors when provided", async () => {
    const adapter = new MemoryAdapter.Local()
    await adapter.upsert([
      { id: "near", text: "alpha", vector: [1, 0] },
      { id: "far", text: "alpha", vector: [0, 1] },
    ])

    const hits = await adapter.search({ query: "missing", vector: [1, 0], limit: 2 })
    expect(hits[0].id).toBe("near")
  })
})
