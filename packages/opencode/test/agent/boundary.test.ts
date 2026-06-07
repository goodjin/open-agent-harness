import { describe, expect, test } from "bun:test"
import { deriveBoundary } from "../../src/agent/boundary"

describe("deriveBoundary", () => {
  test("requires approval before customer support can send email", () => {
    const got = deriveBoundary({
      meta: {
        runtime_boundary: {
          resource_classes: ["email"],
          actions: {
            email: ["communicate"],
          },
        },
      },
      run: {
        allow: [{ resource: "email", action: "communicate" }],
      },
      project: {
        allow: [{ resource: "email", action: "communicate" }],
      },
      user: {
        approval: [{ resource: "email", action: "communicate", reason: "outbound_customer_contact" }],
      },
    })

    expect(got.candidates).toEqual([
      {
        resource: "email",
        action: "communicate",
        status: "approval_required",
        reason: "outbound_customer_contact",
      },
    ])
  })

  test("requires approval before payment spend", () => {
    const got = deriveBoundary({
      meta: {
        runtime_boundary: {
          resource_classes: ["payment"],
          actions: {
            payment: ["spend"],
          },
        },
      },
      run: {
        allow: [{ resource: "payment", action: "spend" }],
      },
      project: {
        allow: [{ resource: "payment", action: "spend" }],
      },
      user: {
        approval: [{ resource: "payment", action: "spend", reason: "spend_requires_human_approval" }],
      },
    })

    expect(got.candidates[0]).toEqual({
      resource: "payment",
      action: "spend",
      status: "approval_required",
      reason: "spend_requires_human_approval",
    })
  })

  test("allows network research read when run and project policies allow it", () => {
    const got = deriveBoundary({
      meta: {
        runtime_boundary: {
          resource_classes: ["network"],
          actions: {
            network: ["read"],
          },
        },
      },
      run: {
        allow: [{ resource: "network", action: "read" }],
      },
      project: {
        allow: [{ resource: "network", action: "read" }],
      },
    })

    expect(got.candidates).toEqual([
      {
        resource: "network",
        action: "read",
        status: "allowed",
        reason: "policy_allowed",
      },
    ])
  })

  test("keeps personal data candidate denied even when metadata asks for redaction", () => {
    const got = deriveBoundary({
      meta: {
        runtime_boundary: {
          resource_classes: ["personal_data"],
          actions: {
            personal_data: ["read"],
          },
          data: {
            redaction: "required",
          },
        },
      },
      run: {
        allow: [{ resource: "personal_data", action: "read" }],
      },
      project: {
        deny: [{ resource: "personal_data", action: "read", reason: "project_blocks_personal_data" }],
      },
    })

    expect(got.candidates).toEqual([
      {
        resource: "personal_data",
        action: "read",
        status: "denied",
        reason: "project_blocks_personal_data",
        constraints: {
          data: {
            redaction: "required",
          },
        },
      },
    ])
  })

  test("allows filesystem write inside declared scope", () => {
    const got = deriveBoundary({
      meta: {
        runtime_boundary: {
          resource_classes: ["filesystem"],
          actions: {
            filesystem: ["write"],
          },
          scopes: {
            filesystem: ["workspace/src/**"],
          },
        },
      },
      run: {
        allow: [{ resource: "filesystem", action: "write", scope: "workspace/src/app.ts" }],
      },
      project: {
        allow: [{ resource: "filesystem", action: "write", scope: "workspace/src/**" }],
      },
    })

    expect(got.candidates).toEqual([
      {
        resource: "filesystem",
        action: "write",
        scope: "workspace/src/**",
        status: "allowed",
        reason: "policy_allowed",
      },
    ])
  })

  test("does not let runtime boundary metadata grant authority by itself", () => {
    const got = deriveBoundary({
      meta: {
        runtime_boundary: {
          resource_classes: ["network"],
          actions: {
            network: ["read"],
          },
        },
      },
      run: {
        allow: [{ resource: "network", action: "read" }],
      },
      project: {
        deny: [{ resource: "network", action: "read", reason: "project_network_disabled" }],
      },
    })

    expect(got.candidates[0]).toEqual({
      resource: "network",
      action: "read",
      status: "denied",
      reason: "project_network_disabled",
    })
  })

  test("maps common tool intent to boundary candidates without metadata grants", () => {
    const got = deriveBoundary({
      meta: {},
      action: {
        operation: "search",
        executor: {
          type: "tool",
          target: "websearch",
          capabilities: [],
        },
      },
      run: {
        allow: [{ resource: "network", action: "read" }],
      },
      project: {
        deny: [{ resource: "network", action: "read", reason: "project_network_disabled" }],
      },
    })

    expect(got.candidates).toEqual([
      {
        resource: "network",
        action: "read",
        status: "denied",
        reason: "project_network_disabled",
      },
    ])
  })

  test("maps task intent to service execution while policy remains authoritative", () => {
    const got = deriveBoundary({
      meta: {},
      action: {
        operation: "task",
        executor: {
          type: "tool",
          target: "task",
          capabilities: [],
        },
      },
      run: {
        allow: [{ resource: "service", action: "execute" }],
      },
      project: {
        approval: [{ resource: "service", action: "execute", reason: "service_execution_review" }],
      },
    })

    expect(got.candidates).toEqual([
      {
        resource: "service",
        action: "execute",
        status: "approval_required",
        reason: "service_execution_review",
      },
    ])
  })
})
