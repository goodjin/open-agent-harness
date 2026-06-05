# v2 M0 Core Object Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define the shared v2 object model contracts that downstream Harness v2 milestones can consume.

**Architecture:** Add schema-only contracts to the existing `Harness` Zod namespace in `packages/opencode/src/harness/schema.ts`. Keep M0 free of store/runtime behavior: this milestone validates object categories, common metadata, refs, core object envelopes, and v1-to-v2 mapping records.

**Tech Stack:** TypeScript, Zod, Bun test, existing `packages/opencode` package scripts.

---

## File Structure

- Modify: `packages/opencode/src/harness/schema.ts`
  - Add v2 enums and schemas inside `export namespace Harness`.
  - Export inferred TypeScript types for each schema.
  - Keep identifiers short where clear and use snake_case fields for object data.
- Create: `packages/opencode/test/harness/object-model.test.ts`
  - Validate M0 acceptance criteria with focused schema tests.
  - Use real Zod parsing and no mocks.
- Create: `docs/harness-platform-prd-v2/03-v2-core-object-model.md`
  - Document object categories, ref coverage, relationships, and v1 mapping.

### Task 1: Add Failing Object Category And Metadata Tests

**Files:**
- Create: `packages/opencode/test/harness/object-model.test.ts`
- Modify later: `packages/opencode/src/harness/schema.ts`

- [ ] **Step 1: Write failing tests for core categories and object metadata**

```ts
import { describe, expect, test } from "bun:test"
import { Harness } from "../../src/harness/schema"

const producer = {
  type: "runtime",
  id: "runtime.core",
}

describe("harness v2 object model", () => {
  test("accepts the six core object categories", () => {
    expect(Harness.ObjectCategory.options).toEqual(["fact", "view", "evidence", "resource", "context", "policy"])
  })

  test("requires stable metadata on v2 objects", () => {
    const obj = Harness.Object.parse({
      id: "fact_run_goal_01",
      schema_version: "v2.0",
      category: "fact",
      kind: "run_goal",
      producer,
      visibility: "project",
      lifecycle: "active",
      created_at: 1,
      updated_at: 2,
      refs: ["resource://res_01"],
      summary: "User goal accepted by runtime.",
      data: { goal: "ship resource first harness" },
    })

    expect(obj.schema_version).toBe("v2.0")
    expect(obj.producer.type).toBe("runtime")
    expect(obj.visibility).toBe("project")
    expect(obj.lifecycle).toBe("active")
    expect(obj.refs).toEqual(["resource://res_01"])
  })

  test("rejects v2 objects with unknown metadata fields", () => {
    expect(() =>
      Harness.Object.parse({
        id: "fact_run_goal_01",
        schema_version: "v2.0",
        category: "fact",
        kind: "run_goal",
        producer,
        visibility: "project",
        lifecycle: "active",
        created_at: 1,
        updated_at: 2,
        extra: true,
      }),
    ).toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/harness/object-model.test.ts`

Expected: FAIL because `Harness.ObjectCategory` and `Harness.Object` are not defined.

### Task 2: Implement Core Metadata Schemas

**Files:**
- Modify: `packages/opencode/src/harness/schema.ts`
- Test: `packages/opencode/test/harness/object-model.test.ts`

- [ ] **Step 1: Add minimal v2 metadata schemas**

Add these exports inside `export namespace Harness` after existing status enums:

```ts
  export const SchemaVersion = z.literal("v2.0").meta({ ref: "HarnessV2SchemaVersion" })
  export type SchemaVersion = z.infer<typeof SchemaVersion>

  export const ObjectCategory = z.enum(["fact", "view", "evidence", "resource", "context", "policy"]).meta({ ref: "HarnessV2ObjectCategory" })
  export type ObjectCategory = z.infer<typeof ObjectCategory>

  export const Visibility = z.enum(["private", "project", "team", "public"]).meta({ ref: "HarnessV2Visibility" })
  export type Visibility = z.infer<typeof Visibility>

  export const Lifecycle = z.enum(["draft", "active", "archived", "tombstoned"]).meta({ ref: "HarnessV2Lifecycle" })
  export type Lifecycle = z.infer<typeof Lifecycle>

  export const Producer = z
    .object({
      type: z.enum(["runtime", "model", "tool", "agent", "user", "system", "import"]),
      id: z.string(),
      run_id: z.string().optional(),
      action_id: z.string().optional(),
      session_id: z.string().optional(),
    })
    .strict()
    .meta({ ref: "HarnessV2Producer" })
  export type Producer = z.infer<typeof Producer>

  export const Object = z
    .object({
      id: z.string(),
      schema_version: SchemaVersion.default("v2.0"),
      category: ObjectCategory,
      kind: z.string(),
      producer: Producer,
      visibility: Visibility,
      lifecycle: Lifecycle.default("active"),
      created_at: z.number(),
      updated_at: z.number(),
      refs: z.array(z.string()).default([]),
      summary: z.string().optional(),
      data: z.record(z.string(), z.unknown()).default({}),
    })
    .strict()
    .meta({ ref: "HarnessV2Object" })
  export type Object = z.infer<typeof Object>
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test test/harness/object-model.test.ts`

Expected: PASS for the three metadata tests.

### Task 3: Add Failing Reference Protocol Tests

**Files:**
- Modify: `packages/opencode/test/harness/object-model.test.ts`
- Modify later: `packages/opencode/src/harness/schema.ts`

- [ ] **Step 1: Add tests for v2 ref coverage and validation**

Append inside the existing `describe` block:

```ts
  test("accepts every M0 reference protocol target", () => {
    const refs = [
      "resource://res_01",
      "document://doc_01",
      "artifact://art_01",
      "action://act_01",
      "handoff://handoff_01",
      "trace://trace_01",
      "projection://run/run_01/current",
      "memory://mem_01",
      "snapshot://snap_01",
    ]

    expect(refs.map((ref) => Harness.Ref.parse(ref))).toEqual(refs)
  })

  test("rejects unsupported refs", () => {
    expect(() => Harness.Ref.parse("session://msg_01")).toThrow()
    expect(() => Harness.Ref.parse("resource://")).toThrow()
    expect(() => Harness.Ref.parse("resource:res_01")).toThrow()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/harness/object-model.test.ts`

Expected: FAIL because `Harness.Ref` is not defined.

### Task 4: Implement Reference Protocol Schema

**Files:**
- Modify: `packages/opencode/src/harness/schema.ts`
- Test: `packages/opencode/test/harness/object-model.test.ts`

- [ ] **Step 1: Add ref schemas**

Add these exports after `Producer`:

```ts
  export const RefKind = z
    .enum(["resource", "document", "artifact", "action", "handoff", "trace", "projection", "memory", "snapshot"])
    .meta({ ref: "HarnessV2RefKind" })
  export type RefKind = z.infer<typeof RefKind>

  export const Ref = z
    .string()
    .regex(/^(resource|document|artifact|action|handoff|trace|projection|memory|snapshot):\/\/[A-Za-z0-9._~:/-]+$/)
    .meta({ ref: "HarnessV2Ref" })
  export type Ref = z.infer<typeof Ref>
```

Update `Object.refs` to use `z.array(Ref).default([])`.

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test test/harness/object-model.test.ts`

Expected: PASS for metadata and reference tests.

### Task 5: Add Failing Core Object And v1 Mapping Tests

**Files:**
- Modify: `packages/opencode/test/harness/object-model.test.ts`
- Modify later: `packages/opencode/src/harness/schema.ts`

- [ ] **Step 1: Add tests for specialized object contracts and v1 mappings**

Append inside the existing `describe` block:

```ts
  test("validates resource context memory workflow and policy objects", () => {
    const base = {
      schema_version: "v2.0",
      producer,
      visibility: "project",
      lifecycle: "active",
      created_at: 1,
      updated_at: 1,
    }

    const res = Harness.ResourceObject.parse({
      ...base,
      id: "res_01",
      category: "resource",
      kind: "document",
      uri: "file://docs/report.md",
      media_type: "text/markdown",
      summary: "Report resource",
      evidence: ["trace://trace_01"],
    })
    const ctx = Harness.ContextObject.parse({
      ...base,
      id: "ctx_01",
      category: "context",
      kind: "bundle",
      target: "agent.worker",
      included: ["resource://res_01"],
      excluded: [{ ref: "memory://mem_01", reason: "outside visibility" }],
      budget: { tokens: 4000 },
    })
    const mem = Harness.MemoryObject.parse({
      ...base,
      id: "mem_01",
      category: "fact",
      kind: "project_memory",
      scope: "project",
      namespace: "harness",
      status: "current",
      evidence: ["resource://res_01"],
    })
    const flow = Harness.WorkflowObject.parse({
      ...base,
      id: "flow_01",
      category: "policy",
      kind: "workflow_profile",
      version: 1,
      nodes: ["action://act_01"],
      criteria: ["tests pass"],
    })
    const pol = Harness.PolicyObject.parse({
      ...base,
      id: "policy_01",
      category: "policy",
      kind: "acceptance_policy",
      rules: [{ when: "risk:high", then: "human" }],
    })

    expect(res.evidence).toEqual(["trace://trace_01"])
    expect(ctx.excluded[0]?.reason).toBe("outside visibility")
    expect(mem.scope).toBe("project")
    expect(flow.nodes).toEqual(["action://act_01"])
    expect(pol.rules[0]?.then).toBe("human")
  })

  test("maps v1 semantics to v2 object contracts", () => {
    const map = Harness.V1Mapping.parse({
      artifact: ["resource", "evidence"],
      context: ["context", "view"],
      memory: ["fact"],
      workflow: ["policy", "view"],
    })

    expect(map.artifact).toEqual(["resource", "evidence"])
    expect(map.context).toEqual(["context", "view"])
    expect(map.memory).toEqual(["fact"])
    expect(map.workflow).toEqual(["policy", "view"])
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/harness/object-model.test.ts`

Expected: FAIL because specialized object schemas and `V1Mapping` are not defined.

### Task 6: Implement Specialized M0 Object Schemas

**Files:**
- Modify: `packages/opencode/src/harness/schema.ts`
- Test: `packages/opencode/test/harness/object-model.test.ts`

- [ ] **Step 1: Add specialized object schemas**

Add these exports after `Object`:

```ts
  export const ResourceObject = Object.extend({
    category: z.literal("resource"),
    uri: z.string(),
    media_type: z.string().optional(),
    evidence: z.array(Ref).default([]),
  })
    .strict()
    .meta({ ref: "HarnessV2ResourceObject" })
  export type ResourceObject = z.infer<typeof ResourceObject>

  export const ContextObject = Object.extend({
    category: z.literal("context"),
    target: z.string(),
    included: z.array(Ref).default([]),
    excluded: z
      .array(
        z
          .object({
            ref: Ref,
            reason: z.string(),
          })
          .strict(),
      )
      .default([]),
    budget: z
      .object({
        tokens: z.number().int().nonnegative(),
      })
      .strict(),
  })
    .strict()
    .meta({ ref: "HarnessV2ContextObject" })
  export type ContextObject = z.infer<typeof ContextObject>

  export const MemoryObject = Object.extend({
    category: z.literal("fact"),
    scope: z.enum(["run", "project", "team", "global"]),
    namespace: z.string(),
    status: z.enum(["candidate", "current", "historical", "superseded", "rejected"]).default("candidate"),
    evidence: z.array(Ref).default([]),
  })
    .strict()
    .meta({ ref: "HarnessV2MemoryObject" })
  export type MemoryObject = z.infer<typeof MemoryObject>

  export const WorkflowObject = Object.extend({
    category: z.literal("policy"),
    version: z.number().int().min(1),
    nodes: z.array(Ref).default([]),
    criteria: z.array(z.string()).default([]),
  })
    .strict()
    .meta({ ref: "HarnessV2WorkflowObject" })
  export type WorkflowObject = z.infer<typeof WorkflowObject>

  export const PolicyObject = Object.extend({
    category: z.literal("policy"),
    rules: z.array(z.record(z.string(), z.string())).default([]),
  })
    .strict()
    .meta({ ref: "HarnessV2PolicyObject" })
  export type PolicyObject = z.infer<typeof PolicyObject>

  export const V1Mapping = z
    .object({
      artifact: z.array(ObjectCategory),
      context: z.array(ObjectCategory),
      memory: z.array(ObjectCategory),
      workflow: z.array(ObjectCategory),
    })
    .strict()
    .meta({ ref: "HarnessV2V1Mapping" })
  export type V1Mapping = z.infer<typeof V1Mapping>
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test test/harness/object-model.test.ts`

Expected: PASS for all M0 object model tests.

### Task 7: Document Object Relationships

**Files:**
- Create: `docs/harness-platform-prd-v2/03-v2-core-object-model.md`
- Modify: `docs/harness-platform-prd-v2/README.md`

- [ ] **Step 1: Add the relationship doc**

Create `docs/harness-platform-prd-v2/03-v2-core-object-model.md` with:

```md
# v2 Core Object Model

M0 defines shared contracts only. It does not add scheduling, storage, context compilation, resource writing, acceptance routing, or UI behavior.

## Object Categories

| Category | Role | Typical Objects |
|---|---|---|
| fact | Accepted runtime state or durable knowledge. | run goal, action state, memory record |
| view | Rebuildable projection over facts and evidence. | run projection, graph view, context preview |
| evidence | Proof or observation behind a state change. | trace entry, test report ref, review result |
| resource | Addressable content outside transcript. | document, artifact, log, snapshot body |
| context | Runtime-compiled model input contract. | context bundle, included/excluded refs |
| policy | Rules that shape runtime decisions. | workflow profile, visibility rule, acceptance policy |

## Shared Metadata

Every v2 object has `id`, `schema_version`, `category`, `kind`, `producer`, `visibility`, `lifecycle`, `created_at`, `updated_at`, `refs`, and optional `summary` / `data`.

`producer` records the actor that created the object. `visibility` controls whether refs can be expanded. `lifecycle` lets later milestones archive or tombstone objects without deleting their audit trail.

## Reference Protocol

M0 accepts these ref schemes:

```txt
resource://<id>
document://<id>
artifact://<id>
action://<id>
handoff://<id>
trace://<id>
projection://run/<run_id>/current
memory://<id>
snapshot://<id>
```

M0 only validates ref shape. Resolution, authorization, redaction, summary lookup, and expansion belong to later milestones.

## v1 Mapping

| v1 Semantic | v2 Mapping | Notes |
|---|---|---|
| Artifact | resource + evidence | Artifacts become addressable resources and can also serve as evidence for task completion. |
| Context Bundle | context + view | Context is compiled by Runtime and may expose a view explaining included and excluded refs. |
| Memory | fact | Memory is accepted knowledge with scope, namespace, status, refs, and evidence. |
| Workflow | policy + view | Workflow profiles are policies; workflow runs and graph projections are views over facts and evidence. |

This mapping preserves the v1 surface while moving large bodies and long-lived state out of session messages.
```

- [ ] **Step 2: Link the relationship doc from README**

Add a row to the document map:

```md
| 03 | [v2 核心对象模型](03-v2-core-object-model.md) | 定义 M0 的对象分类、共享元数据、引用协议和 v1 语义映射。 |
```

### Task 8: Final Verification

**Files:**
- Verify all touched files.

- [ ] **Step 1: Run focused tests**

Run: `bun test test/harness/object-model.test.ts test/harness/runtime.test.ts`

Expected: all tests pass.

- [ ] **Step 2: Run package typecheck**

Run: `bun typecheck`

Expected: exit 0.

- [ ] **Step 3: Inspect git diff**

Run: `git diff -- packages/opencode/src/harness/schema.ts packages/opencode/test/harness/object-model.test.ts docs/harness-platform-prd-v2/README.md docs/harness-platform-prd-v2/03-v2-core-object-model.md`

Expected: changes are limited to M0 schemas, tests, and docs.

## Self-Review

- AC-M0-001 covered by `ObjectCategory` and object category tests.
- AC-M0-002 covered by `Object`, `Producer`, `Visibility`, `Lifecycle`, and strict metadata tests.
- AC-M0-003 covered by `RefKind`, `Ref`, and all required ref scheme tests.
- AC-M0-004 covered by `V1Mapping` and relationship documentation.
- Placeholder scan: no TBD/TODO/fill-later steps.
- Type consistency: all test names and schema names match the implementation tasks.
