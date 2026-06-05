# v2 M2 Resource Fabric Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Move large model/tool/intermediate content into Resource and Document records while session-facing output carries only summaries and refs.

**Architecture:** Extend the existing `Harness` schemas with M2 resource index contracts, add run-scoped file storage beside M1 Action Graph storage, and expose `HarnessRuntime.writeDocument()` plus a `resource.write` command. Resource bodies are stored under `.opencode/harness/runs/<run>/resources/body/`, index records under `resources/index/`, and Runtime updates a `resource-index` projection after writes, tombstones, and reads. M2 does not implement UI panels, context compilation, Handoff, Memory promotion, or object storage adapters.

**Tech Stack:** TypeScript, Zod, Bun file APIs, existing `HarnessStore`, existing `HarnessRuntime`, Bun test from `packages/opencode`.

---

## File Structure

- Modify: `packages/opencode/src/harness/schema.ts`
  - Add `ResourceKind`, `ResourceRecord`, `DocumentWrite`, `ResourceSessionPart`, `ResourcePreview`, and `ResourceRead`.
  - Add `resource.write` and `resource.tombstone` to `Harness.Command`.
  - Extend `Harness.Summary` with `resources`.
- Modify: `packages/opencode/src/harness/store.ts`
  - Persist resource metadata at `runs/<run>/resources/index/<resource>.json`.
  - Persist resource body at `runs/<run>/resources/body/<resource>.txt`.
  - Expose `resources`, `resource`, `putResource`, `putBody`, and `body`.
- Modify: `packages/opencode/src/harness/runtime.ts`
  - Add `writeDocument(run, input)`, `previewResource(run, id)`, `readResource(run, id)`, `exportResource(run, id, "redacted")`, and `tombstoneResource(run, id)`.
  - Add command handlers for `resource.write` and `resource.tombstone`.
  - Rebuild `resource-index` projection from stored resource metadata.
- Create: `packages/opencode/test/harness/resource-fabric.test.ts`
  - Cover large content session ref behavior, resource index fields, preview/full read/redacted export/tombstone, source action/evidence integration.
- Create: `docs/harness-platform-prd-v2/05-v2-resource-document-fabric.md`
  - Document lifecycle, ref behavior, storage layout, and session boundary.
- Modify: `docs/harness-platform-prd-v2/README.md`
  - Link the new M2 doc.

### Task 1: Add Failing Large Content Resource Tests

**Files:**
- Create: `packages/opencode/test/harness/resource-fabric.test.ts`
- Modify later: `packages/opencode/src/harness/schema.ts`
- Modify later: `packages/opencode/src/harness/store.ts`
- Modify later: `packages/opencode/src/harness/runtime.ts`

- [x] **Step 1: Write failing tests for large content resource refs**

```ts
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import { HarnessRuntime, HarnessStore } from "../../src/harness"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const cfg = {
  constraints: [] as string[],
  memory_scopes: ["project"] as ("project")[],
  automation: "guided" as const,
}
const dirs: string[] = []

async function temp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-harness-resource-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("harness resource fabric", () => {
  test("stores large model output as a resource ref for session display", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "store long output", ...cfg })
        await HarnessRuntime.command({
          type: "action.accept",
          run_id: run.id,
          actor: "runtime",
          payload: { id: "act_writer", kind: "act", title: "Write report", status: "completed" },
        })
        const body = "Architecture note. ".repeat(400)
        const out = await HarnessRuntime.writeDocument(run.id, {
          kind: "model_long_output",
          title: "Architecture report",
          body,
          media_type: "text/markdown",
          producer: { type: "model", id: "agent.writer", run_id: run.id, action_id: "act_writer" },
          source_action: "act_writer",
          visibility: "project",
          evidence: ["action://act_writer"],
          threshold: 100,
        })
        const list = await HarnessStore.resources(run.id)
        const full = await HarnessRuntime.readResource(run.id, out.resource.id)
        const events = await HarnessStore.events(run.id)

        expect(out.session.type).toBe("resource_ref")
        expect(out.session.ref).toBe(`resource://${out.resource.id}`)
        expect(out.session.summary).toContain("Architecture report")
        expect(JSON.stringify(out.session)).not.toContain(body)
        expect(list).toHaveLength(1)
        expect(list[0]?.kind).toBe("model_long_output")
        expect(list[0]?.source_action).toBe("act_writer")
        expect(list[0]?.visibility).toBe("project")
        expect(list[0]?.evidence).toEqual(["action://act_writer"])
        expect(full.body).toBe(body)
        expect(events.map((item) => item.type)).toContain("resource.written")
      },
    })
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test test/harness/resource-fabric.test.ts`

Expected: FAIL because `writeDocument`, `readResource`, `HarnessStore.resources`, and resource schemas are not implemented.

### Task 2: Implement Resource Schemas

**Files:**
- Modify: `packages/opencode/src/harness/schema.ts`
- Test: `packages/opencode/test/harness/resource-fabric.test.ts`

- [x] **Step 1: Add M2 resource contracts**

Add after `ResourceObject`:

```ts
  export const ResourceKind = z
    .enum(["tool_output", "model_long_output", "review_report", "test_report", "research_note", "handoff_state", "context_snapshot", "document"])
    .meta({ ref: "HarnessResourceKind" })
  export type ResourceKind = z.infer<typeof ResourceKind>

  export const ResourceRecord = z
    .object({
      id: z.string(),
      run_id: z.string(),
      kind: ResourceKind,
      uri: Ref,
      summary: z.string(),
      producer: Producer,
      source_action: z.string().optional(),
      visibility: Visibility.default("project"),
      evidence: z.array(Ref).default([]),
      lifecycle: Lifecycle.default("active"),
      media_type: z.string().default("text/plain"),
      size: z.number().int().min(0),
      created_at: z.number(),
      updated_at: z.number(),
    })
    .strict()
    .meta({ ref: "HarnessResourceRecord" })
  export type ResourceRecord = z.infer<typeof ResourceRecord>

  export const DocumentWrite = z
    .object({
      kind: ResourceKind.default("document"),
      title: z.string(),
      body: z.string(),
      media_type: z.string().default("text/plain"),
      summary: z.string().optional(),
      producer: Producer,
      source_action: z.string().optional(),
      visibility: Visibility.default("project"),
      evidence: z.array(Ref).default([]),
      threshold: z.number().int().min(0).default(4000),
      redact: z.array(z.string()).default([]),
    })
    .strict()
    .meta({ ref: "HarnessDocumentWrite" })
  export type DocumentWrite = z.infer<typeof DocumentWrite>

  export const ResourceSessionPart = z
    .object({
      type: z.literal("resource_ref"),
      title: z.string(),
      summary: z.string(),
      ref: Ref,
      next: z.array(z.string()).default([]),
    })
    .strict()
    .meta({ ref: "HarnessResourceSessionPart" })
  export type ResourceSessionPart = z.infer<typeof ResourceSessionPart>

  export const ResourceRead = z
    .object({
      resource: ResourceRecord,
      body: z.string(),
    })
    .strict()
    .meta({ ref: "HarnessResourceRead" })
  export type ResourceRead = z.infer<typeof ResourceRead>

  export const ResourcePreview = z
    .object({
      resource: ResourceRecord,
      preview: z.string(),
      truncated: z.boolean(),
    })
    .strict()
    .meta({ ref: "HarnessResourcePreview" })
  export type ResourcePreview = z.infer<typeof ResourcePreview>
```

Update `Command.type` enum to include:

```ts
        "resource.write",
        "resource.tombstone",
```

Update `Summary`:

```ts
      resources: z.array(ResourceRecord).default([]),
```

- [x] **Step 2: Run test to verify schema-only progress**

Run: `bun test test/harness/resource-fabric.test.ts`

Expected: still FAIL because store/runtime methods are not implemented.

### Task 3: Implement Resource Store

**Files:**
- Modify: `packages/opencode/src/harness/store.ts`
- Test: `packages/opencode/test/harness/resource-fabric.test.ts`

- [x] **Step 1: Add resource paths and store methods**

Add near path helpers:

```ts
  function resourceDir(id: string) {
    return path.join(runDir(id), "resources")
  }

  function indexDir(id: string) {
    return path.join(resourceDir(id), "index")
  }

  function bodyDir(id: string) {
    return path.join(resourceDir(id), "body")
  }
```

Add exports before `summary`:

```ts
  export async function resources(id: string) {
    return (await list(indexDir(id), Harness.ResourceRecord)).sort((a, b) => b.updated_at - a.updated_at)
  }

  export async function resource(run: string, id: string) {
    const file = path.join(indexDir(run), `${id}.json`)
    if (!(await exists(file))) return
    return Harness.ResourceRecord.parse(await Bun.file(file).json())
  }

  export async function putResource(item: Harness.ResourceRecord) {
    await write(path.join(indexDir(item.run_id), `${item.id}.json`), item)
  }

  export async function putBody(run: string, id: string, body: string) {
    await write(path.join(bodyDir(run), `${id}.txt`), body)
  }

  export async function body(run: string, id: string) {
    const file = path.join(bodyDir(run), `${id}.txt`)
    if (!(await exists(file))) return
    return Bun.file(file).text()
  }
```

Update `summary` return:

```ts
      resources: await resources(id),
```

- [x] **Step 2: Run test to verify store-only progress**

Run: `bun test test/harness/resource-fabric.test.ts`

Expected: still FAIL because runtime methods are not implemented.

### Task 4: Implement Runtime Resource Writer And Readers

**Files:**
- Modify: `packages/opencode/src/harness/runtime.ts`
- Test: `packages/opencode/test/harness/resource-fabric.test.ts`

- [x] **Step 1: Add resource projection and summary helpers**

Add after `project()`:

```ts
  function brief(input: Harness.DocumentWrite) {
    return input.summary ?? `${input.title}: ${input.body.slice(0, 120)}${input.body.length > 120 ? "..." : ""}`
  }

  async function resources(run: string) {
    const list = await HarnessStore.resources(run)
    await HarnessStore.projection(run, "resource-index", list)
    return list
  }
```

- [x] **Step 2: Add write/read/preview/export/tombstone APIs**

Add before `command()`:

```ts
  export async function writeDocument(run: string, input: Harness.DocumentWrite) {
    const payload = Harness.DocumentWrite.parse(input)
    const time = now()
    const res = Harness.ResourceRecord.parse({
      id: id("res"),
      run_id: run,
      kind: payload.kind,
      uri: `resource://${id("res-body")}`,
      summary: brief(payload),
      producer: payload.producer,
      source_action: payload.source_action,
      visibility: payload.visibility,
      evidence: payload.evidence,
      lifecycle: "active",
      media_type: payload.media_type,
      size: payload.body.length,
      created_at: time,
      updated_at: time,
    })
    const next = Harness.ResourceRecord.parse({ ...res, uri: `resource://${res.id}` })
    await HarnessStore.putResource(next)
    await HarnessStore.putBody(run, next.id, payload.body)
    await HarnessStore.append(event("resource.written", { run, actor: payload.producer.id, summary: next.summary, payload: { resource_id: next.id, source_action: next.source_action } }))
    await resources(run)
    return {
      resource: next,
      session: Harness.ResourceSessionPart.parse({
        type: "resource_ref",
        title: payload.title,
        summary: next.summary,
        ref: next.uri,
        next: payload.body.length > payload.threshold ? ["preview", "full_read", "redacted_export"] : ["full_read"],
      }),
    }
  }

  export async function readResource(run: string, id: string) {
    const resource = await HarnessStore.resource(run, id)
    if (!resource) throw new Error(`Resource not found: ${id}`)
    const body = await HarnessStore.body(run, id)
    if (body === undefined) throw new Error(`Resource body not found: ${id}`)
    return Harness.ResourceRead.parse({ resource, body })
  }

  export async function previewResource(run: string, id: string) {
    const data = await readResource(run, id)
    return Harness.ResourcePreview.parse({
      resource: data.resource,
      preview: data.body.slice(0, 240),
      truncated: data.body.length > 240,
    })
  }

  export async function exportResource(run: string, id: string, format: "redacted") {
    const data = await readResource(run, id)
    if (format !== "redacted") throw new Error(`Unsupported export: ${format}`)
    return {
      resource: data.resource,
      body: data.body.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "[redacted-email]"),
    }
  }

  export async function tombstoneResource(run: string, id: string) {
    const data = await readResource(run, id)
    const next = Harness.ResourceRecord.parse({ ...data.resource, lifecycle: "tombstoned", updated_at: now() })
    await HarnessStore.putResource(next)
    await HarnessStore.append(event("resource.tombstoned", { run, payload: { resource_id: id } }))
    await resources(run)
    return next
  }
```

- [x] **Step 3: Add command handlers**

Add in `command()` after action handlers:

```ts
    if (input.type === "resource.write") {
      const out = await writeDocument(run.id, Harness.DocumentWrite.parse(input.payload))
      return {
        run: await refresh(run),
        resource: out.resource,
        session: out.session,
      }
    }
    if (input.type === "resource.tombstone" && input.payload.id) {
      const resource = await tombstoneResource(run.id, String(input.payload.id))
      return {
        run: await refresh(run),
        resource,
      }
    }
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun test test/harness/resource-fabric.test.ts`

Expected: PASS for large content resource ref test.

### Task 5: Add Failing Preview Export Tombstone Tests

**Files:**
- Modify: `packages/opencode/test/harness/resource-fabric.test.ts`

- [x] **Step 1: Add lifecycle and read behavior tests**

Append inside `describe`:

```ts
  test("supports preview full read redacted export and tombstone", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "inspect resource", ...cfg })
        const body = `${"test report line. ".repeat(30)} contact me@example.com`
        const out = await HarnessRuntime.writeDocument(run.id, {
          kind: "test_report",
          title: "Test report",
          body,
          producer: { type: "tool", id: "bun.test", run_id: run.id },
          visibility: "team",
          evidence: ["trace://trace_report"],
          threshold: 20,
        })

        const preview = await HarnessRuntime.previewResource(run.id, out.resource.id)
        const full = await HarnessRuntime.readResource(run.id, out.resource.id)
        const redacted = await HarnessRuntime.exportResource(run.id, out.resource.id, "redacted")
        const tomb = await HarnessRuntime.tombstoneResource(run.id, out.resource.id)
        const list = await HarnessStore.resources(run.id)

        expect(preview.preview.length).toBeLessThan(full.body.length)
        expect(preview.truncated).toBe(true)
        expect(redacted.body).toContain("[redacted-email]")
        expect(redacted.body).not.toContain("me@example.com")
        expect(tomb.lifecycle).toBe("tombstoned")
        expect(list[0]?.lifecycle).toBe("tombstoned")
        expect(list[0]?.visibility).toBe("team")
      },
    })
  })

  test("resource.write command records index and session ref", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "command resource", ...cfg })
        const out = await HarnessRuntime.command({
          type: "resource.write",
          run_id: run.id,
          actor: "runtime",
          payload: {
            kind: "tool_output",
            title: "Tool output",
            body: "tool output body".repeat(40),
            producer: { type: "tool", id: "bash", run_id: run.id },
            threshold: 10,
          },
        })

        expect(out.resource.kind).toBe("tool_output")
        expect(out.session.ref).toBe(`resource://${out.resource.id}`)
      },
    })
  })
```

- [x] **Step 2: Run tests to verify they fail if lifecycle command paths are incomplete**

Run: `bun test test/harness/resource-fabric.test.ts`

Expected: FAIL if preview/export/tombstone/command behavior is incomplete.

### Task 6: Finish Lifecycle Behavior

**Files:**
- Modify: `packages/opencode/src/harness/runtime.ts`
- Test: `packages/opencode/test/harness/resource-fabric.test.ts`

- [x] **Step 1: Fix any failing lifecycle behavior**

Use the failing assertion to make the minimal runtime or schema adjustment. Expected stable behavior:

```ts
preview.truncated === true
redacted.body does not contain an email address
tombstoneResource() sets lifecycle to "tombstoned"
resource.write returns { run, resource, session }
```

- [x] **Step 2: Run resource tests**

Run: `bun test test/harness/resource-fabric.test.ts`

Expected: all resource fabric tests pass.

### Task 7: Document M2 Resource Lifecycle

**Files:**
- Create: `docs/harness-platform-prd-v2/05-v2-resource-document-fabric.md`
- Modify: `docs/harness-platform-prd-v2/README.md`

- [x] **Step 1: Add the M2 doc**

Create `docs/harness-platform-prd-v2/05-v2-resource-document-fabric.md` with storage layout, lifecycle states, session boundary, and supported operations: write, preview, full read, redacted export, tombstone.

- [x] **Step 2: Link the M2 doc from README**

Add:

```md
| 05 | [v2 Resource / Document Fabric](05-v2-resource-document-fabric.md) | 定义 M2 的资源索引、文档写入、会话 ref 边界和生命周期。 |
```

### Task 8: Final Verification

**Files:**
- Verify all touched files.

- [x] **Step 1: Run focused M2 tests**

Run: `bun test test/harness/resource-fabric.test.ts test/harness/action-graph.test.ts test/harness/runtime.test.ts test/harness/object-model.test.ts`

Expected: all tests pass.

- [x] **Step 2: Run package typecheck**

Run: `bun typecheck`

Expected: exit 0.

- [x] **Step 3: Inspect M2 diff**

Run: `git diff -- packages/opencode/src/harness/schema.ts packages/opencode/src/harness/store.ts packages/opencode/src/harness/runtime.ts packages/opencode/test/harness/resource-fabric.test.ts docs/harness-platform-prd-v2/README.md docs/harness-platform-prd-v2/05-v2-resource-document-fabric.md docs/superpowers/plans/2026-06-05-v2-m2-resource-fabric.md`

Expected: changes are limited to M2 schema/store/runtime/tests/docs/plan.

## Self-Review

- AC-M2-001 covered by `DocumentWrite.kind` and resource fabric tests for model output, tool output, and test report; remaining kinds use the same schema and writer.
- AC-M2-002 covered by `ResourceRecord` and store/index tests.
- AC-M2-003 covered by `ResourceSessionPart` tests verifying large body is excluded from session JSON.
- AC-M2-004 covered by evidence/source action refs and projection storage; Handoff/Workflow/Memory consumers remain later milestones.
- AC-M2-005 covered by preview, full read, redacted export, and tombstone tests.
- Placeholder scan: no TBD/TODO/fill-later steps.
- Type consistency: schema names, store names, runtime names, and tests match across tasks.
