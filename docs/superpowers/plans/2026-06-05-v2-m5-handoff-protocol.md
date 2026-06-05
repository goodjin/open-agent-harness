# v2 M5 Handoff Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Persist assign, handoff, and sync communication records as ref-based runtime objects.

**Architecture:** Add canonical Handoff records to the v2 harness schema and run store, expose runtime writer/normalizer/context helper APIs, and let M3 Context Compiler consume downstream handoff refs plus resource/projection/trace refs. Handoff bodies stay summaries and refs only; large state remains in Resource records.

**Tech Stack:** TypeScript, Bun test, Zod schemas, existing harness file store, M2 Resource refs, M3 Context Compiler.

---

### Task 1: Failing Handoff Tests

**Files:**
- Create: `packages/opencode/test/harness/handoff-protocol.test.ts`

- [x] **Step 1: Write failing tests**

Create tests for persisted assign/handoff/sync records and downstream context refs.

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
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-harness-handoff-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("harness handoff protocol", () => {
  test("persists assign records with refs instead of transcript body", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "handoff work", ...cfg })
        const note = await HarnessRuntime.writeDocument(run.id, {
          kind: "handoff_state",
          title: "Assignment state",
          body: "raw transcript line ".repeat(80),
          summary: "assignment state summary",
          producer: { type: "agent", id: "planner", run_id: run.id },
          visibility: "project",
        })
        const out = await HarnessRuntime.writeHandoff(run.id, {
          kind: "assign",
          source: { type: "agent", id: "planner" },
          target: { type: "agent", id: "worker" },
          summary: "Worker should implement the next action",
          state: "ready",
          evidence: ["action://act_plan"],
          risks: ["schema may change"],
          unresolved: ["confirm verifier"],
          next: ["compile context", "start worker"],
          resource_refs: [note.resource.uri],
          projection_ref: "projection://action-graph",
          trace_ref: "trace://assign-trace",
        })
        const list = await HarnessStore.handoffs(run.id)
        const events = await HarnessStore.events(run.id)

        expect(out.uri).toBe(`handoff://${out.id}`)
        expect(out.kind).toBe("assign")
        expect(out.source.id).toBe("planner")
        expect(out.target.id).toBe("worker")
        expect(out.resource_refs).toEqual([note.resource.uri])
        expect(JSON.stringify(out)).not.toContain("raw transcript line")
        expect(list).toHaveLength(1)
        expect(events.map((item) => item.type)).toContain("handoff.assign")
      },
    })
  })

  test("normalizes sync into canonical handoff records", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "sync work", ...cfg })
        const sync = HarnessRuntime.normalizeSync({
          source: { type: "agent", id: "worker" },
          target: { type: "agent", id: "planner" },
          summary: "Tests are running",
          evidence: ["trace://test-start"],
          risks: ["long test duration"],
          unresolved: ["await result"],
          next: ["send final handoff"],
          resource_refs: ["resource://test-report", "resource://test-report"],
          trace_ref: "trace://sync-trace",
        })
        const out = await HarnessRuntime.writeHandoff(run.id, sync)

        expect(out.kind).toBe("sync")
        expect(out.state).toBe("ready")
        expect(out.resource_refs).toEqual(["resource://test-report"])
        expect(out.refs).toContain("trace://sync-trace")
        expect(out.evidence).toEqual(["trace://test-start"])
      },
    })
  })

  test("builds downstream context from handoff and resource refs", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "compile handoff context", ...cfg })
        const report = await HarnessRuntime.writeDocument(run.id, {
          kind: "review_report",
          title: "Review report",
          body: "review body with evidence",
          summary: "review summary",
          producer: { type: "agent", id: "verifier", run_id: run.id },
          visibility: "project",
        })
        const hand = await HarnessRuntime.writeHandoff(run.id, {
          kind: "handoff",
          source: { type: "agent", id: "worker" },
          target: { type: "agent", id: "verifier" },
          summary: "Verify the implementation",
          state: "ready",
          resource_refs: [report.resource.uri],
          projection_ref: "projection://action-graph",
          trace_ref: "trace://worker-trace",
          context_ref: "snapshot://worker-context",
          next: ["run verification"],
        })

        const out = await HarnessRuntime.handoffContext(run.id, hand.id, {
          goal: "verify implementation",
          token_budget: 200,
          visibility: "project",
        })

        expect(out.refs.handoff_ref).toBe(hand.uri)
        expect(out.refs.resource_refs).toEqual([report.resource.uri])
        expect(out.bundle.refs).toContain(hand.uri)
        expect(out.bundle.refs).toContain(report.resource.uri)
        expect(out.bundle.refs).toContain("projection://action-graph")
        expect(out.bundle.refs).toContain("trace://worker-trace")
        expect(out.bundle.summary).toContain("review summary")
      },
    })
  })
})
```

- [x] **Step 2: Verify RED**

Run from `packages/opencode`:

```bash
bun test test/harness/handoff-protocol.test.ts
```

Expected: fail because `writeHandoff`, `normalizeSync`, `handoffContext`, and `HarnessStore.handoffs` do not exist.

### Task 2: Handoff Schema And Store

**Files:**
- Modify: `packages/opencode/src/harness/schema.ts`
- Modify: `packages/opencode/src/harness/store.ts`

- [x] **Step 1: Add Handoff schemas**

Add:

```ts
export const HandoffKind = z.enum(["assign", "handoff", "sync"]).meta({ ref: "HarnessHandoffKind" })
export type HandoffKind = z.infer<typeof HandoffKind>

export const HandoffParty = z
  .object({
    type: z.enum(["user", "agent", "runtime", "system"]),
    id: z.string(),
    assignment_id: z.string().optional(),
    session_id: z.string().optional(),
  })
  .strict()
  .meta({ ref: "HarnessHandoffParty" })
export type HandoffParty = z.infer<typeof HandoffParty>

export const HandoffRefs = z
  .object({
    handoff_ref: Ref,
    resource_refs: z.array(Ref).default([]),
    projection_ref: Ref.optional(),
    trace_ref: Ref.optional(),
    context_ref: Ref.optional(),
  })
  .strict()
  .meta({ ref: "HarnessHandoffRefs" })
export type HandoffRefs = z.infer<typeof HandoffRefs>

export const HandoffRecord = z
  .object({
    id: z.string(),
    run_id: z.string(),
    kind: HandoffKind,
    uri: Ref,
    source: HandoffParty,
    target: HandoffParty,
    summary: z.string(),
    state: z.enum(["draft", "ready", "sent", "received", "blocked", "completed"]).default("ready"),
    evidence: z.array(Ref).default([]),
    risks: z.array(z.string()).default([]),
    unresolved: z.array(z.string()).default([]),
    next: z.array(z.string()).default([]),
    refs: z.array(Ref).default([]),
    resource_refs: z.array(Ref).default([]),
    projection_ref: Ref.optional(),
    trace_ref: Ref.optional(),
    context_ref: Ref.optional(),
    created_at: z.number(),
    updated_at: z.number(),
  })
  .strict()
  .meta({ ref: "HarnessHandoffRecord" })
export type HandoffRecord = z.infer<typeof HandoffRecord>

export const HandoffWrite = HandoffRecord.omit({ id: true, run_id: true, uri: true, refs: true, created_at: true, updated_at: true })
  .extend({
    state: z.enum(["draft", "ready", "sent", "received", "blocked", "completed"]).default("ready"),
    evidence: z.array(Ref).default([]),
    risks: z.array(z.string()).default([]),
    unresolved: z.array(z.string()).default([]),
    next: z.array(z.string()).default([]),
    resource_refs: z.array(Ref).default([]),
  })
  .strict()
  .meta({ ref: "HarnessHandoffWrite" })
export type HandoffWrite = z.infer<typeof HandoffWrite>

export const HandoffContextInput = z
  .object({
    goal: z.string(),
    token_budget: z.number().int().nonnegative().default(4000),
    visibility: Visibility.default("project"),
  })
  .strict()
  .meta({ ref: "HarnessHandoffContextInput" })
export type HandoffContextInput = z.infer<typeof HandoffContextInput>
```

Add `handoffs: z.array(HandoffRecord).default([])` to `Summary`.

- [x] **Step 2: Add store methods**

Add:

```ts
function handoffsDir(id: string) {
  return path.join(runDir(id), "handoffs")
}

export async function handoffs(id: string) {
  return (await list(handoffsDir(id), Harness.HandoffRecord)).sort((a, b) => b.updated_at - a.updated_at)
}

export async function handoff(run: string, id: string) {
  const file = path.join(handoffsDir(run), `${id}.json`)
  if (!(await exists(file))) return
  return Harness.HandoffRecord.parse(await Bun.file(file).json())
}

export async function putHandoff(item: Harness.HandoffRecord) {
  await write(path.join(handoffsDir(item.run_id), `${item.id}.json`), item)
}
```

Include `handoffs: await handoffs(id)` in `summary()`.

- [x] **Step 3: Verify RED remains runtime gap**

Run from `packages/opencode`:

```bash
bun test test/harness/handoff-protocol.test.ts
```

Expected: still fail because runtime functions do not exist.

### Task 3: Runtime Writer, Sync Normalizer, Context Refs

**Files:**
- Modify: `packages/opencode/src/harness/runtime.ts`

- [x] **Step 1: Add helper functions**

Add helpers inside `HarnessRuntime`:

```ts
function refs(input: { resource_refs?: Harness.Ref[]; projection_ref?: Harness.Ref; trace_ref?: Harness.Ref; context_ref?: Harness.Ref }) {
  return uniq([...(input.resource_refs ?? []), input.projection_ref, input.trace_ref, input.context_ref].filter((item): item is Harness.Ref => Boolean(item)))
}
```

- [x] **Step 2: Implement APIs**

Add:

```ts
export function normalizeSync(input: z.input<typeof Harness.HandoffWrite>) {
  const item = Harness.HandoffWrite.parse({ ...input, kind: "sync", state: input.state ?? "ready" })
  return Harness.HandoffWrite.parse({ ...item, resource_refs: uniq(item.resource_refs) })
}

export async function writeHandoff(run: string, input: z.input<typeof Harness.HandoffWrite>) {
  const payload = Harness.HandoffWrite.parse(input)
  const time = now()
  const hid = id("handoff")
  const item = Harness.HandoffRecord.parse({
    ...payload,
    id: hid,
    run_id: run,
    uri: `handoff://${hid}`,
    refs: refs(payload),
    resource_refs: uniq(payload.resource_refs),
    created_at: time,
    updated_at: time,
  })
  await HarnessStore.putHandoff(item)
  await HarnessStore.append(event(`handoff.${item.kind}`, { run, actor: item.source.id, summary: item.summary, payload: { handoff_id: item.id, target: item.target.id } }))
  await HarnessStore.projection(run, "handoffs", await HarnessStore.handoffs(run))
  return item
}

export async function handoffContext(run: string, id: string, input: z.input<typeof Harness.HandoffContextInput>) {
  const payload = Harness.HandoffContextInput.parse(input)
  const item = await HarnessStore.handoff(run, id)
  if (!item) throw new Error(`Handoff not found: ${id}`)
  const out = Harness.HandoffRefs.parse({
    handoff_ref: item.uri,
    resource_refs: item.resource_refs,
    projection_ref: item.projection_ref,
    trace_ref: item.trace_ref,
    context_ref: item.context_ref,
  })
  const list = uniq([out.handoff_ref, ...out.resource_refs, out.projection_ref, out.trace_ref, out.context_ref].filter((ref): ref is Harness.Ref => Boolean(ref)))
  return {
    refs: out,
    bundle: await compileContext({
      run_id: run,
      goal: payload.goal,
      refs: list,
      expansion: Object.fromEntries(item.resource_refs.map((ref) => [ref, "adaptive"])),
      token_budget: payload.token_budget,
      visibility: payload.visibility,
    }),
  }
}
```

- [x] **Step 3: Verify GREEN**

Run from `packages/opencode`:

```bash
bun test test/harness/handoff-protocol.test.ts
```

Expected: 3 tests pass.

### Task 4: Docs, Regression, Commit

**Files:**
- Create: `docs/harness-platform-prd-v2/08-v2-handoff-protocol.md`
- Modify: `docs/harness-platform-prd-v2/README.md`
- Modify: `docs/superpowers/plans/2026-06-05-v2-m5-handoff-protocol.md`

- [x] **Step 1: Add M5 docs**

Create `docs/harness-platform-prd-v2/08-v2-handoff-protocol.md` documenting canonical records, writer/normalizer boundaries, downstream refs, and examples.

- [x] **Step 2: Update README doc map**

Add:

```md
| 08 | [v2 Handoff Protocol](08-v2-handoff-protocol.md) | 定义 M5 的 assign/handoff/sync 记录、refs 交接和下游 Context Compiler 使用方式。 |
```

- [x] **Step 3: Mark this plan complete**

Replace completed checkboxes with `[x]`.

- [x] **Step 4: Run focused verification**

Run from `packages/opencode`:

```bash
bun test test/harness/handoff-protocol.test.ts test/harness/context-compiler.test.ts test/harness/agent-assignment.test.ts test/harness/resource-fabric.test.ts test/harness/action-graph.test.ts test/harness/runtime.test.ts test/harness/object-model.test.ts
bun typecheck
```

Expected: all tests pass and typecheck exits 0.

- [x] **Step 5: Commit M5**

From worktree root:

```bash
git status --short
git add packages/opencode/src/harness/schema.ts packages/opencode/src/harness/store.ts packages/opencode/src/harness/runtime.ts packages/opencode/test/harness/handoff-protocol.test.ts docs/harness-platform-prd-v2/README.md docs/harness-platform-prd-v2/08-v2-handoff-protocol.md docs/superpowers/plans/2026-06-05-v2-m5-handoff-protocol.md
git commit -m "feat: add v2 handoff protocol"
```
