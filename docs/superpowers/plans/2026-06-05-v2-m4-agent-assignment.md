# v2 M4 Agent Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make Agent templates, routing candidates, Assignments, and Agent Sessions first-class Harness runtime objects.

**Architecture:** Add M4 contracts inside the existing `Harness` namespace without replacing the current package agent loader. Store v2 agent templates and sessions under the run/governance harness store, create assignments from `kind: "act"` / `type: "agent"` actions, and expose a routing filter that uses entry, capability, permission, relationships, availability, budget, and projection hints.

**Tech Stack:** TypeScript, Zod, Bun file APIs, existing `HarnessStore`, existing `HarnessRuntime`, Bun test from `packages/opencode`.

---

## File Structure

- Modify: `packages/opencode/src/harness/schema.ts`
  - Add `AgentKind`, `AgentEntry`, `AgentCapability`, `AgentPermission`, `AgentTemplateRecord`, `AgentSessionRecord`, `AgentRoute`, and `AgentAssignmentInput`.
  - Extend `ActionRecord.type` behavior only through runtime; no schema split needed.
- Modify: `packages/opencode/src/harness/store.ts`
  - Persist v2 agent templates under `.opencode/harness/governance/agents/templates/`.
  - Persist agent sessions under `.opencode/harness/runs/<run>/agent-sessions/`.
  - Add query and put helpers.
- Modify: `packages/opencode/src/harness/runtime.ts`
  - Add `putAgentTemplate`, `agentTemplates`, `routeAgents`, and `assignAgent`.
  - When assigning an agent action, create a regular `Assignment` plus an `AgentSessionRecord`.
- Create: `packages/opencode/test/harness/agent-assignment.test.ts`
  - Cover metadata validation, routing candidate filtering, and assignment/session creation.
- Create: `docs/harness-platform-prd-v2/06-v2-agent-assignment.md`
  - Document M4 contracts and migration boundary.
- Modify: `docs/harness-platform-prd-v2/README.md`
  - Link the new M4 doc.

### Task 1: Add Failing Agent Template And Routing Tests

**Files:**
- Create: `packages/opencode/test/harness/agent-assignment.test.ts`

- [x] **Step 1: Write failing metadata/routing tests**

```ts
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import { HarnessRuntime, HarnessStore } from "../../src/harness"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const dirs: string[] = []

async function temp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-harness-agent-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("harness agent assignment", () => {
  test("validates v2 agent template metadata", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const agent = await HarnessRuntime.putAgentTemplate({
          id: "agent_planner",
          identity: "Planner",
          kind: "planner",
          entry: { primary: true, delegable: true, mentionable: true },
          capability: { tags: ["planning"], writes: false, cost: "low" },
          permission: { tools: ["read"], scopes: ["project"], write: false },
          model_preference: { provider: "openai", model: "gpt-5" },
          execution_mode: "protocol",
          relationships: { supervises: ["agent_worker"], peers: [] },
          orchestration_policy: { max_parallel: 2, review_required: true },
          availability: "available",
        })
        const list = await HarnessStore.agentTemplates()

        expect(agent.kind).toBe("planner")
        expect(agent.entry.delegable).toBe(true)
        expect(agent.permission.write).toBe(false)
        expect(list).toHaveLength(1)
      },
    })
  })

  test("filters routing candidates by entry capability permission and budget", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        await HarnessRuntime.putAgentTemplate({
          id: "agent_worker",
          identity: "Worker",
          kind: "worker",
          entry: { primary: false, delegable: true, mentionable: true },
          capability: { tags: ["implementation"], writes: true, cost: "medium" },
          permission: { tools: ["bash", "edit"], scopes: ["project"], write: true },
          execution_mode: "chat",
          relationships: { supervises: [], peers: ["agent_verifier"] },
          orchestration_policy: { max_parallel: 1, review_required: false },
          availability: "available",
        })
        await HarnessRuntime.putAgentTemplate({
          id: "agent_hidden",
          identity: "Hidden",
          kind: "helper",
          entry: { primary: false, delegable: false, mentionable: false },
          capability: { tags: ["implementation"], writes: true, cost: "high" },
          permission: { tools: ["edit"], scopes: ["private"], write: true },
          execution_mode: "chat",
          relationships: { supervises: [], peers: [] },
          orchestration_policy: { max_parallel: 1, review_required: false },
          availability: "busy",
        })

        const route = await HarnessRuntime.routeAgents({
          entry: "delegable",
          capability: ["implementation"],
          permission: { write: true, scopes: ["project"] },
          budget: { max_cost: "medium" },
          projection: { run_id: "run_01", ready: ["act_01"] },
        })

        expect(route.candidates.map((item) => item.id)).toEqual(["agent_worker"])
        expect(route.excluded).toContainEqual({ id: "agent_hidden", reason: "entry unavailable" })
      },
    })
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test test/harness/agent-assignment.test.ts`

Expected: FAIL because M4 schemas/store/runtime APIs are not implemented.

### Task 2: Add Agent Contracts

**Files:**
- Modify: `packages/opencode/src/harness/schema.ts`

- [x] **Step 1: Add schemas**

Add `AgentKind`, `AgentTemplateRecord`, `AgentSessionRecord`, `AgentRoute`, and `AgentAssignmentInput` near the other v2 object schemas.

- [x] **Step 2: Run test to verify schema-only progress**

Run: `bun test test/harness/agent-assignment.test.ts`

Expected: still FAIL until store/runtime methods exist.

### Task 3: Add Agent Store

**Files:**
- Modify: `packages/opencode/src/harness/store.ts`

- [x] **Step 1: Add template/session store methods**

Persist templates under governance and sessions under each run.

- [x] **Step 2: Run test to verify store-only progress**

Run: `bun test test/harness/agent-assignment.test.ts`

Expected: still FAIL until runtime methods exist.

### Task 4: Add Runtime Agent APIs

**Files:**
- Modify: `packages/opencode/src/harness/runtime.ts`

- [x] **Step 1: Add put/list/route methods**

Implement `putAgentTemplate`, `agentTemplates`, and `routeAgents`.

- [x] **Step 2: Run routing tests**

Run: `bun test test/harness/agent-assignment.test.ts`

Expected: metadata and routing tests pass.

### Task 5: Add Failing Assignment Session Tests

**Files:**
- Modify: `packages/opencode/test/harness/agent-assignment.test.ts`

- [x] **Step 1: Add assignment/session test**

Append a test that creates a run, accepts an agent action, assigns a template, and verifies both `Assignment` and `AgentSessionRecord`.

- [x] **Step 2: Run test to verify it fails if assignment path is missing**

Run: `bun test test/harness/agent-assignment.test.ts`

Expected: FAIL until `assignAgent()` is implemented.

### Task 6: Implement Assignment Session Creation

**Files:**
- Modify: `packages/opencode/src/harness/runtime.ts`

- [x] **Step 1: Add assignAgent()**

Create `Assignment`, persist `AgentSessionRecord`, append `agent.assigned`, update projections, and return both records.

- [x] **Step 2: Run M4 tests**

Run: `bun test test/harness/agent-assignment.test.ts`

Expected: all M4 tests pass.

### Task 7: Document M4

**Files:**
- Create: `docs/harness-platform-prd-v2/06-v2-agent-assignment.md`
- Modify: `docs/harness-platform-prd-v2/README.md`

- [x] **Step 1: Add M4 doc**

Document template fields, routing, assignment/session separation, and migration boundary from existing `config/agents`.

- [x] **Step 2: Link README**

Add M4 doc row.

### Task 8: Final Verification

**Files:**
- Verify all touched files.

- [x] **Step 1: Run focused M4 tests**

Run: `bun test test/harness/agent-assignment.test.ts test/harness/resource-fabric.test.ts test/harness/action-graph.test.ts test/harness/runtime.test.ts test/harness/object-model.test.ts`

Expected: all tests pass.

- [x] **Step 2: Run package typecheck**

Run: `bun typecheck`

Expected: exit 0.

## Self-Review

- AC-M4-001 covered by `AgentTemplateRecord`.
- AC-M4-002 covered by `AgentKind`.
- AC-M4-003 covered by `AgentSessionRecord`.
- AC-M4-004 covered by `assignAgent()` and assignment/session tests.
- AC-M4-005 covered by `routeAgents()` routing filters.
