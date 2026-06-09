import { describe, expect, test } from "bun:test"
import { answersWithNotes, limitDescription } from "./session-question-dock"

describe("answersWithNotes", () => {
  test("appends selected option notes without changing empty notes", () => {
    expect(
      answersWithNotes(["Schema", "Prompt", "Docs"], {
        Schema: "需要兼容 v1",
        Prompt: "  ",
      }),
    ).toEqual(["Schema: 需要兼容 v1", "Prompt", "Docs"])
  })
})

describe("limitDescription", () => {
  test("returns empty view for empty input", () => {
    expect(limitDescription("")).toEqual({ text: "", hidden: 0 })
  })

  test("returns original text when shorter than the limit", () => {
    expect(limitDescription("short description", 140)).toEqual({ text: "short description", hidden: 0 })
  })

  test("truncates text that exceeds the limit and reports the hidden count", () => {
    const long = "x".repeat(200)
    const view = limitDescription(long, 140)
    expect(view.text.length).toBe(140)
    expect(view.text).toBe("x".repeat(140))
    expect(view.hidden).toBe(60)
  })

  test("honors a custom limit", () => {
    const view = limitDescription("abcdefghij", 4)
    expect(view).toEqual({ text: "abcd", hidden: 6 })
  })

  test("treats the default limit as 140 characters", () => {
    const view = limitDescription("x".repeat(141))
    expect(view.text.length).toBe(140)
    expect(view.hidden).toBe(1)
  })
})
