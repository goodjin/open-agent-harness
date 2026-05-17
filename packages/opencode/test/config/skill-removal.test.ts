import { describe, expect, test } from "bun:test"
import { Config } from "../../src/config/config"

describe("config skill removal", () => {
  test("rejects legacy top-level skills config", () => {
    const result = Config.Info.safeParse({
      skills: {
        paths: [".opencode/skill"],
      },
    })

    expect(result.success).toBe(false)
    if (result.success) return

    expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("")
  })

  test("rejects legacy skill permission config", () => {
    const result = Config.Info.safeParse({
      permission: {
        skill: "allow",
      },
    })

    expect(result.success).toBe(false)
    if (result.success) return

    expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("permission.skill")
  })
})
