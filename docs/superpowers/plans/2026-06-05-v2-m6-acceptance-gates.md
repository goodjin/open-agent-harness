# v2 M6 Acceptance Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add Acceptance Criteria, Acceptance Policy, and Acceptance Gate records that prevent required work from closing without evidence.

**Architecture:** Store acceptance records per run, bind them to v2 refs, generate policy levels from criteria/risk/resource/agent hints, and write gate outcomes to Event plus Projection. Runtime completion checks stay narrow: Action records with criteria cannot move to `completed` unless matching required gates are approved or waived.

**Tech Stack:** TypeScript, Bun test, Zod schemas, existing harness store/runtime.

---

### Task 1: Failing Acceptance Tests

**Files:**
- Create: `packages/opencode/test/harness/acceptance-gates.test.ts`

- [x] **Step 1: Write tests**

Cover policy generation, gate result persistence/projection, repair assignment, and completion prevention.

- [x] **Step 2: Verify RED**

Run from `packages/opencode`:

```bash
bun test test/harness/acceptance-gates.test.ts
```

Expected: fail because acceptance APIs and store methods do not exist.

### Task 2: Schema And Store

**Files:**
- Modify: `packages/opencode/src/harness/schema.ts`
- Modify: `packages/opencode/src/harness/store.ts`

- [x] **Step 1: Add schemas**

Add `AcceptanceLevel`, `AcceptanceGateResult`, `AcceptanceTarget`, `AcceptancePolicy`, `AcceptanceRecord`, `AcceptanceBind`, `AcceptancePolicyInput`, and `AcceptanceResultInput`.

- [x] **Step 2: Add store methods**

Add run-scoped `acceptance/` store with `acceptance(run)`, `acceptanceRecord(run, id)`, and `putAcceptance(record)`. Include records in `Summary`.

### Task 3: Runtime

**Files:**
- Modify: `packages/opencode/src/harness/runtime.ts`

- [x] **Step 1: Implement `acceptancePolicy()`**

Generate `none`, `auto`, `test`, `agent`, `human`, `combined`, and `sampled` levels from criteria, risk, side effects, resource scope, artifact type, agent kind, permission, and sample rate.

- [x] **Step 2: Implement `bindAcceptance()` and `recordAcceptance()`**

Persist records, append `acceptance.bound` / `acceptance.<result>`, update `acceptance-state` projection, and create a repair assignment when result is `changes_requested`.

- [x] **Step 3: Prevent unsafe completion**

When `action.accept` tries to write a `completed` Action with criteria, require an approved or waived acceptance record for `action://<id>`.

### Task 4: Docs, Verification, Commit

**Files:**
- Create: `docs/harness-platform-prd-v2/09-v2-acceptance-gates.md`
- Modify: `docs/harness-platform-prd-v2/README.md`
- Modify: `docs/superpowers/plans/2026-06-05-v2-m6-acceptance-gates.md`

- [x] **Step 1: Add docs and README row**
- [x] **Step 2: Mark this plan complete**
- [x] **Step 3: Run verification**

Run from `packages/opencode`:

```bash
bun test test/harness/acceptance-gates.test.ts test/harness/handoff-protocol.test.ts test/harness/context-compiler.test.ts test/harness/agent-assignment.test.ts test/harness/resource-fabric.test.ts test/harness/action-graph.test.ts test/harness/runtime.test.ts test/harness/object-model.test.ts
bun typecheck
```

- [x] **Step 4: Commit**

```bash
git add packages/opencode/src/harness/schema.ts packages/opencode/src/harness/store.ts packages/opencode/src/harness/runtime.ts packages/opencode/test/harness/acceptance-gates.test.ts docs/harness-platform-prd-v2/README.md docs/harness-platform-prd-v2/09-v2-acceptance-gates.md docs/superpowers/plans/2026-06-05-v2-m6-acceptance-gates.md
git commit -m "feat: add v2 acceptance gates"
```
