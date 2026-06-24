import { describe, expect, test } from "bun:test"
import { snapshot } from "./markdown"

describe("snapshot", () => {
  test("closes an open fenced code block for streaming render", () => {
    expect(snapshot(["Before", "", "```ts", "const value = 1"].join("\n"))).toBe(
      ["Before", "", "```ts", "const value = 1", "```", ""].join("\n"),
    )
  })

  test("keeps a closed fenced code block unchanged", () => {
    const text = ["```ts", "const value = 1", "```", "After"].join("\n")

    expect(snapshot(text)).toBe(text)
  })

  test("uses the matching fence marker length", () => {
    expect(snapshot(["~~~~", "body"].join("\n"))).toBe(["~~~~", "body", "~~~~", ""].join("\n"))
  })
})
