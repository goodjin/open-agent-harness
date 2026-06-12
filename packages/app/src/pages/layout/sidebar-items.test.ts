import { describe, expect, test } from "bun:test"

describe("sidebar session title layout", () => {
  test("clips title by available width instead of a fixed character budget", async () => {
    const src = await Bun.file(new URL("./sidebar-items.tsx", import.meta.url)).text()

    expect(src).not.toContain("titleLabel().slice")
    expect(src).not.toContain("displaySessionTitle(props.session).slice")
    expect(src).toContain('data-session-title')
    expect(src).toContain('data-session-title-text')
    expect(src).toContain('class="flex-1 min-w-0 overflow-hidden"')
    expect(src).toContain('class="w-full min-w-0 overflow-hidden"')
    expect(src).toContain('class="block w-fit max-w-full truncate')
  })
})
