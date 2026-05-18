import { describe, expect, mock, test } from "bun:test"
import type { AgentManageInfo, AgentManageValidateOutput } from "@opencode-ai/sdk/v2"
import { fill, input, load, save, summary, toggle } from "./settings-agents-helpers"

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
