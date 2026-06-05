# v2 M1 Persistent Action Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Persist accepted v2 `kind: "act"` records so a run's Action Graph can be queried and rebuilt after runtime restart.

**Architecture:** Extend the existing `Harness` Zod namespace with M1 graph contracts, then add file-backed graph storage beside the current run store under `.opencode/harness/runs/<run>/`. `HarnessRuntime.command()` accepts an `action.accept` command whose payload has `kind: "act"`, writes action records and dependency edges, appends events, and rebuilds an `action-graph` projection from stored facts. M1 does not implement resource bodies, context compilation, workflow assets, or acceptance policy; it only stores refs and fields that downstream milestones will consume.

**Tech Stack:** TypeScript, Zod, Bun file APIs, existing `HarnessStore`, existing `HarnessRuntime`, Bun test from `packages/opencode`.

---

## File Structure

- Modify: `packages/opencode/src/harness/schema.ts`
  - Add `ActionStatus`, `RetryPolicy`, `ActionRecord`, `ActionEdge`, `ActionGraph`, `ActionAccept`, and `ActionGraphProjection`.
  - Add `action.accept`, `action.cancel`, and `action.retry` to `Harness.Command`.
  - Extend `Harness.Summary` with `actions`, `edges`, and optional `graph`.
- Modify: `packages/opencode/src/harness/store.ts`
  - Persist graph metadata at `runs/<run>/action-graph/graph.json`.
  - Persist action nodes at `runs/<run>/action-graph/actions/<action>.json`.
  - Persist dependency edges at `runs/<run>/action-graph/edges.json`.
  - Expose query methods for graph, actions, edges, and action lookup.
- Modify: `packages/opencode/src/harness/runtime.ts`
  - Add command handlers for `action.accept`, `action.cancel`, and `action.retry`.
  - Add `actionGraph(run)` and `rebuildActionGraph(run)` query helpers.
  - Keep existing `graph(run)` task projection intact.
- Create: `packages/opencode/test/harness/action-graph.test.ts`
  - Cover persistence, dependency recovery, projection rebuild, idempotency, cancellation, retry, locks, budget, visibility, and expected artifacts.
- Create: `docs/harness-platform-prd-v2/04-v2-persistent-action-graph.md`
  - Document the M1 storage layout, accepted fields, event types, projection shape, and recovery boundary.
- Modify: `docs/harness-platform-prd-v2/README.md`
  - Link the new M1 doc.

### Task 1: Add Failing Action Graph Persistence Tests

**Files:**
- Create: `packages/opencode/test/harness/action-graph.test.ts`
- Modify later: `packages/opencode/src/harness/schema.ts`
- Modify later: `packages/opencode/src/harness/store.ts`
- Modify later: `packages/opencode/src/harness/runtime.ts`

- [x] **Step 1: Write failing tests for accepted act persistence**

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
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-harness-action-graph-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("harness persistent action graph", () => {
  test("persists accepted act records with queryable M1 fields", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "build action graph" })

        const next = await HarnessRuntime.command({
          type: "action.accept",
          run_id: run.id,
          actor: "runtime",
          payload: {
            id: "act_plan",
            kind: "act",
            title: "Plan implementation",
            type: "agent",
            status: "ready",
            criteria: ["plan saved"],
            failure: "request human clarification",
            gate: "auto",
            budget: { tokens: 2000, timeout_ms: 30000 },
            visibility: "project",
            expected_artifacts: ["document://plan_01"],
            idempotency_key: "plan-implementation",
            resource_locks: ["resource://repo"],
            cancellation: { allowed: true, reason: "user stop" },
            retry_policy: { max: 2, backoff: "linear" },
          },
        })

        const graph = await HarnessStore.actionGraph(run.id)
        const list = await HarnessStore.actions(run.id)
        const projection = await HarnessRuntime.actionGraph(run.id)
        const events = await HarnessStore.events(run.id)

        expect(next.id).toBe(run.id)
        expect(graph?.run_id).toBe(run.id)
        expect(list).toHaveLength(1)
        expect(list[0]?.id).toBe("act_plan")
        expect(list[0]?.criteria).toEqual(["plan saved"])
        expect(list[0]?.gate).toBe("auto")
        expect(list[0]?.budget.tokens).toBe(2000)
        expect(list[0]?.visibility).toBe("project")
        expect(list[0]?.expected_artifacts).toEqual(["document://plan_01"])
        expect(list[0]?.idempotency_key).toBe("plan-implementation")
        expect(list[0]?.resource_locks).toEqual(["resource://repo"])
        expect(list[0]?.cancellation.allowed).toBe(true)
        expect(list[0]?.retry_policy.max).toBe(2)
        expect(projection.nodes.map((item) => item.id)).toContain("act_plan")
        expect(events.map((item) => item.type)).toContain("action.accepted")
      },
    })
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test test/harness/action-graph.test.ts`

Expected: FAIL because `action.accept`, `HarnessStore.actionGraph`, `HarnessStore.actions`, and `HarnessRuntime.actionGraph` are not implemented.

### Task 2: Implement Action Graph Schemas

**Files:**
- Modify: `packages/opencode/src/harness/schema.ts`
- Test: `packages/opencode/test/harness/action-graph.test.ts`

- [x] **Step 1: Add minimal M1 schemas**

Add these exports after `Gate`:

```ts
  export const ActionStatus = z
    .enum(["ready", "blocked", "running", "completed", "failed", "cancelled"])
    .meta({ ref: "HarnessActionStatus" })
  export type ActionStatus = z.infer<typeof ActionStatus>

  export const RetryPolicy = z
    .object({
      max: z.number().int().min(0).default(0),
      backoff: z.enum(["none", "linear", "exponential"]).default("none"),
    })
    .strict()
    .meta({ ref: "HarnessRetryPolicy" })
  export type RetryPolicy = z.infer<typeof RetryPolicy>

  export const ActionRecord = z
    .object({
      id: z.string(),
      run_id: z.string(),
      graph_id: z.string(),
      kind: z.literal("act"),
      type: z.string().default("task"),
      title: z.string(),
      status: ActionStatus.default("ready"),
      depends_on: z.array(z.string()).default([]),
      criteria: z.array(z.string()).default([]),
      failure: z.string().optional(),
      gate: z.string().optional(),
      budget: z.record(z.string(), z.unknown()).default({}),
      visibility: Visibility.default("project"),
      expected_artifacts: z.array(Ref).default([]),
      idempotency_key: z.string().optional(),
      resource_locks: z.array(Ref).default([]),
      cancellation: z
        .object({
          allowed: z.boolean().default(true),
          reason: z.string().optional(),
        })
        .strict()
        .default({ allowed: true }),
      retry_policy: RetryPolicy.default({ max: 0, backoff: "none" }),
      created_at: z.number(),
      updated_at: z.number(),
    })
    .strict()
    .meta({ ref: "HarnessActionRecord" })
  export type ActionRecord = z.infer<typeof ActionRecord>

  export const ActionEdge = z
    .object({
      run_id: z.string(),
      graph_id: z.string(),
      from: z.string(),
      to: z.string(),
      kind: z.enum(["depends_on"]).default("depends_on"),
    })
    .strict()
    .meta({ ref: "HarnessActionEdge" })
  export type ActionEdge = z.infer<typeof ActionEdge>

  export const ActionGraph = z
    .object({
      id: z.string(),
      run_id: z.string(),
      schema_version: SchemaVersion.default("v2.0"),
      status: z.enum(["active", "completed", "blocked", "failed", "cancelled"]).default("active"),
      created_at: z.number(),
      updated_at: z.number(),
    })
    .strict()
    .meta({ ref: "HarnessActionGraph" })
  export type ActionGraph = z.infer<typeof ActionGraph>

  export const ActionAccept = z
    .object({
      id: z.string().optional(),
      kind: z.literal("act"),
      type: z.string().default("task"),
      title: z.string(),
      status: ActionStatus.default("ready"),
      depends_on: z.array(z.string()).default([]),
      criteria: z.array(z.string()).default([]),
      failure: z.string().optional(),
      gate: z.string().optional(),
      budget: z.record(z.string(), z.unknown()).default({}),
      visibility: Visibility.default("project"),
      expected_artifacts: z.array(Ref).default([]),
      idempotency_key: z.string().optional(),
      resource_locks: z.array(Ref).default([]),
      cancellation: z
        .object({
          allowed: z.boolean().default(true),
          reason: z.string().optional(),
        })
        .strict()
        .default({ allowed: true }),
      retry_policy: RetryPolicy.default({ max: 0, backoff: "none" }),
    })
    .strict()
    .meta({ ref: "HarnessActionAccept" })
  export type ActionAccept = z.infer<typeof ActionAccept>

  export const ActionGraphProjection = z
    .object({
      graph: ActionGraph,
      nodes: z.array(ActionRecord),
      edges: z.array(ActionEdge),
      blocked: z.array(
        z
          .object({
            id: z.string(),
            reason: z.string(),
          })
          .strict(),
      ),
      ready: z.array(z.string()),
      source_events: z.number().int().min(0),
    })
    .strict()
    .meta({ ref: "HarnessActionGraphProjection" })
  export type ActionGraphProjection = z.infer<typeof ActionGraphProjection>
```

Update `Command.type` enum to include:

```ts
        "action.accept",
        "action.cancel",
        "action.retry",
```

Update `Summary`:

```ts
      graph: ActionGraph.optional(),
      actions: z.array(ActionRecord).default([]),
      edges: z.array(ActionEdge).default([]),
```

- [x] **Step 2: Run test to verify schema-only progress**

Run: `bun test test/harness/action-graph.test.ts`

Expected: still FAIL because store/runtime methods are not implemented yet.

### Task 3: Implement File-Backed Action Graph Store

**Files:**
- Modify: `packages/opencode/src/harness/store.ts`
- Test: `packages/opencode/test/harness/action-graph.test.ts`

- [x] **Step 1: Add graph paths and store methods**

Add helpers near existing run path helpers:

```ts
  function graphDir(id: string) {
    return path.join(runDir(id), "action-graph")
  }

  function actionsDir(id: string) {
    return path.join(graphDir(id), "actions")
  }
```

Add exports before `summary`:

```ts
  export async function actionGraph(id: string) {
    const file = path.join(graphDir(id), "graph.json")
    if (!(await exists(file))) return
    return Harness.ActionGraph.parse(await Bun.file(file).json())
  }

  export async function putActionGraph(item: Harness.ActionGraph) {
    await write(path.join(graphDir(item.run_id), "graph.json"), item)
  }

  export async function actions(id: string) {
    return list(actionsDir(id), Harness.ActionRecord)
  }

  export async function action(run: string, id: string) {
    const file = path.join(actionsDir(run), `${id}.json`)
    if (!(await exists(file))) return
    return Harness.ActionRecord.parse(await Bun.file(file).json())
  }

  export async function putAction(item: Harness.ActionRecord) {
    await write(path.join(actionsDir(item.run_id), `${item.id}.json`), item)
  }

  export async function edges(id: string) {
    return read(path.join(graphDir(id), "edges.json"), z.array(Harness.ActionEdge), [])
  }

  export async function putEdges(run: string, list: Harness.ActionEdge[]) {
    await write(path.join(graphDir(run), "edges.json"), z.array(Harness.ActionEdge).parse(list))
  }
```

Add `z` import at the top:

```ts
import z from "zod"
```

Update `summary` return:

```ts
      graph: await actionGraph(id),
      actions: await actions(id),
      edges: await edges(id),
```

- [x] **Step 2: Run test to verify store-only progress**

Run: `bun test test/harness/action-graph.test.ts`

Expected: still FAIL because runtime command and projection helpers are not implemented yet.

### Task 4: Implement Runtime Accept, Query, And Projection Rebuild

**Files:**
- Modify: `packages/opencode/src/harness/runtime.ts`
- Test: `packages/opencode/test/harness/action-graph.test.ts`

- [x] **Step 1: Add runtime helpers**

Add after `event()`:

```ts
  async function graph(run: Harness.Run) {
    const time = now()
    const item =
      (await HarnessStore.actionGraph(run.id)) ??
      Harness.ActionGraph.parse({
        id: id("graph"),
        run_id: run.id,
        status: "active",
        created_at: time,
        updated_at: time,
      })
    const next = Harness.ActionGraph.parse({ ...item, updated_at: time })
    await HarnessStore.putActionGraph(next)
    return next
  }

  async function project(run: string) {
    const graph = await HarnessStore.actionGraph(run)
    if (!graph) throw new Error(`Action Graph not found: ${run}`)
    const actions = await HarnessStore.actions(run)
    const edges = await HarnessStore.edges(run)
    const events = await HarnessStore.events(run)
    const done = new Set(actions.filter((item) => item.status === "completed").map((item) => item.id))
    const blocked = actions
      .filter((item) => item.status === "blocked" || item.depends_on.some((dep) => !done.has(dep)))
      .map((item) => ({
        id: item.id,
        reason: item.status === "blocked" ? "status blocked" : "waiting for dependencies",
      }))
    const out = Harness.ActionGraphProjection.parse({
      graph,
      nodes: actions,
      edges,
      blocked,
      ready: actions.filter((item) => item.status === "ready" && !blocked.some((next) => next.id === item.id)).map((item) => item.id),
      source_events: events.length,
    })
    await HarnessStore.projection(run, "action-graph", out)
    return out
  }
```

- [x] **Step 2: Add command handlers**

Add in `command()` after run pause/resume/abort handlers and before task commands:

```ts
    if (input.type === "action.accept") {
      const payload = Harness.ActionAccept.parse(input.payload)
      const item = await graph(run)
      const key = payload.idempotency_key
      const found = key ? (await HarnessStore.actions(run.id)).find((next) => next.idempotency_key === key) : undefined
      const act = Harness.ActionRecord.parse({
        ...payload,
        id: found?.id ?? payload.id ?? id("act"),
        run_id: run.id,
        graph_id: item.id,
        created_at: found?.created_at ?? time,
        updated_at: time,
      })
      await HarnessStore.putAction(act)
      const old = (await HarnessStore.edges(run.id)).filter((next) => next.to !== act.id)
      await HarnessStore.putEdges(run.id, [
        ...old,
        ...act.depends_on.map((dep) =>
          Harness.ActionEdge.parse({
            run_id: run.id,
            graph_id: item.id,
            from: dep,
            to: act.id,
          }),
        ),
      ])
      await HarnessStore.append(event("action.accepted", { run: run.id, actor: input.actor, summary: act.title, payload: { action_id: act.id } }))
      await project(run.id)
      return refresh(run)
    }

    if ((input.type === "action.cancel" || input.type === "action.retry") && input.task_id) {
      const act = await HarnessStore.action(run.id, input.task_id)
      if (!act) throw new Error(`Action not found: ${input.task_id}`)
      const status = input.type === "action.cancel" ? "cancelled" : "ready"
      await HarnessStore.putAction(Harness.ActionRecord.parse({ ...act, status, updated_at: time }))
      await HarnessStore.append(event(input.type.replace(".", "_"), { run: run.id, actor: input.actor, payload: { action_id: act.id } }))
      await project(run.id)
      return refresh(run)
    }
```

- [x] **Step 3: Add query helpers**

Add before existing task `graph(run: string)` export. Rename the existing exported `graph(run: string)` to `taskGraph(run: string)` only if needed to avoid name collision with the new internal helper; then add:

```ts
  export async function actionGraph(run: string) {
    return project(run)
  }

  export async function rebuildActionGraph(run: string) {
    return project(run)
  }
```

If there is a name collision, use `record()` for the internal graph helper instead of renaming the existing public task graph.

- [x] **Step 4: Run test to verify it passes**

Run: `bun test test/harness/action-graph.test.ts`

Expected: PASS for the accepted action persistence test.

### Task 5: Add Failing Dependency Recovery Tests

**Files:**
- Modify: `packages/opencode/test/harness/action-graph.test.ts`
- Modify later: `packages/opencode/src/harness/runtime.ts`

- [x] **Step 1: Add dependency, rebuild, cancellation, and retry tests**

Append inside the existing `describe` block:

```ts
  test("rebuilds projection from persisted actions and dependency edges", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "recover graph" })
        await HarnessRuntime.command({
          type: "action.accept",
          run_id: run.id,
          payload: { id: "act_a", kind: "act", title: "A", status: "completed" },
        })
        await HarnessRuntime.command({
          type: "action.accept",
          run_id: run.id,
          payload: { id: "act_b", kind: "act", title: "B", depends_on: ["act_a"] },
        })
        await HarnessRuntime.command({
          type: "action.accept",
          run_id: run.id,
          payload: { id: "act_c", kind: "act", title: "C", depends_on: ["act_missing"] },
        })

        const projection = await HarnessRuntime.rebuildActionGraph(run.id)

        expect(projection.edges.map((item) => `${item.from}->${item.to}`)).toEqual(["act_a->act_b", "act_missing->act_c"])
        expect(projection.ready).toContain("act_b")
        expect(projection.blocked).toContainEqual({ id: "act_c", reason: "waiting for dependencies" })
        expect(projection.source_events).toBeGreaterThanOrEqual(5)
      },
    })
  })

  test("updates action state for cancellation and retry commands", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "state graph" })
        await HarnessRuntime.command({
          type: "action.accept",
          run_id: run.id,
          payload: { id: "act_state", kind: "act", title: "State", status: "running" },
        })

        await HarnessRuntime.command({ type: "action.cancel", run_id: run.id, task_id: "act_state" })
        expect((await HarnessStore.action(run.id, "act_state"))?.status).toBe("cancelled")

        await HarnessRuntime.command({ type: "action.retry", run_id: run.id, task_id: "act_state" })
        expect((await HarnessStore.action(run.id, "act_state"))?.status).toBe("ready")
      },
    })
  })
```

- [x] **Step 2: Run tests to verify they fail if rebuild/state paths are incomplete**

Run: `bun test test/harness/action-graph.test.ts`

Expected: FAIL if projection sorting, cancellation, or retry behavior is incomplete.

### Task 6: Finish Recovery And State Behavior

**Files:**
- Modify: `packages/opencode/src/harness/store.ts`
- Modify: `packages/opencode/src/harness/runtime.ts`
- Test: `packages/opencode/test/harness/action-graph.test.ts`

- [x] **Step 1: Keep graph output stable**

If the dependency test shows unstable ordering, update `HarnessStore.edges()` to sort by `to` then `from`:

```ts
    return (await read(path.join(graphDir(id), "edges.json"), z.array(Harness.ActionEdge), [])).sort((a, b) => `${a.to}:${a.from}`.localeCompare(`${b.to}:${b.from}`))
```

If `HarnessStore.actions()` sorts by JSON text and produces unstable projection order, update it:

```ts
    return (await list(actionsDir(id), Harness.ActionRecord)).sort((a, b) => a.id.localeCompare(b.id))
```

- [x] **Step 2: Run action graph tests**

Run: `bun test test/harness/action-graph.test.ts`

Expected: all action graph tests pass.

### Task 7: Document M1 Protocol And Acceptance Behavior

**Files:**
- Create: `docs/harness-platform-prd-v2/04-v2-persistent-action-graph.md`
- Modify: `docs/harness-platform-prd-v2/README.md`

- [x] **Step 1: Add the M1 doc**

Create `docs/harness-platform-prd-v2/04-v2-persistent-action-graph.md` with:

```md
# v2 Persistent Action Graph

M1 persists accepted `kind: "act"` records as Action Graph facts. It does not execute actions, create resources, compile context, or decide acceptance quality.

## Stored Records

- `ActionGraph`: run-scoped graph metadata with schema version, status, and timestamps.
- `ActionRecord`: node record with status, dependencies, criteria, failure handling, gate hint, budget, visibility, expected artifact refs, idempotency key, resource locks, cancellation, and retry policy.
- `ActionEdge`: dependency edge from one action id to another.

## Storage Layout

```txt
.opencode/harness/runs/<run_id>/action-graph/
  graph.json
  actions/<action_id>.json
  edges.json
```

## Events And Projection

`action.accepted`, `action_cancel`, and `action_retry` events are appended to the run event log. Runtime rebuilds the `action-graph` projection from stored graph metadata, action records, dependency edges, and events.

The projection exposes:

- `nodes`: persisted action records.
- `edges`: dependency edges.
- `ready`: ready actions whose dependencies are completed.
- `blocked`: blocked actions or actions waiting for dependencies.
- `source_events`: count of run events used as recovery evidence.

## Recovery Boundary

M1 recovery is file-backed and local. Resource Index and Snapshot records are represented only through refs and graph fields in this milestone; M2 and later milestones will attach resource bodies, context snapshots, and richer recovery policy.
```

- [x] **Step 2: Link the M1 doc from README**

Add this row after the `03` row:

```md
| 04 | [v2 持久化 Action Graph](04-v2-persistent-action-graph.md) | 定义 M1 的 Action Graph 存储、事件、投影重建和恢复边界。 |
```

### Task 8: Final Verification

**Files:**
- Verify all touched files.

- [x] **Step 1: Run focused M1 tests**

Run: `bun test test/harness/action-graph.test.ts test/harness/runtime.test.ts test/harness/object-model.test.ts`

Expected: all tests pass.

- [x] **Step 2: Run package typecheck**

Run: `bun typecheck`

Expected: exit 0.

- [x] **Step 3: Inspect M1 diff**

Run: `git diff -- packages/opencode/src/harness/schema.ts packages/opencode/src/harness/store.ts packages/opencode/src/harness/runtime.ts packages/opencode/test/harness/action-graph.test.ts docs/harness-platform-prd-v2/README.md docs/harness-platform-prd-v2/04-v2-persistent-action-graph.md docs/superpowers/plans/2026-06-05-v2-m1-action-graph.md`

Expected: changes are limited to M1 schema/store/runtime/tests/docs/plan.

## Self-Review

- AC-M1-001 covered by `action.accept` command requiring payload `kind: "act"` and persisting `ActionRecord`.
- AC-M1-002 covered by `ActionRecord`, `ActionEdge`, `ActionGraphProjection`, and action graph store/query tests.
- AC-M1-003 covered by `rebuildActionGraph()` rebuilding projection from persisted graph/actions/edges/events; Resource Index and Snapshot remain refs/boundary fields for M2.
- AC-M1-004 covered by `actionGraph(run)` projection query with nodes, edges, blocked reasons, and ready recovery set.
- AC-M1-005 covered by `idempotency_key`, `resource_locks`, `cancellation`, and `retry_policy`, plus cancel/retry command tests.
- Placeholder scan: no TBD/TODO/fill-later steps.
- Type consistency: test names, schema names, command names, and runtime/store method names match across tasks.
