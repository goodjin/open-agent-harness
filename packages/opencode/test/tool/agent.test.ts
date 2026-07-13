import { describe, expect, test } from "bun:test"
import path from "path"
import z from "zod"
import { AgentCreateTool, AgentSaveTool } from "../../src/tool/agent"
import { AgentTemplate } from "../../src/agent/schema"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { MessageID, SessionID } from "../../src/session/schema"

function ctx() {
  return {
    sessionID: SessionID.descending(),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata() {},
    async ask() {},
  }
}

describe("agent tools", () => {
  test("exposes json-schema-safe save parameters", async () => {
    const tool = await AgentSaveTool.init()

    expect(() => z.toJSONSchema(tool.parameters)).not.toThrow()
  })

  test("saves a generated agent template through the structured tool", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await AgentSaveTool.init()
        const out = await tool.execute(
          {
            scope: "project",
            meta: AgentTemplate.Meta.parse({
              id: "risk",
              name: "Risk",
              role: "You analyze risk.",
              description: "Use when analyzing risky changes.",
              mode: "subagent",
              capability: {
                purpose: "risk",
                tags: ["review"],
                cost: "low",
                writes: false,
              },
              permission_mode: "custom",
              allowed_tools: ["read"],
              denied_tools: ["edit"],
            }),
            identity: "# Identity\n\nYou analyze risk.",
            rules: "# Rules\n\n- Stay read-only.",
          },
          ctx(),
        )

        expect(out.output).toContain("risk")
        expect(await Bun.file(path.join(tmp.path, ".opencode", "agents", "risk", "identity.md")).text()).toContain(
          "analyze risk",
        )
      },
    })
  })

  test("creates hidden dynamic action agents with ActionResult footer", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await AgentCreateTool.init()
        const out = await tool.execute(
          {
            scope: "project",
            id: "m1-f1-worker",
            kind: "worker",
            subtype: "backend",
            identity_name: "后端开发",
            persona_name: "沈越",
            description: "Implement a bounded backend task.",
            identity: "",
            rules: "",
          },
          ctx(),
        )

        const meta = await Bun.file(path.join(tmp.path, ".opencode", "agents", "m1-f1-worker", "meta.json")).json()
        expect(out.output).toContain("后端开发-沈越")
        expect(meta.entry).toEqual({
          primary: false,
          delegable: true,
          mentionable: false,
          default: false,
          hidden: true,
        })
        expect(meta.request_footer).toEqual({ file: "action-worker.md" })
      },
    })
  })
})
