import { describe, expect, test } from "bun:test"
import { Command } from "../../src/command"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"

describe("agent-create command", () => {
  test("registers a built-in slash command that runs as a subtask", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cmd = await Command.get("agent-create")
        expect(cmd?.description).toContain("agent")
        expect(cmd?.subtask).toBe(true)
        expect(cmd?.agent).toBe("general")
        expect(await cmd?.template).toContain("agent_generate")
        expect(await cmd?.template).toContain("agent_save")
      },
    })
  })
})
