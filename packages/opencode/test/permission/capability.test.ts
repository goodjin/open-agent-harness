import { describe, expect, test } from "bun:test"
import { Capability } from "../../src/permission/capability"

describe("Capability", () => {
  test("classifies tool capability", () => {
    expect(Capability.make("todowrite")).toEqual({
      dimension: "tool",
      permission: "todowrite",
      pattern: "*",
    })
  })

  test("classifies file capability", () => {
    expect(Capability.make("read", "src/index.ts")).toEqual({
      dimension: "file",
      permission: "read",
      pattern: "src/index.ts",
    })
  })

  test("classifies command capability", () => {
    expect(Capability.make("bash", "git status").dimension).toBe("command")
  })

  test("classifies network capability", () => {
    expect(Capability.make("webfetch", "https://example.com").dimension).toBe("network")
  })

  test("classifies agent capability", () => {
    expect(Capability.make("task", "general").dimension).toBe("agent")
  })

  test("classifies quota capability", () => {
    expect(Capability.make("doom_loop", "bash").dimension).toBe("quota")
  })

  test("normalizes edit-family tools", () => {
    expect(Capability.make("write").permission).toBe("edit")
    expect(Capability.make("multiedit").permission).toBe("edit")
  })
})
