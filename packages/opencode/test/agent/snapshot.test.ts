import { describe, expect, test } from "bun:test"
import { AgentSnapshot } from "../../src/agent/snapshot"

const meta = {
  schema_version: "agent.metadata.v1",
  id: "planner",
  name: "Planner",
  role: "Plans work",
  description: "Splits work into tasks",
  agent_version: "1.0.0",
}

describe("AgentSnapshot", () => {
  test("creates stable snapshot hashes for equivalent content", () => {
    const one = AgentSnapshot.create({
      meta,
      identity: {
        content: "identity",
        hash: "identity-hash",
      },
      rules: {
        content: "rules",
        hash: "rules-hash",
      },
      instructions: [
        {
          path: "guide.md",
          resolved: "/repo/agents/planner/guide.md",
          role: "system",
          hash: "guide-hash",
        },
      ],
      source: {
        dir: "/repo/agents/planner",
        package: "opencode",
        revision: "abc123",
      },
    })
    const two = AgentSnapshot.create({
      source: {
        revision: "abc123",
        package: "opencode",
        dir: "/repo/agents/planner",
      },
      instructions: [
        {
          hash: "guide-hash",
          role: "system",
          resolved: "/repo/agents/planner/guide.md",
          path: "guide.md",
        },
      ],
      rules: {
        hash: "rules-hash",
        content: "rules",
      },
      identity: {
        hash: "identity-hash",
        content: "identity",
      },
      meta: {
        description: "Splits work into tasks",
        agent_version: "1.0.0",
        role: "Plans work",
        name: "Planner",
        id: "planner",
        schema_version: "agent.metadata.v1",
      },
    })

    expect(one).toEqual(two)
    expect(one.agent_id).toBe("planner")
    expect(one.agent_version).toBe("1.0.0")
    expect(one.schema_version).toBe("agent.metadata.v1")
    expect(one.agent_snapshot_ref).toBe(`agent://planner@1.0.0#${one.agent_snapshot_hash}`)
  })

  test("changes hash when version or metadata changes", () => {
    const base = AgentSnapshot.create({ meta })
    const version = AgentSnapshot.create({
      meta: {
        ...meta,
        agent_version: "1.0.1",
      },
    })
    const changed = AgentSnapshot.create({
      meta: {
        ...meta,
        description: "Plans and reviews work",
      },
    })

    expect(version.agent_snapshot_hash).not.toBe(base.agent_snapshot_hash)
    expect(changed.agent_snapshot_hash).not.toBe(base.agent_snapshot_hash)
  })

  test("routes deprecated and replacement lifecycle metadata", () => {
    expect(
      AgentSnapshot.route({
        meta: {
          ...meta,
          lifecycle: {
            deprecated: true,
            replacement: "planner-v2",
          },
        },
      }),
    ).toEqual({
      status: "deprecated",
      deprecated: true,
      replacement: "planner-v2",
      action: "replace",
    })

    expect(
      AgentSnapshot.route({
        meta: {
          ...meta,
          lifecycle: {
            status: "retired",
          },
        },
      }),
    ).toEqual({
      status: "retired",
      deprecated: true,
      action: "block",
    })
  })
})
