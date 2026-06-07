import { describe, expect, test } from "bun:test"
import type { Message } from "@open-agent-harness/sdk/v2/client"
import { agentName, lastAssistant, lastUser, metaSummary, modelName, parentLabel, short, statusName, timeAgo, totals } from "./session-insight-banner-helpers"

const messages: Message[] = [
  {
    id: "msg_user",
    sessionID: "ses",
    role: "user",
    time: { created: 1 },
    agent: "default",
    model: { providerID: "kimi", modelID: "k2" },
  },
  {
    id: "msg_assistant",
    sessionID: "ses",
    role: "assistant",
    time: { created: 2 },
    parentID: "msg_user",
    providerID: "kimi",
    modelID: "k2",
    mode: "build",
    agent: "default",
    path: { cwd: ".", root: "." },
    cost: 0.12,
    tokens: {
      input: 100,
      output: 20,
      reasoning: 5,
      cache: { read: 7, write: 3 },
    },
  },
]

describe("session insight banner helpers", () => {
  test("builds compact identity and usage labels", () => {
    expect(short("ses_abcdefghijklmnopqrstuvwxyz")).toBe("abcdefgh")
    expect(lastUser(messages)?.agent).toBe("default")
    expect(lastAssistant(messages)?.agent).toBe("default")
    expect(agentName({ user: lastUser(messages), assistant: lastAssistant(messages) })).toBe("default")
    expect(modelName({ user: lastUser(messages), providers: [{ id: "kimi", models: { k2: { name: "Kimi K2" } } }] })).toBe("Kimi K2")
    expect(statusName({ type: "running" })).toBe("running")
  })

  test("summarizes assistant token totals", () => {
    expect(totals(messages)).toEqual({
      input: 100,
      output: 20,
      reasoning: 5,
      cache: 10,
      cost: 0.12,
    })
  })

  test("formats metadata and lineage summaries", () => {
    expect(
      metaSummary({
        schema_version: "agent.metadata.v1",
        agent_version: "1.0.0",
        contracts: { input: [{}], output: [{}, {}] },
        collaboration: { edges: [{}, {}] },
        runtime_boundary: { resource_classes: ["service.execute"] },
        completion: { required_artifacts: ["plan"] },
      }),
    ).toEqual([
      "schema agent.metadata.v1",
      "agent 1.0.0",
      "contracts 1 in / 2 out",
      "edges 2",
      "resources 1",
      "artifacts 1",
    ])
    expect(parentLabel({ parentID: "ses_parent" }, { id: "ses_parent", title: "Parent title" })).toBe("Parent title")
    expect(timeAgo(Date.now() - 61_000)).toBe("1m ago")
  })
})
