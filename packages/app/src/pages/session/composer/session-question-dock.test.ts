import { describe, expect, test } from "bun:test"
import { answersWithNotes } from "./session-question-dock"

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
