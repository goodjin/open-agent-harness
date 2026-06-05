# v2 M7 Workflow Asset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make Workflow a saved, versioned, recoverable Action Graph Profile.

**Architecture:** Store workflow profiles as governance assets, save profiles from existing runs, expand a profile into normal Action Graph actions, and route failed node recovery through retry, skip, repair assignment, or user decision.

**Tech Stack:** TypeScript, Bun test, Zod, harness store/runtime, M1 Action Graph, M6 Acceptance.

---

### Task 1: Failing Tests

**Files:**
- Create: `packages/opencode/test/harness/workflow-asset.test.ts`

- [x] **Step 1: Write tests for save-from-run, run-from-profile, recovery, and acceptance inheritance**
- [x] **Step 2: Run `bun test test/harness/workflow-asset.test.ts` and verify RED**

### Task 2: Schema And Store

**Files:**
- Modify: `packages/opencode/src/harness/schema.ts`
- Modify: `packages/opencode/src/harness/store.ts`

- [x] **Step 1: Add `WorkflowNodeProfile`, `WorkflowProfile`, `WorkflowAsset`, `WorkflowRunInput`, and `WorkflowRecoveryInput`**
- [x] **Step 2: Add governance workflow asset store methods and Summary wiring**

### Task 3: Runtime

**Files:**
- Modify: `packages/opencode/src/harness/runtime.ts`

- [x] **Step 1: Implement `saveWorkflowFromRun()`**
- [x] **Step 2: Implement `putWorkflow()`, `workflows()`, and `runWorkflow()`**
- [x] **Step 3: Implement `recoverWorkflowNode()` for inspect, retry, skip, repair, and decision**

### Task 4: Docs And Verification

**Files:**
- Create: `docs/harness-platform-prd-v2/10-v2-workflow-asset.md`
- Modify: `docs/harness-platform-prd-v2/README.md`
- Modify: `docs/superpowers/plans/2026-06-05-v2-m7-workflow-asset.md`

- [x] **Step 1: Add docs and README row**
- [x] **Step 2: Mark plan complete**
- [x] **Step 3: Run focused regression and `bun typecheck`**
- [x] **Step 4: Commit `feat: add v2 workflow asset`**
