# v2 M8 Memory Mechanism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Implement scoped Memory records derived from refs, gated promotion, and context use.

**Architecture:** Add governance-scoped Memory records, generate candidates from Resource/Trace/Sync/user/Workflow sources, require approved or waived acceptance before promotion, and let Context Compiler expand `memory://` refs as summaries while respecting current Projection precedence.

**Tech Stack:** TypeScript, Bun test, Zod, harness store/runtime, M3 Context Compiler, M6 Acceptance.

---

### Task 1: Failing Tests

**Files:**
- Create: `packages/opencode/test/harness/memory-mechanism.test.ts`

- [x] **Step 1: Write tests for candidate generation, promotion gating, scope precedence, and context use**
- [x] **Step 2: Run `bun test test/harness/memory-mechanism.test.ts` and verify RED**

### Task 2: Schema And Store

**Files:**
- Modify: `packages/opencode/src/harness/schema.ts`
- Modify: `packages/opencode/src/harness/store.ts`

- [x] **Step 1: Add `MemoryRecord`, `MemoryWrite`, and `MemoryContextInput`**
- [x] **Step 2: Add memory record store methods**

### Task 3: Runtime And Context Compiler

**Files:**
- Modify: `packages/opencode/src/harness/runtime.ts`

- [x] **Step 1: Implement `createMemoryCandidate()` and `promoteMemory()`**
- [x] **Step 2: Implement `memoryContext()` and memory ref expansion in `compileContext()`**

### Task 4: Docs, Verification, Commit

**Files:**
- Create: `docs/harness-platform-prd-v2/11-v2-memory-mechanism.md`
- Modify: `docs/harness-platform-prd-v2/README.md`
- Modify: `docs/superpowers/plans/2026-06-05-v2-m8-memory-mechanism.md`

- [x] **Step 1: Add docs and README row**
- [x] **Step 2: Mark plan complete**
- [x] **Step 3: Run focused regression and `bun typecheck`**
- [x] **Step 4: Commit `feat: add v2 memory mechanism`**
