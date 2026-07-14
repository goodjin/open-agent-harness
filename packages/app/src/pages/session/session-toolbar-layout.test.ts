import { describe, expect, test } from "bun:test"

const text = (name: string) => Bun.file(new URL(name, import.meta.url)).text()

describe("session toolbar layout", () => {
  test("keeps global session controls out of the timeline title row", async () => {
    const src = await text("message-timeline.tsx")

    expect(src).not.toContain("StatusPopover")
    expect(src).not.toContain("sessionTree.open")
    expect(src).not.toContain("command.terminal.toggle")
    expect(src).not.toContain("command.review.toggle")
    expect(src).not.toContain("command.fileTree.toggle")
  })

  test("mounts global controls in the topbar and exposes right panel collapse", async () => {
    const page = await text("../session.tsx")
    const side = await text("session-side-panel.tsx")

    expect(page).toContain("opencode-titlebar-right")
    expect(page).toContain("StatusPopover")
    expect(page).toContain("sessionTree.open")
    expect(page).toContain("command.terminal.toggle")
    expect(page).toContain("command.review.toggle")
    expect(page).toContain("command.fileTree.toggle")
    expect(page).toContain("toggleSidePanel")
    expect(page).toContain("session.panel.expand")
    expect(side).toContain("view().reviewPanel.close()")
    expect(side).toContain("session.panel.collapse")
  })

  test("offers protocol runs beside timeline and logs", async () => {
    const page = await text("../session.tsx")

    expect(page).toContain('sessionView: "timeline" as "timeline" | "logs" | "runs"')
    expect(page).toContain('language.t("session.tab.runs")')
    expect(page).toContain("<SessionRuns sessionID={id} />")
  })
})
