import { expect, test } from "bun:test"
import { persistFollowup } from "./session-followup"

test("persists queued followups immediately after adding the optimistic item", () => {
  const events: string[] = []
  persistFollowup({
    item: { id: "msg_1" },
    append: (item) => events.push(`append:${item.id}`),
    send: (id) => events.push(`send:${id}`),
  })

  expect(events).toEqual(["append:msg_1", "send:msg_1"])
})
