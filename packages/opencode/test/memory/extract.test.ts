import { describe, expect, test } from "bun:test"
import { MemoryExtract } from "../../src/memory"

describe("memory extraction parser", () => {
  test("parses valid structured output", () => {
    const result = MemoryExtract.parse(
      '```json\n{"summary":"Keep auth adapter notes","topics":["auth","adapter"]}\n```',
    )

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.topics).toEqual(["auth", "adapter"])
  })

  test("returns a safe error for malformed output", () => {
    const result = MemoryExtract.parse("{not json")

    expect(result.ok).toBe(false)
  })

  test("returns a safe error for structurally invalid output", () => {
    const result = MemoryExtract.parse('{"summary":5,"topics":"bad"}')

    expect(result.ok).toBe(false)
  })
})
