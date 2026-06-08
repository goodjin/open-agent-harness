import { describe, expect, test } from "bun:test"
import { diffRows, diffStats, diffUnique, heading, thinkingText } from "./session-turn-helpers"
import type { FileDiff } from "@open-agent-harness/sdk/v2/client"

const diff = (file: string, additions: number, deletions: number): FileDiff =>
  ({
    file,
    additions,
    deletions,
    before: "",
    after: "",
  }) as FileDiff

describe("thinkingText", () => {
  test("uses the base thinking label without a topic", () => {
    expect(thinkingText("思考中", "思考：{{topic}}")).toBe("思考中")
  })

  test("appends the topic to the thinking label", () => {
    expect(thinkingText("思考中", "思考：{{topic}}", "检查文件")).toBe("思考：检查文件")
  })

  test("extracts a markdown heading for the topic", () => {
    expect(thinkingText("思考中", "思考：{{topic}}", heading("## 检查文件\n\n读取上下文"))).toBe("思考：检查文件")
  })
})

describe("turn diffs", () => {
  test("keeps the latest summary for each file", () => {
    expect(diffUnique([diff("a.ts", 1, 0), diff("b.ts", 2, 0), diff("a.ts", 3, 1)]).map((item) => item.file)).toEqual([
      "b.ts",
      "a.ts",
    ])
  })

  test("limits rows until expanded", () => {
    const files = [diff("a.ts", 1, 0), diff("b.ts", 1, 0), diff("c.ts", 1, 0), diff("d.ts", 1, 0)]

    expect(diffRows(files, false).map((item) => item.file)).toEqual(["a.ts", "b.ts", "c.ts"])
    expect(diffRows(files, true).map((item) => item.file)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"])
  })

  test("summarizes changed files and line counts", () => {
    expect(diffStats([diff("a.ts", 3, 1), diff("b.ts", 2, 4)])).toEqual({
      files: 2,
      additions: 5,
      deletions: 5,
    })
  })
})
