import { describe, expect, test } from "bun:test"
import { MESSAGE_VISIBLE_LINE_LIMIT, limitTextLines } from "./message-line-limit"

describe("limitTextLines", () => {
  test("keeps text within the configured line limit", () => {
    const text = ["one", "two", "three"].join("\n")

    expect(limitTextLines(text, 3)).toEqual({
      text,
      hidden: 0,
      limit: 3,
    })
  })

  test("shows the last lines and reports hidden count", () => {
    expect(limitTextLines(["one", "two", "three", "four"].join("\n"), 2)).toEqual({
      text: "three\nfour",
      hidden: 2,
      limit: 2,
    })
  })

  test("normalizes invalid limits to one line", () => {
    expect(limitTextLines("one\ntwo", 0)).toEqual({
      text: "two",
      hidden: 1,
      limit: 1,
    })
  })

  test("defaults to 160 visible lines", () => {
    const text = Array.from({ length: MESSAGE_VISIBLE_LINE_LIMIT + 1 }, (_, index) => String(index + 1)).join("\n")

    expect(limitTextLines(text)).toEqual({
      text: Array.from({ length: MESSAGE_VISIBLE_LINE_LIMIT }, (_, index) => String(index + 2)).join("\n"),
      hidden: 1,
      limit: MESSAGE_VISIBLE_LINE_LIMIT,
    })
  })
})
