import { describe, expect, test } from "bun:test"
import { AgentVerification } from "../../src/protocol/verification-policy"
import type { AgentProtocol } from "../../src/protocol/schema"

const worker: AgentProtocol.Action = {
  type: "action",
  id: "backend_patch",
  title: "Patch backend",
  operation: "backend",
  executor: { type: "agent", target: "backend", capabilities: [] },
  input: { prompt: "Change the API and run bun test test/api.test.ts." },
  depends_on: [],
  context_refs: [],
  result_policy: "summary",
}

const agents: AgentVerification.Info[] = [
  {
    name: "backend",
    kind: "worker",
    capability: {
      purpose: "backend_implementation",
      tags: ["backend", "api"],
      cost: "medium",
      writes: true,
    },
  },
  {
    name: "backend-verifier",
    kind: "verifier",
    capability: {
      purpose: "backend_verification",
      tags: ["verification", "backend"],
      cost: "low",
      writes: false,
    },
  },
]

describe("agent verification policy", () => {
  test("injects test and review verifier actions for high-risk workers", () => {
    const out = AgentVerification.apply({ actions: [worker], agents })

    expect(out.actions.map((item) => [item.id, item.verification?.role, item.executor.target, item.depends_on])).toEqual([
      ["backend_patch", undefined, "backend", []],
      ["backend_patch_test", "test", "backend-verifier", ["backend_patch"]],
      ["backend_patch_review", "review", "backend-verifier", ["backend_patch", "backend_patch_test"]],
    ])
    expect(out.injected.map((item) => [item.id, item.role, item.worker, item.target])).toEqual([
      ["backend_patch_test", "test", "backend_patch", "backend-verifier"],
      ["backend_patch_review", "review", "backend_patch", "backend-verifier"],
    ])
  })

  test("does not duplicate an explicitly declared verifier role", () => {
    const out = AgentVerification.apply({
      actions: [
        worker,
        {
          type: "action",
          id: "backend_patch_review",
          title: "Review backend",
          operation: "review",
          executor: { type: "agent", target: "backend-verifier", capabilities: ["review"] },
          depends_on: ["backend_patch"],
          context_refs: [],
          verification: { role: "review", worker: "backend_patch" },
          result_policy: "structured",
        },
      ],
      agents,
    })

    expect(out.actions.map((item) => item.id)).toEqual(["backend_patch", "backend_patch_test", "backend_patch_review"])
    expect(out.injected.map((item) => item.role)).toEqual(["test"])
  })

  test("skips test verification when the worker summary reports no changes", () => {
    const text = [
      "kind: success",
      "task_background: Inspect backend.",
      "task_content: Check whether a patch is needed.",
      "completion_summary: No code change was needed.",
      "changed_files: none",
      "verification: inspected the relevant files",
      "blockers: none",
    ].join("\n")

    expect(
      AgentVerification.nochange({
        action: {
          ...worker,
          verification: { role: "test", worker: "backend_patch", allow_skip_on_no_change: true },
        },
        output: text,
      }),
    ).toContain("Verification test skipped")
  })
})
