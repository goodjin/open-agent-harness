import { describe, expect, test } from "bun:test"
import { diffRows, diffStats, diffUnique, heading, partTitle, thinkingText, turnAssistants } from "./session-turn-helpers"
import type { FileDiff, Message } from "@open-agent-harness/sdk/v2/client"

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

describe("partTitle", () => {
  const labels = {
    assistant: "assistant text",
    thinking: "思考中",
    process: "思考过程",
  }

  test("keeps assistant text separate from reasoning labels", () => {
    expect(partTitle("text", false, labels)).toBe("assistant text")
    expect(partTitle("text", true, labels)).toBe("assistant text")
  })

  test("uses thinking while a reasoning part can still stream", () => {
    expect(partTitle("reasoning", false, labels)).toBe("思考中")
  })

  test("uses thinking process after a reasoning part or its assistant message ends", () => {
    expect(partTitle("reasoning", true, labels)).toBe("思考过程")
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

describe("turnAssistants", () => {
  const user = (id: string, created: number) =>
    ({
      id,
      sessionID: "ses_1",
      role: "user",
      time: { created },
    }) as Message
  const assistant = (id: string, parentID: string, created: number, completed = created + 1) =>
    ({
      id,
      sessionID: "ses_1",
      role: "assistant",
      parentID,
      time: { created, completed },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "model",
      providerID: "provider",
      agent: "build",
      mode: "build",
      path: { cwd: "/tmp", root: "/tmp" },
    }) as Message

  test("keeps assistant messages tied to a user parent after later user messages", () => {
    expect(
      turnAssistants([
        user("u1", 1),
        assistant("a1", "u1", 2),
        user("u2", 3),
        assistant("a2", "u1", 4),
        assistant("a3", "u2", 5),
      ], "u1").map((item) => item.id),
    ).toEqual(["a1", "a2"])
  })
})
