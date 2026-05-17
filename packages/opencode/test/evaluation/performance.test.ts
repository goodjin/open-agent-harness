import { describe, expect, test } from "bun:test"
import { Performance } from "../../src/evaluation/performance"

describe("MOD-15 performance checks", () => {
  test("checks thresholds deterministically without wall-clock timing", () => {
    for (const item of Performance.thresholds) {
      expect(Performance.check(item.target, item.limit).ok).toBe(true)
      expect(Performance.check(item.target, item.limit + 1)).toEqual({
        target: item.target,
        duration: item.limit + 1,
        limit: item.limit,
        ok: false,
      })
    }
    expect(() => Performance.check("missing" as Performance.Target, 1)).toThrow("Unknown performance target: missing")
  })
})
