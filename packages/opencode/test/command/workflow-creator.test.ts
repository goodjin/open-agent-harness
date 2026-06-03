import { describe, expect, test } from "bun:test"
import { Command } from "../../src/command"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"

describe("workflow-creator command", () => {
  test("registers a built-in slash command that runs with the workflow creator agent", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cmd = await Command.get("workflow-creator")
        expect(cmd?.description).toContain("workflow")
        expect(cmd?.subtask).toBe(true)
        expect(cmd?.agent).toBe("workflow-creator")
        expect(await cmd?.template).toContain("workflow_create")
        expect(await cmd?.template).toContain("Do not use `workflow_start`")
      },
    })
  })
})
