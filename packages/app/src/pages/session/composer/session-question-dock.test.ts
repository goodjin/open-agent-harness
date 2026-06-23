import { describe, expect, test } from "bun:test"
import { answersWithNotes, confirmOnly, confirmOption, limitDescription } from "./session-question-dock"

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

  test("keeps long text intact and reports the hidden count", () => {
    const long = "x".repeat(200)
    const view = limitDescription(long, 140)
    expect(view.text).toBe(long)
    expect(view.hidden).toBe(60)
  })

  test("honors a custom limit", () => {
    const view = limitDescription("abcdefghij", 4)
    expect(view).toEqual({ text: "abcdefghij", hidden: 6 })
  })

  test("does not truncate markdown syntax before rendering", () => {
    const text = "```ts\n" + "x".repeat(160) + "\n```"
    const view = limitDescription(text, 20)
    expect(view.text).toBe(text)
    expect(view.hidden).toBe(text.length - 20)
  })

  test("treats the default limit as 140 characters", () => {
    const text = "x".repeat(141)
    const view = limitDescription(text)
    expect(view.text).toBe(text)
    expect(view.hidden).toBe(1)
  })
})

describe("confirmOnly", () => {
  test("detects confirm cancel protocol questions", () => {
    expect(
      confirmOnly([
        {
          header: "Confirm plan",
          custom: false,
          options: [
            { label: "Confirm", description: "Approve" },
            { label: "Cancel", description: "Stop" },
          ],
        },
      ]),
    ).toBe(true)
  })

  test("detects confirm questions without options", () => {
    expect(confirmOnly([{ header: "Confirm plan", custom: false, options: [] }])).toBe(true)
  })

  test("detects localized confirm cancel questions", () => {
    expect(
      confirmOnly([
        {
          header: "确认计划",
          custom: false,
          options: [
            { label: "确认", description: "继续执行" },
            { label: "取消", description: "停止执行" },
          ],
        },
      ]),
    ).toBe(true)
  })

  test("does not treat ordinary single choice questions as confirmation", () => {
    expect(
      confirmOnly([
        {
          header: "Choose mode",
          custom: false,
          options: [
            { label: "Fast", description: "Run quickly" },
            { label: "Careful", description: "Run carefully" },
          ],
        },
      ]),
    ).toBe(false)
  })
})

describe("confirmOption", () => {
  test("returns a confirm-like option", () => {
    expect(confirmOption([{ label: "Confirm", description: "Approve" }])?.label).toBe("Confirm")
  })

  test("returns a localized confirm option", () => {
    expect(confirmOption([{ label: "确认", description: "继续" }])?.label).toBe("确认")
  })
})
