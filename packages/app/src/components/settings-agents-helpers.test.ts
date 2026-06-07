import { describe, expect, mock, test } from "bun:test"
import type { AgentManageInfo, AgentManageValidateOutput } from "@open-agent-harness/sdk/v2"
import { fill, input, json, load, overview, save, summary, tabs, toggle, typed, versions } from "./settings-agents-helpers"

let valid: AgentManageValidateOutput = { valid: true, diagnostics: [] }

const calls = {
  list: mock(async () => ({ data: [agent()] })),
  validate: mock(async () => ({ data: valid })),
  create: mock(async () => ({ data: agent() })),
  update: mock(async () => ({ data: agent() })),
  state: mock(async () => ({ data: agent() })),
}

function agent(next: Partial<AgentManageInfo> = {}): AgentManageInfo {
  return {
    id: "reviewer",
    name: "Reviewer",
    disabled: false,
    kind: "agent",
    source: "project",
    editable: true,
    meta: {
      id: "reviewer",
      name: "Reviewer",
      role: "review",
      description: "Reviews code",
      model_preference: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4-20250514",
      },
      mode: "subagent",
      runner: "chat",
      workflow_mode: "manual",
      entry: {
        primary: false,
        delegable: true,
        mentionable: true,
        default: false,
        hidden: false,
      },
      capability: {
        purpose: "review",
        tags: ["code", "quality"],
        cost: "medium",
        writes: false,
      },
      hidden: false,
      permission_mode: "custom",
      allowed_tools: ["grep"],
      denied_tools: ["write"],
      inherit_permissions: true,
    },
    identity: "You review changes.",
    rules: "Be specific.",
    effective: {
      name: "Reviewer",
      description: "Reviews code",
      mode: "subagent",
      entry: {
        delegable: true,
        mentionable: true,
      },
      capability: {
        purpose: "review",
        tags: ["code", "quality"],
        cost: "medium",
        writes: false,
      },
      runner: "chat",
      hidden: false,
      disabled: false,
    },
    diagnostics: [],
    ...next,
  }
}

describe("settings agent helpers", () => {
  test("loads manageable agents and formats list summaries", async () => {
    const items = await load(calls)

    expect(items.map((item) => item.name)).toEqual(["Reviewer"])
    expect(summary(items[0])).toBe("chat / subagent / delegable, mentionable")
    expect(fill(items[0])).toMatchObject({
      scope: "project",
      id: "reviewer",
      allowed: "grep",
      denied: "write",
      inherit: true,
    })
  })

  test("labels and filters skill-backed agents", () => {
    const items = [
      agent(),
      agent({
        id: "skill-reviewer",
        name: "Skill Reviewer",
        kind: "skill",
        editable: false,
        source: "user",
        meta: {
          ...agent().meta,
          id: "skill-reviewer",
          name: "Skill Reviewer",
          capability: {
            purpose: "legacy_skill",
            tags: ["skill", "skill-reviewer"],
            cost: "medium",
            writes: true,
          },
        },
      }),
    ]

    expect(tabs).toEqual(["all", "agent", "skill"])
    expect(typed(items, "skill").map((item) => item.id)).toEqual(["skill-reviewer"])
    expect(summary(items[1])).toContain("legacy skill")
  })

  test("builds a save payload with editable schema fields", () => {
    const form = fill(agent())
    const body = input({
      ...form,
      name: " Reviewer ",
      tags: " code, quality\nrisk ",
      allowed: "grep\nread",
      denied: "write, bash",
    })

    expect(body).toMatchObject({
      scope: "project",
      meta: {
        id: "reviewer",
        name: "Reviewer",
        role: "review",
        description: "Reviews code",
        mode: "subagent",
        runner: "chat",
        workflow_mode: "manual",
        model_preference: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-20250514",
        },
        entry: {
          delegable: true,
          mentionable: true,
        },
        capability: {
          purpose: "review",
          tags: ["code", "quality", "risk"],
          cost: "medium",
          writes: false,
        },
        permission_mode: "custom",
        allowed_tools: ["grep", "read"],
        denied_tools: ["write", "bash"],
        inherit_permissions: true,
      },
      identity: "You review changes.",
      rules: "Be specific.",
    })
  })

  test("validates and saves the selected agent override", async () => {
    calls.validate.mockClear()
    calls.update.mockClear()
    valid = { valid: true, diagnostics: [] }

    const out = await save(calls, fill(agent()), "edit")

    expect(out).toEqual({ ok: true, id: "reviewer", diagnostics: [] })
    expect(calls.validate).toHaveBeenCalledTimes(1)
    expect(calls.update).toHaveBeenCalledTimes(1)
    const call = calls.update.mock.calls[0] as unknown[] | undefined
    expect(call?.[0]).toMatchObject({
      id: "reviewer",
      agentManagePatchInput: {
        scope: "project",
        meta: {
          id: "reviewer",
          name: "Reviewer",
          permission_mode: "custom",
          allowed_tools: ["grep"],
          denied_tools: ["write"],
          inherit_permissions: true,
        },
      },
    })
  })

  test("preserves unseen metadata fields on no-op save", async () => {
    calls.validate.mockClear()
    calls.update.mockClear()
    valid = { valid: true, diagnostics: [] }

    await save(calls, fill(agent()), "edit")

    const call = calls.update.mock.calls[0] as unknown[] | undefined
    expect(call?.[0]).toMatchObject({
      agentManagePatchInput: {
        meta: {
          workflow_mode: "manual",
          model_preference: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
          },
        },
      },
    })
  })

  test("round-trips raw RFC metadata while basic fields override", async () => {
    calls.validate.mockClear()
    calls.update.mockClear()
    valid = { valid: true, diagnostics: [] }

    const form = fill(
      agent({
        meta: {
          ...agent().meta,
          schema_version: "agent.metadata.v1",
          agent_version: "2026.06.02",
          logo: {
            uri: "file://agents/reviewer.svg",
            alt: "Reviewer",
            theme: "auto",
            hash: "sha256:reviewer",
          },
          instructions: {
            files: [{ path: "identity.md", role: "system", required: true }],
            model_messages: [
              {
                on: "before_run",
                position: "prepend",
                content: "Check the pull request context first.",
              },
            ],
          },
          contracts: {
            input: [{ kind: "diff" }],
            output: [{ kind: "review" }],
          },
          collaboration: {
            edges: [{ to: "implementer", mode: "handoff" }],
            limits: { max_handoffs: 2 },
          },
          runtime_boundary: {
            resource_classes: ["repo"],
            actions: { allow: ["read", "grep"] },
            network: { mode: "disabled" },
            data: { retention: "session" },
            approval: { required: ["write"] },
            rate_limits: { actions_per_minute: 20 },
          },
          completion: {
            mode: "gated",
            criteria: ["findings complete"],
            required_artifacts: ["review.md"],
            required_evidence: ["test output"],
            gates: [{ type: "tests" }],
            allow_partial: false,
          },
          observability: {
            trace: true,
            audit: "recorded",
          },
          lifecycle: {
            owner: "platform",
            deprecated: false,
          },
        },
      }),
    )

    expect(form.raw).toMatchObject({
      schema_version: "agent.metadata.v1",
      runtime_boundary: {
        resource_classes: ["repo"],
      },
      lifecycle: {
        owner: "platform",
      },
    })

    await save(
      calls,
      {
        ...form,
        name: " Senior Reviewer ",
        runner: "protocol",
        purpose: "risk review",
        allowed: "grep\nread",
      },
      "edit",
    )

    const call = calls.update.mock.calls[0] as unknown[] | undefined
    expect(call?.[0]).toMatchObject({
      agentManagePatchInput: {
        meta: {
          schema_version: "agent.metadata.v1",
          agent_version: "2026.06.02",
          logo: {
            uri: "file://agents/reviewer.svg",
            alt: "Reviewer",
            theme: "auto",
            hash: "sha256:reviewer",
          },
          instructions: {
            files: [{ path: "identity.md", role: "system", required: true }],
            model_messages: [
              {
                on: "before_run",
                position: "prepend",
                content: "Check the pull request context first.",
              },
            ],
          },
          contracts: {
            input: [{ kind: "diff" }],
            output: [{ kind: "review" }],
          },
          collaboration: {
            edges: [{ to: "implementer", mode: "handoff" }],
            limits: { max_handoffs: 2 },
          },
          runtime_boundary: {
            resource_classes: ["repo"],
            actions: { allow: ["read", "grep"] },
            network: { mode: "disabled" },
            data: { retention: "session" },
            approval: { required: ["write"] },
            rate_limits: { actions_per_minute: 20 },
          },
          completion: {
            mode: "gated",
            criteria: ["findings complete"],
            required_artifacts: ["review.md"],
            required_evidence: ["test output"],
            gates: [{ type: "tests" }],
            allow_partial: false,
          },
          observability: {
            trace: true,
            audit: "recorded",
          },
          lifecycle: {
            owner: "platform",
            deprecated: false,
          },
          name: "Senior Reviewer",
          runner: "protocol",
          capability: {
            purpose: "risk review",
          },
          allowed_tools: ["grep", "read"],
        },
      },
    })
  })

  test("formats visible RFC metadata overview and raw json", () => {
    const form = fill(
      agent({
        diagnostics: [
          {
            level: "warning",
            category: "metadata",
            field: "lifecycle.replacement",
            message: "Replacement target is missing.",
          },
        ],
        meta: {
          ...agent().meta,
          schema_version: "agent.metadata.v1",
          agent_version: "2026.06.02",
          instructions: {
            files: [{ path: "identity.md" }, { path: "rules.md" }],
            model_messages: [{ on: "before_run", position: "prepend", content: "Read context." }],
          },
          contracts: {
            input: [{ kind: "diff" }, { kind: "issue" }],
            output: [{ kind: "review" }],
          },
          collaboration: {
            edges: [{ to: "implementer" }, { to: "planner" }],
          },
          runtime_boundary: {
            resource_classes: ["repo", "shell"],
          },
          completion: {
            required_artifacts: ["review.md", "evidence.md"],
          },
          lifecycle: {
            deprecated: true,
            replacement: "senior-reviewer",
          },
        },
      }),
    )

    expect(versions(form.raw)).toEqual(["schema agent.metadata.v1", "agent 2026.06.02"])
    expect(overview(form.raw)).toEqual([
      "instructions 3",
      "contracts 2 input / 1 output",
      "edges 2",
      "resources 2",
      "artifacts 2",
      "deprecated -> senior-reviewer",
    ])
    expect(json(form)).toContain('"schema_version": "agent.metadata.v1"')
    expect(json(form)).toContain('"replacement": "senior-reviewer"')
  })

  test("sends empty strings when clearing identity and rules", () => {
    const body = input({
      ...fill(agent()),
      identity: "   ",
      rules: "",
    })

    expect(body.identity).toBe("")
    expect(body.rules).toBe("")
  })

  test("returns diagnostics without saving invalid input", async () => {
    calls.validate.mockClear()
    calls.update.mockClear()
    valid = {
      valid: false,
      diagnostics: [{ level: "error", message: "Name is required", field: "name" }],
    }

    const out = await save(calls, fill(agent()), "edit")

    expect(out).toEqual({ ok: false, diagnostics: valid.diagnostics })
    expect(calls.validate).toHaveBeenCalledTimes(1)
    expect(calls.update).not.toHaveBeenCalled()
  })

  test("toggles agent state through project scope", async () => {
    calls.state.mockClear()

    await toggle(calls, agent())

    expect(calls.state).toHaveBeenCalledWith(
      {
        id: "reviewer",
        agentManageStateInput: {
          scope: "project",
          disabled: true,
        },
      },
      { throwOnError: true },
    )
  })

  test("toggles user agents through user scope", async () => {
    calls.state.mockClear()

    await toggle(calls, agent({ source: "user" }))

    expect(calls.state).toHaveBeenCalledWith(
      {
        id: "reviewer",
        agentManageStateInput: {
          scope: "user",
          disabled: true,
        },
      },
      { throwOnError: true },
    )
  })
})
