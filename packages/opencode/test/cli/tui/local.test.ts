import { describe, expect, test } from "bun:test"
import type { Agent } from "@opencode-ai/sdk/v2"
import { LocalAgent } from "../../../src/cli/cmd/tui/context/agent-state"

function agent(name: string): Agent {
  return {
    name,
    description: `${name} agent`,
    mode: "primary",
    entry: {
      primary: true,
      delegable: true,
      mentionable: true,
      default: true,
      hidden: false,
    },
    capability: {
      purpose: "test",
      tags: [],
      cost: "medium",
      writes: false,
    },
    native: false,
    hidden: false,
    permission: [],
    options: {},
  }
}

function entry(name: string, primary: boolean): Agent {
  return {
    ...agent(name),
    mode: "subagent",
    entry: {
      primary,
      delegable: true,
      mentionable: true,
      default: primary,
      hidden: false,
    },
  } as Agent
}

describe("tui local agent state", () => {
  test("uses server agents without a local instance registry", () => {
    const list = LocalAgent.list([agent("build"), agent("plan")])

    expect(list.map((item) => item.name)).toEqual(["build", "plan"])
  })

  test("uses entry primary before legacy mode for server agents", () => {
    const list = LocalAgent.list([entry("build", true), entry("helper", false)])

    expect(list.map((item) => item.name)).toEqual(["build"])
  })

  test("initializes from default_agent after server agents load", () => {
    const list = LocalAgent.list([agent("build"), agent("plan")])

    expect(LocalAgent.pick({ list, config: "plan" })).toBe("plan")
  })

  test("keeps an explicit user selection when default_agent changes", () => {
    const list = LocalAgent.list([agent("build"), agent("plan")])

    expect(LocalAgent.pick({ list, config: "plan", current: "build" })).toBe("build")
  })
})
