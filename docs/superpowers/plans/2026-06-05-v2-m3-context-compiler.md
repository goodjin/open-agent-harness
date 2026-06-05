# v2 M3 Context Compiler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build the M3 Context Compiler so runtime callers can compile bounded context bundles from user input and v2 refs.

**Architecture:** Add typed Context Bundle records to the v2 harness schema, persist bundles under each run, and expose `compileContext()` / `previewContext()` from `HarnessRuntime`. Resource refs can expand to summary, structured, full, on-demand, on-failure, or adaptive records; unsupported Handoff/Memory/Projection refs are kept as summaries or excluded with clear preview reasons until their later milestones land.

**Tech Stack:** TypeScript, Bun test, Zod schemas, existing `.opencode/harness` file-backed store.

---

### Task 1: Failing Context Compiler Tests

**Files:**
- Create: `packages/opencode/test/harness/context-compiler.test.ts`

- [x] **Step 1: Write failing tests for budget, visibility, and expansion modes**

Create `packages/opencode/test/harness/context-compiler.test.ts` with tests that call `HarnessRuntime.compileContext()` and `HarnessRuntime.previewContext()`.

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
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-harness-context-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("harness context compiler", () => {
  test("compiles resource refs with token budget downgrades and excluded records", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "compile context", ...cfg })
        const small = await HarnessRuntime.writeDocument(run.id, {
          kind: "research_note",
          title: "Short note",
          body: "small implementation note",
          summary: "short summary",
          producer: { type: "model", id: "agent.writer", run_id: run.id },
          visibility: "project",
        })
        const large = await HarnessRuntime.writeDocument(run.id, {
          kind: "model_long_output",
          title: "Long note",
          body: "large implementation detail ".repeat(120),
          summary: "large summary",
          producer: { type: "model", id: "agent.writer", run_id: run.id },
          visibility: "project",
        })

        const out = await HarnessRuntime.compileContext({
          run_id: run.id,
          goal: "prepare implementation",
          user_input: "use the short note first",
          refs: [small.resource.uri, large.resource.uri],
          expansion: {
            [small.resource.uri]: "full",
            [large.resource.uri]: "adaptive",
          },
          token_budget: 30,
          visibility: "project",
        })
        const list = await HarnessStore.contextBundles(run.id)

        expect(out.included.map((item) => item.ref)).toContain(small.resource.uri)
        expect(out.included.find((item) => item.ref === small.resource.uri)?.mode).toBe("full")
        expect(out.included.find((item) => item.ref === large.resource.uri)?.mode).toBe("summary")
        expect(out.included.find((item) => item.ref === large.resource.uri)?.reason).toContain("downgraded")
        expect(out.tokens_used).toBeLessThanOrEqual(out.token_budget)
        expect(out.summary).toContain("short summary")
        expect(out.refs).toEqual([small.resource.uri, large.resource.uri])
        expect(list).toHaveLength(1)
      },
    })
  })

  test("excludes private refs from project context and previews the reason", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "respect visibility", ...cfg })
        const private = await HarnessRuntime.writeDocument(run.id, {
          kind: "tool_output",
          title: "Private output",
          body: "private command output",
          summary: "private summary",
          producer: { type: "tool", id: "shell", run_id: run.id },
          visibility: "private",
        })

        const out = await HarnessRuntime.previewContext({
          run_id: run.id,
          goal: "show context",
          refs: [private.resource.uri],
          expansion: { [private.resource.uri]: "full" },
          token_budget: 100,
          visibility: "project",
        })

        expect(out.bundle.included).toHaveLength(0)
        expect(out.bundle.excluded[0]?.ref).toBe(private.resource.uri)
        expect(out.bundle.excluded[0]?.reason).toContain("visibility")
        expect(out.explanations[0]?.decision).toBe("excluded")
        expect(out.explanations[0]?.reason).toContain("private")
      },
    })
  })

  test("supports summary structured full deferred and adaptive expansion modes", async () => {
    await Instance.provide({
      directory: await temp(),
      fn: async () => {
        const run = await HarnessRuntime.create({ goal: "expand refs", ...cfg })
        const doc = await HarnessRuntime.writeDocument(run.id, {
          kind: "test_report",
          title: "Test report",
          body: "full body from tests",
          summary: "test summary",
          producer: { type: "tool", id: "bun.test", run_id: run.id },
          visibility: "project",
          evidence: ["trace://test-run"],
        })
        const refs = [
          doc.resource.uri,
          "handoff://next-agent",
          "memory://project-note",
          "projection://run-state",
        ]

        const out = await HarnessRuntime.compileContext({
          run_id: run.id,
          goal: "choose expansion",
          refs,
          expansion: {
            [doc.resource.uri]: "structured",
            "handoff://next-agent": "on_demand",
            "memory://project-note": "on_failure",
            "projection://run-state": "summary",
          },
          token_budget: 200,
          visibility: "project",
        })

        const item = out.included.find((next) => next.ref === doc.resource.uri)
        expect(item?.mode).toBe("structured")
        expect(item?.content).toContain("test_report")
        expect(item?.content).toContain("trace://test-run")
        expect(out.excluded.find((next) => next.ref === "handoff://next-agent")?.reason).toContain("on demand")
        expect(out.excluded.find((next) => next.ref === "memory://project-note")?.reason).toContain("on failure")
        expect(out.included.find((next) => next.ref === "projection://run-state")?.content).toContain("projection://run-state")
      },
    })
  })
})
```

- [x] **Step 2: Run tests to verify RED**

Run from `packages/opencode`:

```bash
bun test test/harness/context-compiler.test.ts
```

Expected: fail because `compileContext`, `previewContext`, and `contextBundles` do not exist yet.

### Task 2: Schema And Store

**Files:**
- Modify: `packages/opencode/src/harness/schema.ts`
- Modify: `packages/opencode/src/harness/store.ts`

- [x] **Step 1: Add Context schemas**

Add schema definitions near existing `ContextObject`:

```ts
export const RefExpansionMode = z.enum(["summary", "structured", "full", "on_failure", "on_demand", "adaptive"]).meta({ ref: "HarnessRefExpansionMode" })
export type RefExpansionMode = z.infer<typeof RefExpansionMode>

export const ContextRecord = z
  .object({
    ref: Ref,
    mode: RefExpansionMode,
    visibility: Visibility,
    summary: z.string(),
    content: z.string(),
    reason: z.string(),
    tokens: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ ref: "HarnessContextRecord" })
export type ContextRecord = z.infer<typeof ContextRecord>

export const ContextExcludedRecord = z
  .object({
    ref: Ref,
    mode: RefExpansionMode,
    visibility: Visibility.optional(),
    reason: z.string(),
  })
  .strict()
  .meta({ ref: "HarnessContextExcludedRecord" })
export type ContextExcludedRecord = z.infer<typeof ContextExcludedRecord>

export const ContextBundle = z
  .object({
    id: z.string(),
    run_id: z.string(),
    assignment_id: z.string().optional(),
    goal: z.string(),
    user_input: z.string().default(""),
    included: z.array(ContextRecord).default([]),
    excluded: z.array(ContextExcludedRecord).default([]),
    refs: z.array(Ref).default([]),
    summary: z.string(),
    token_budget: z.number().int().nonnegative(),
    tokens_used: z.number().int().nonnegative(),
    visibility: Visibility.default("project"),
    created_at: z.number(),
  })
  .strict()
  .meta({ ref: "HarnessContextBundle" })
export type ContextBundle = z.infer<typeof ContextBundle>

export const ContextCompileInput = z
  .object({
    run_id: z.string(),
    assignment_id: z.string().optional(),
    goal: z.string(),
    user_input: z.string().default(""),
    refs: z.array(Ref).default([]),
    resource_refs: z.array(Ref).default([]),
    handoff_refs: z.array(Ref).default([]),
    memory_refs: z.array(Ref).default([]),
    expansion: z.record(Ref, RefExpansionMode).default({}),
    token_budget: z.number().int().nonnegative().default(4000),
    visibility: Visibility.default("project"),
  })
  .strict()
  .meta({ ref: "HarnessContextCompileInput" })
export type ContextCompileInput = z.infer<typeof ContextCompileInput>

export const ContextPreview = z
  .object({
    bundle: ContextBundle,
    explanations: z.array(
      z
        .object({
          ref: Ref,
          decision: z.enum(["included", "excluded"]),
          mode: RefExpansionMode,
          reason: z.string(),
        })
        .strict(),
    ),
  })
  .strict()
  .meta({ ref: "HarnessContextPreview" })
export type ContextPreview = z.infer<typeof ContextPreview>
```

- [x] **Step 2: Add context bundle store methods**

Add run-scoped context directory helpers and methods:

```ts
function contextsDir(id: string) {
  return path.join(runDir(id), "contexts")
}

export async function contextBundles(id: string) {
  return (await list(contextsDir(id), Harness.ContextBundle)).sort((a, b) => b.created_at - a.created_at)
}

export async function putContextBundle(item: Harness.ContextBundle) {
  await write(path.join(contextsDir(item.run_id), `${item.id}.json`), item)
}
```

Also include `contexts: await contextBundles(id)` in `summary()`.

- [x] **Step 3: Run RED again**

Run from `packages/opencode`:

```bash
bun test test/harness/context-compiler.test.ts
```

Expected: still fail because runtime APIs are not implemented.

### Task 3: Runtime Compiler

**Files:**
- Modify: `packages/opencode/src/harness/runtime.ts`

- [x] **Step 1: Add helper functions**

Add helpers inside `HarnessRuntime`:

```ts
function tokens(input: string) {
  return Math.ceil(input.length / 4)
}

function resId(ref: string) {
  return ref.startsWith("resource://") ? ref.slice("resource://".length) : undefined
}

function access(item: Harness.Visibility, ctx: Harness.Visibility) {
  if (item === "public") return true
  if (item === "team") return ctx === "team"
  if (item === "project") return ctx === "project" || ctx === "team"
  return ctx === "private"
}

function uniq(list: Harness.Ref[]) {
  return [...new Set(list)]
}
```

- [x] **Step 2: Implement `compileContext()` and `previewContext()`**

Implement a minimal compiler that expands resource refs, downgrades adaptive/full records to summary when the body would exceed budget, excludes `on_demand` and `on_failure` refs, and writes `context-preview` projection.

```ts
export async function compileContext(input: Harness.ContextCompileInput) {
  const payload = Harness.ContextCompileInput.parse(input)
  const time = now()
  const refs = uniq([...payload.refs, ...payload.resource_refs, ...payload.handoff_refs, ...payload.memory_refs])
  const seed = tokens(`${payload.goal}\n${payload.user_input}`)
  const state = await refs.reduce(
    async (prev, ref) => {
      const acc = await prev
      const mode = payload.expansion[ref] ?? "summary"
      if (mode === "on_demand" || mode === "on_failure") {
        return {
          ...acc,
          excluded: [...acc.excluded, Harness.ContextExcludedRecord.parse({ ref, mode, reason: mode === "on_demand" ? "deferred until on demand" : "deferred until failure" })],
          explanations: [...acc.explanations, { ref, decision: "excluded" as const, mode, reason: mode === "on_demand" ? "deferred until on demand" : "deferred until failure" }],
        }
      }
      const id = resId(ref)
      if (!id) {
        const text = `ref ${ref}`
        const cost = tokens(text)
        return {
          ...acc,
          used: acc.used + cost,
          included: [
            ...acc.included,
            Harness.ContextRecord.parse({ ref, mode: "summary", visibility: payload.visibility, summary: text, content: text, reason: "non-resource ref kept as summary", tokens: cost }),
          ],
          explanations: [...acc.explanations, { ref, decision: "included" as const, mode: "summary" as const, reason: "non-resource ref kept as summary" }],
        }
      }
      const data = await readResource(payload.run_id, id)
      if (!access(data.resource.visibility, payload.visibility)) {
        return {
          ...acc,
          excluded: [...acc.excluded, Harness.ContextExcludedRecord.parse({ ref, mode, visibility: data.resource.visibility, reason: `visibility ${data.resource.visibility} not available to ${payload.visibility}` })],
          explanations: [...acc.explanations, { ref, decision: "excluded" as const, mode, reason: `visibility ${data.resource.visibility} not available to ${payload.visibility}` }],
        }
      }
      const full = mode === "full" || mode === "adaptive"
      const structured = JSON.stringify({ kind: data.resource.kind, summary: data.resource.summary, evidence: data.resource.evidence, uri: data.resource.uri })
      const text = mode === "structured" ? structured : full ? data.body : data.resource.summary
      const cost = tokens(text)
      const sum = data.resource.summary
      if (acc.used + cost <= payload.token_budget) {
        return {
          ...acc,
          used: acc.used + cost,
          included: [
            ...acc.included,
            Harness.ContextRecord.parse({ ref, mode, visibility: data.resource.visibility, summary: sum, content: text, reason: `${mode} expansion selected`, tokens: cost }),
          ],
          explanations: [...acc.explanations, { ref, decision: "included" as const, mode, reason: `${mode} expansion selected` }],
        }
      }
      const low = tokens(sum)
      if (acc.used + low <= payload.token_budget) {
        return {
          ...acc,
          used: acc.used + low,
          included: [
            ...acc.included,
            Harness.ContextRecord.parse({ ref, mode: "summary", visibility: data.resource.visibility, summary: sum, content: sum, reason: "downgraded by token budget", tokens: low }),
          ],
          explanations: [...acc.explanations, { ref, decision: "included" as const, mode: "summary" as const, reason: "downgraded by token budget" }],
        }
      }
      return {
        ...acc,
        excluded: [...acc.excluded, Harness.ContextExcludedRecord.parse({ ref, mode, visibility: data.resource.visibility, reason: "token budget exceeded" })],
        explanations: [...acc.explanations, { ref, decision: "excluded" as const, mode, reason: "token budget exceeded" }],
      }
    },
    Promise.resolve({ used: seed, included: [] as Harness.ContextRecord[], excluded: [] as Harness.ContextExcludedRecord[], explanations: [] as Harness.ContextPreview["explanations"] }),
  )
  const bundle = Harness.ContextBundle.parse({
    id: id("ctx"),
    run_id: payload.run_id,
    assignment_id: payload.assignment_id,
    goal: payload.goal,
    user_input: payload.user_input,
    included: state.included,
    excluded: state.excluded,
    refs,
    summary: state.included.map((item) => item.summary).join("\n").slice(0, 600),
    token_budget: payload.token_budget,
    tokens_used: state.used,
    visibility: payload.visibility,
    created_at: time,
  })
  await HarnessStore.putContextBundle(bundle)
  await HarnessStore.projection(payload.run_id, "context-preview", { bundle, explanations: state.explanations })
  await HarnessStore.append(event("context.compiled", { run: payload.run_id, summary: bundle.summary, payload: { context_id: bundle.id, refs: refs.length } }))
  return bundle
}

export async function previewContext(input: Harness.ContextCompileInput) {
  const bundle = await compileContext(input)
  const projections = await HarnessStore.projections(bundle.run_id)
  const item = projections.find((next) => next.name === "context-preview")
  return Harness.ContextPreview.parse(item?.data ?? { bundle, explanations: [] })
}
```

- [x] **Step 3: Run tests to verify GREEN**

Run from `packages/opencode`:

```bash
bun test test/harness/context-compiler.test.ts
```

Expected: 3 tests pass.

### Task 4: Docs And Regression

**Files:**
- Create: `docs/harness-platform-prd-v2/07-v2-context-compiler.md`
- Modify: `docs/harness-platform-prd-v2/README.md`
- Modify: `docs/superpowers/plans/2026-06-05-v2-m3-context-compiler.md`

- [x] **Step 1: Add M3 doc**

Create `docs/harness-platform-prd-v2/07-v2-context-compiler.md`:

```md
# v2 Context Compiler

M3 builds the Context Bundle that model sessions consume. It compiles user input, current Projection summaries, Resource refs, Handoff refs, Memory refs, and Agent Session hints into a bounded record that can be previewed before it is sent to a model.

## Context Bundle

`ContextBundle` stores:

- `id`, `run_id`, optional `assignment_id`
- `goal` and `user_input`
- included records with `ref`, expansion `mode`, `summary`, `content`, `visibility`, `reason`, and token estimate
- excluded records with `ref`, requested `mode`, `visibility`, and reason
- all input `refs`
- `summary`, `token_budget`, `tokens_used`, `visibility`, `created_at`

## Expansion Modes

- `summary`: include only the record summary.
- `structured`: include metadata and evidence refs.
- `full`: include full body when visibility and budget allow it.
- `adaptive`: try full body, then downgrade to summary, then exclude if budget still fails.
- `on_demand`: exclude from the initial bundle and explain that it can be fetched later.
- `on_failure`: exclude from the initial bundle and reserve it for recovery/debug context.

## Downgrades

The compiler can exclude or downgrade records for:

- visibility mismatch
- token budget pressure
- deferred expansion mode
- unsupported future ref storage

Preview output mirrors the bundle and adds explanations so UI, Agent Session, Handoff, and Memory callers can show why a record entered context or stayed out.
```

- [x] **Step 2: Update README doc map**

Add a row for M3 Context Compiler:

```md
| 07 | [v2 Context Compiler](07-v2-context-compiler.md) | 定义 M3 的 Context Bundle、ref 展开模式、预算降级和预览解释。 |
```

- [x] **Step 3: Mark this plan complete**

Mark all executed checkboxes in this file as complete.

- [x] **Step 4: Run focused regression and typecheck**

Run from `packages/opencode`:

```bash
bun test test/harness/context-compiler.test.ts test/harness/agent-assignment.test.ts test/harness/resource-fabric.test.ts test/harness/action-graph.test.ts test/harness/runtime.test.ts test/harness/object-model.test.ts
bun typecheck
```

Expected: all listed tests pass and typecheck exits 0.

- [x] **Step 5: Commit M3**

From the M3 worktree root:

```bash
git status --short
git add packages/opencode/src/harness/schema.ts packages/opencode/src/harness/store.ts packages/opencode/src/harness/runtime.ts packages/opencode/test/harness/context-compiler.test.ts docs/harness-platform-prd-v2/README.md docs/harness-platform-prd-v2/07-v2-context-compiler.md docs/superpowers/plans/2026-06-05-v2-m3-context-compiler.md
git commit -m "feat: add v2 context compiler"
```
