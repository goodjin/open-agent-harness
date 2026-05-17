import { describe, expect, test } from "bun:test"
import { Config } from "../../src/config/config"

describe("config plugin removal", () => {
  test("rejects legacy top-level plugin config", () => {
    const result = Config.Info.safeParse({
      plugin: ["legacy-plugin"],
    })

    expect(result.success).toBe(false)
    if (result.success) return

    expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("")
  })

  test("does not expose top-level plugin in openapi config", async () => {
    const spec = await Bun.file(new URL("../../../sdk/openapi.json", import.meta.url)).json()

    expect(spec.components.schemas.Config.properties.plugin).toBeUndefined()
  })
})
