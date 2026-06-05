# M9-M11 Governance, Performance, SDK/Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend v2 governance, performance prep, and SDK-facing contracts from M9 through M11 with tests-first changes.

**Architecture:** Keep backend route-level contracts stable in v2 runtime/store APIs, then expose those contracts in the Harness Console UI panels and finally add lightweight performance/evaluation scaffolds and SDK contract assertions without changing existing persistence semantics.

**Tech Stack:** TypeScript, Bun, Hono, SolidJS, Bun test, OpenAPI + sdk generator.

---

### Task 1: Fix and complete M9 governance route coverage

**Files:**
- Modify: `packages/opencode/test/server/harness-governance-routes.test.ts`
- Modify: `packages/opencode/src/server/routes/harness.ts`
- Add: `packages/opencode/src/server/harness-governance-panel.fixture.ts` (optional)

- [ ] **Step 1: Make the governance route test reflect actual API behavior and fail only on missing feature behavior**

```ts
test("reads resources, sessions, handoffs and acceptance for run", async () => {
  // setup run, resource, session, handoff, acceptance and template, then assert endpoint list endpoints all return arrays and expected IDs
})
```

- [ ] **Step 2: Run test to verify it still fails before implementation adjustments**

Run: `bun test test/server/harness-governance-routes.test.ts`

- [ ] **Step 3: Minimal code fix to keep contract stable**

```ts
await Instance.provide({ directory: dir, fn: async () => {
  // create template before assignAgent to avoid foreign-key/lookup failures
}})
```

- [ ] **Step 4: Run and verify pass**

Run: `bun test test/server/harness-governance-routes.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/test/server/harness-governance-routes.test.ts
git commit -m "test: fix m9 governance governance route contract test"
```

### Task 2: Implement M9 governance panels and panel-state helpers in Harness UI

**Files:**
- Modify: `packages/app/src/pages/harness.tsx`
- Add: `packages/app/src/pages/harness.test.ts`

- [ ] **Step 1: Add runtime data loads for new governance panels**

```ts
const [runResources, resact] = createResource(run, (id) => api<[] >(`/runs/${id}/resources`))
const [runAgents, agact] = createResource(run, (id) => api<[] >(`/runs/${id}/agent-sessions`))
const [runHandoffs, handact] = createResource(run, (id) => api<[] >(`/runs/${id}/handoffs`))
const [runAcceptance, gacct] = createResource(run, (id) => api<[] >(`/runs/${id}/acceptance`))
const [agentTemplates, tempact] = createResource(() => api<[] >"/agent-templates")
```

- [ ] **Step 2: Add new tabs and panel components for Resource/Agent/Handoff/Workflow/Acceptance**

- [ ] **Step 3: Add state-aware panel bodies for empty/loading/populated/blocked/error text buckets**

- [ ] **Step 4: Write focused panel-state tests for each panel contract path**

```ts
test("panel state fallback messages are deterministic", () => {
  expect(panelState({ status: "empty" })).toBe("暂无资源")
})
```

- [ ] **Step 5: Run app typecheck and unit tests**

Run: `bun typecheck`
Run: `bun test --preload ./happydom.ts ./src/harness.test.ts`

- [ ] **Step 6: Commit**

### Task 3: Create M10 worktree and add performance scaffolds

**Files:**
- Add: `docs/superpowers/plans/<timestamp>-m10-performance.md` (plan if split)
- Modify: `docs/harness-platform-prd-v2/02-execution-worktrees-and-prompts.md` (if clarifying capacity model wording)
- Add: `packages/opencode/test/performance/harness-capacity.test.ts`
- Add: `packages/app/src/pages/harness-performance.test.ts` (UI budget smoke)

- [ ] **Step 1: Create isolated worktree branch `feat/v2-m10-performance` and copy implementation baseline from `feat/v2-m9-governance-ui`**

- [ ] **Step 2: Add capacity-model tests for high-volume fixtures and timing assertion**

- [ ] **Step 3: Add governance panel rendering budget test (first-screen counts)**

- [ ] **Step 4: Run tests in both opencode and app**

- [ ] **Step 5: Commit**

### Task 4: Create M11 worktree and add SDK/evaluation contract coverage

**Files:**
- Add: `packages/sdk/js/src/v2/sdk-governance-contract.test.ts`
- Add: `packages/opencode/test/evaluation/sdk-contract.test.ts`
- Modify: `packages/sdk/openapi.json`, regenerate generated SDK files

- [ ] **Step 1: Create `feat/v2-m11-team-sdk-eval` worktree from `feat/v2-m10-performance`**

- [ ] **Step 2: Regenerate SDK with `./packages/sdk/js/script/build.ts` after openapi updates**

- [ ] **Step 3: Add compatibility tests for route operations introduced in M9**

- [ ] **Step 4: Add smoke test that acceptance and handoff records are reachable via exported SDK types**

- [ ] **Step 5: Verify with targeted tests and typecheck**

- [ ] **Step 6: Commit**

