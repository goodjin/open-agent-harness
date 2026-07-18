# Session Single Task And Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个会话只执行一个用户可见 Task，支持同任务版本修订、旧版本归档、平级会话 Handoff，以及会话主区域中的任务内容、进度和结果展示。

**Architecture:** 新增 SQLite-backed `SessionTask` 领域层，使用一个稳定 Task 和多个 Revision 承载现有 Run/action/SessionResult 执行数据。Planner 继续复用 `confirm.assignment`，扩展 `handoff` 操作；Runtime 在可执行 DSL 边界绑定、更新或拒绝任务，通过现有 Session Tree 控制和 outbox 完成旧子会话收口与平级会话创建。新 Task API 和 UI 取代 Runs 的主入口，旧 Runs API 留作兼容读取。

**Tech Stack:** Bun、TypeScript、Zod、Drizzle SQLite、Hono/OpenAPI、SolidJS、生成式 JavaScript SDK、现有 Agent Protocol Runtime。

**Design source:** `docs/features/2026-07-17-session-single-task-and-handoff-design.md`

---

## 文件与职责

### Runtime 与存储

- `packages/opencode/src/session/session.sql.ts`：Task、Revision、Handoff 表和索引。
- `packages/opencode/migration/20260717090000_session_task/migration.sql`：数据库迁移。
- `packages/opencode/src/session/task.ts`：Task/Revision schema、事务、状态转换和读取接口。
- `packages/opencode/src/session/task-documents.ts`：`.harness` Markdown 投影与安全读取。
- `packages/opencode/src/session/task-handoff.ts`：Handoff 幂等创建、平级 Session 和 outbox 启动。
- `packages/opencode/src/session/task-recovery.ts`：修订中与 Handoff creating 状态的恢复。
- `packages/opencode/src/session/runner.ts`：可执行包的 Task 归属校验、首次绑定、继续执行和任务结果收口。
- `packages/opencode/src/session/delegation.ts`：父 action 创建子会话 Task、修订时停止子会话和结果收集。
- `packages/opencode/src/tool/task-inspect.ts`：给 planner 查询当前 Task、Revision、子会话与可复用结果。
- `packages/opencode/src/tool/session-control.ts`：把停止能力限制在当前 Task Revision 的子会话集合内。
- `packages/opencode/src/tool/registry.ts`：注册任务查询与会话控制工具。
- `packages/opencode/src/session/runs.ts`：旧 Run 到 Task 的兼容投影，不再扩展为新主模型。
- `packages/opencode/src/protocol/schema.ts`：`assignment.op=handoff`、`target=peer` 和规范化。
- `packages/opencode/config/protocol/planner-protocol.md`：单任务判断、更新和 Handoff 规则。
- `packages/opencode/config/agents/default/meta.json` 及其他 planner metadata：当前任务判断和受控流程提醒。

### API、SDK 与 UI

- `packages/opencode/src/server/routes/session.ts`：Task 当前页、历史、Revision、确认接口。
- `packages/sdk/openapi.json`、`packages/sdk/js/src/v2/gen/`：生成的 Task API 类型与客户端。
- `packages/app/src/pages/session/session-task.tsx`：当前 Task 主视图。
- `packages/app/src/pages/session/session-task-data.ts`：状态、进度、结果和历史 view model。
- `packages/app/src/pages/session/session-task-proposal.tsx`：Task Update 与 Handoff 卡片。
- `packages/app/src/pages/session/session-task.test.ts`：Task UI 纯逻辑和组件状态测试。
- `packages/app/src/pages/session.tsx`：顶部 Task 入口和主区域切换。
- `packages/app/src/pages/session/message-timeline.tsx`：结构化提议卡片与 Handoff 跳转。
- `packages/app/src/i18n/en.ts`、`packages/app/src/i18n/zh.ts`：任务状态与交互文案。

---

## Task 1：建立 Task、Revision、Handoff 数据模型

**Files:**
- Modify: `packages/opencode/src/session/session.sql.ts`
- Create: `packages/opencode/migration/20260717090000_session_task/migration.sql`
- Create: `packages/opencode/src/session/task.ts`
- Create: `packages/opencode/test/session/task.test.ts`

- [ ] **Step 1：先写 Task 唯一性和 Revision 激活约束测试**

在 `packages/opencode/test/session/task.test.ts` 创建真实 SQLite 测试，覆盖同一 Session 只能创建一个 Task、版本号递增、最多一个 active Revision：

```ts
test("creates one task per session and advances one active revision", async () => {
  const session = await Session.create({})
  const first = await SessionTask.create({
    sessionID: session.id,
    title: "Build task view",
    body: "# Build task view\n",
    source: { type: "user", messageID: MessageID.ascending() },
  })
  expect(first.revision.version).toBe(1)
  await expect(
    SessionTask.create({
      sessionID: session.id,
      title: "Second task",
      body: "# Second task\n",
      source: { type: "user", messageID: MessageID.ascending() },
    }),
  ).rejects.toBeInstanceOf(SessionTask.Conflict)

  const draft = await SessionTask.draft({
    taskID: first.task.id,
    title: "Build the unified task view",
    body: "# Build task view\n\nUpdated scope.\n",
    reason: "User changed scope",
    messageID: MessageID.ascending(),
  })
  await SessionTask.activate({ taskID: first.task.id, revisionID: draft.id })
  expect((await SessionTask.get(session.id))?.revision.version).toBe(2)
  expect((await SessionTask.history(session.id)).map((item) => item.status)).toEqual(["archived"])
})
```

- [ ] **Step 2：运行测试并确认缺少领域模块**

Run: `cd packages/opencode && bun test test/session/task.test.ts`

Expected: FAIL，提示无法导入 `src/session/task`。

- [ ] **Step 3：增加 Drizzle 表和 SQL 迁移**

在 `session.sql.ts` 增加三个表。字段使用 snake_case；Task 的 `session_id`、Revision 的 `(task_id, version)` 和 Handoff 的 `dedupe_key` 建唯一索引：

```ts
type TaskStatus = "running" | "waiting_user" | "revising" | "blocked" | "completed" | "failed"
type TaskSource = "user" | "delegation" | "handoff" | "legacy"
type RevisionStatus = "draft" | "active" | "completed" | "failed" | "archived"
type HandoffStatus = "proposed" | "confirmed" | "creating" | "started" | "failed" | "cancelled"

export const SessionTaskTable = sqliteTable("session_task", {
  id: text().primaryKey(),
  session_id: text().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
  title: text().notNull(),
  status: text().$type<TaskStatus>().notNull(),
  current_revision_id: text(),
  source_type: text().$type<TaskSource>().notNull(),
  source_ref: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
  time_created: integer().notNull(),
  time_updated: integer().notNull(),
}, (table) => [uniqueIndex("session_task_session_unique_idx").on(table.session_id)])

export const TaskRevisionTable = sqliteTable("task_revision", {
  id: text().primaryKey(),
  task_id: text().notNull().references(() => SessionTaskTable.id, { onDelete: "cascade" }),
  version: integer().notNull(),
  previous_id: text(),
  status: text().$type<RevisionStatus>().notNull(),
  title: text().notNull(),
  body: text().notNull(),
  body_hash: text().notNull(),
  source_message_id: text().$type<MessageID>(),
  reason: text(),
  workflow: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
  result: text(),
  result_source: text(),
  time_created: integer().notNull(),
  time_activated: integer(),
  time_completed: integer(),
  time_archived: integer(),
  archive_reason: text(),
}, (table) => [
  uniqueIndex("task_revision_task_version_unique_idx").on(table.task_id, table.version),
  uniqueIndex("task_revision_one_active_idx").on(table.task_id).where(sql`${table.status} = 'active'`),
])

export const TaskHandoffTable = sqliteTable("task_handoff", {
  id: text().primaryKey(),
  source_session_id: text().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
  source_task_id: text().references(() => SessionTaskTable.id, { onDelete: "cascade" }),
  source_message_id: text().$type<MessageID>(),
  target_session_id: text().$type<SessionID>(),
  target_task_id: text(),
  title: text().notNull(),
  body: text().notNull(),
  body_hash: text().notNull(),
  context_refs: text({ mode: "json" }).$type<string[]>().notNull(),
  status: text().$type<HandoffStatus>().notNull(),
  dedupe_key: text().notNull(),
  error: text(),
  time_created: integer().notNull(),
  time_confirmed: integer(),
  time_completed: integer(),
}, (table) => [uniqueIndex("task_handoff_dedupe_unique_idx").on(table.dedupe_key)])
```

迁移 SQL 使用同名字段、外键和索引。运行 `bun drizzle-kit check` 验证 schema 与 migration 无漂移。

- [ ] **Step 4：实现最小 SessionTask 事务 API**

在 `task.ts` 导出严格 Zod schema、`Conflict`、`create()`、`get()`、`draft()`、`activate()`、`history()`。`activate()` 在一个 `Database.use()` 事务中归档旧版本、激活 draft 并更新当前指针：

```ts
export async function activate(input: { taskID: string; revisionID: string }) {
  const now = Date.now()
  return Database.use((tx) => {
    const task = tx.select().from(SessionTaskTable).where(eq(SessionTaskTable.id, input.taskID)).get()
    const next = tx.select().from(TaskRevisionTable).where(eq(TaskRevisionTable.id, input.revisionID)).get()
    if (!task || !next || next.task_id !== input.taskID || next.status !== "draft") throw new Conflict()
    if (task.current_revision_id)
      tx.update(TaskRevisionTable)
        .set({ status: "archived", time_archived: now, archive_reason: next.reason ?? "Task revised" })
        .where(eq(TaskRevisionTable.id, task.current_revision_id))
        .run()
    tx.update(TaskRevisionTable)
      .set({ status: "active", time_activated: now })
      .where(eq(TaskRevisionTable.id, next.id))
      .run()
    tx.update(SessionTaskTable)
      .set({ title: next.title, current_revision_id: next.id, status: "running", time_updated: now })
      .where(eq(SessionTaskTable.id, input.taskID))
      .run()
    return { ...next, status: "active" as const, time_activated: now }
  })
}
```

- [ ] **Step 5：运行聚焦测试和迁移检查**

Run: `cd packages/opencode && bun test test/session/task.test.ts && bun drizzle-kit check && bun typecheck`

Expected: PASS，Task 唯一性、版本切换和 schema migration 均通过。

- [ ] **Step 6：提交数据模型**

```bash
git add packages/opencode/src/session/session.sql.ts packages/opencode/src/session/task.ts packages/opencode/test/session/task.test.ts packages/opencode/migration/20260717090000_session_task
git commit -m "feat(session): persist one task per session"
```

## Task 2：实现 Task read model、结果和 Markdown 投影

**Files:**
- Create: `packages/opencode/src/session/task-documents.ts`
- Modify: `packages/opencode/src/session/task.ts`
- Modify: `packages/opencode/src/session/runs.ts`
- Modify: `packages/opencode/test/session/task.test.ts`
- Modify: `packages/opencode/test/session/runs.test.ts`

- [ ] **Step 1：写当前任务、历史按需加载和结果来源测试**

增加测试，断言 `SessionTask.current()` 只返回当前版本，`history()` 不返回正文，`revision()` 才返回历史正文；父任务结果来自模型综合，子任务结果继续来自 canonical SessionResult：

```ts
const current = await SessionTask.current(session.id)
expect(current?.body).toContain("Current task")
expect(current?.result).toBe("Final model synthesis")
expect(await SessionTask.history(session.id)).toEqual([
  expect.objectContaining({ version: 1, status: "archived", body: undefined }),
])
expect((await SessionTask.revision(session.id, 1))?.body).toContain("Original task")
```

- [ ] **Step 2：运行测试并确认 read model 尚未实现**

Run: `cd packages/opencode && bun test test/session/task.test.ts test/session/runs.test.ts`

Expected: FAIL，缺少 `current()`、历史摘要和文档投影。

- [ ] **Step 3：实现 Task view schema 与可信结果映射**

在 `task.ts` 定义公开读取结构：

```ts
export const View = z.object({
  id: z.string(),
  session_id: SessionID.zod,
  title: z.string(),
  version: z.number().int().positive(),
  status: z.enum(["running", "waiting_user", "revising", "blocked", "completed", "failed"]),
  body: z.string(),
  progress: z.object({ completed: z.number(), total: z.number() }),
  actions: z.array(AgentProtocol.ResultAction),
  result: z.string().optional(),
  result_source: z.enum(["protocol", "action_result", "fallback_summary"]).optional(),
  handoffs: z.array(HandoffSummary),
  time: z.object({ created: z.number(), updated: z.number(), completed: z.number().optional() }),
}).strict()
```

复用 `SessionRuns` 的安全结果读取：父会话使用当前内部执行记录的模型 outcome；委派子会话使用 `SessionResult` 的 ActionResult.result 或 fallback。不要从 Session Log 拼接 Task.result。

- [ ] **Step 4：实现 `.harness` 投影和安全历史读取**

`task-documents.ts` 使用数据库正文生成：

```text
.harness/sessions/<session-id>/tasks/<task-id>/manifest.md
.harness/sessions/<session-id>/tasks/<task-id>/revisions/v<version>/task.md
```

写入时使用临时文件加原子发布；读取时复用 `runs.ts` 的 path、realpath、inode 和 Markdown 检查。数据库 hash 与文件不一致时返回 `drifted: true`，不把文件正文写回数据库。

- [ ] **Step 5：加入旧 Run 兼容投影**

实现 `SessionTask.legacy(sessionID)`：零 Run 返回 undefined；一个 Run 映射为可迁移 Task v1；多个 Run 返回 `{ type: "legacy_multi_run", count }`，不自动合并。保留现有 `SessionRuns.list()` 行为供兼容 API 使用。

- [ ] **Step 6：验证 read model**

Run: `cd packages/opencode && bun test test/session/task.test.ts test/session/runs.test.ts && bun typecheck`

Expected: PASS，当前结果可信、历史正文按需读取、旧 Runs 无回归。

- [ ] **Step 7：提交 read model**

```bash
git add packages/opencode/src/session/task.ts packages/opencode/src/session/task-documents.ts packages/opencode/src/session/runs.ts packages/opencode/test/session/task.test.ts packages/opencode/test/session/runs.test.ts
git commit -m "feat(session): expose current task read model"
```

## Task 3：扩展协议 assignment 和 planner 规则

**Files:**
- Modify: `packages/opencode/src/protocol/schema.ts`
- Modify: `packages/opencode/config/protocol/planner-protocol.md`
- Modify: `packages/opencode/config/agents/default/meta.json`
- Modify: `packages/opencode/config/agents/milestone-planner/meta.json`
- Modify: `packages/opencode/config/agents/feature-planner/meta.json`
- Modify: `packages/opencode/src/agent/builtin.generated.ts`
- Modify: `packages/opencode/test/protocol/schema.test.ts`
- Modify: `packages/opencode/test/agent/loader.test.ts`

- [ ] **Step 1：写 assignment create/update/handoff 解析测试**

```ts
expect(AgentProtocol.parse({
  version: "2",
  items: [{
    id: "handoff",
    kind: "confirm",
    prompt: "Create a peer task session?",
    plan: "# New task\n",
    assignment: { op: "handoff", target: "peer" },
  }],
}).payload).toMatchObject({
  actions: [expect.objectContaining({ input: expect.objectContaining({ assignment: { op: "handoff", target: "peer" } }) })],
})
```

同时断言 `handoff/self`、`create/peer`、`update/peer` 被 schema 拒绝。

- [ ] **Step 2：运行 schema 测试确认失败**

Run: `cd packages/opencode && bun test test/protocol/schema.test.ts`

Expected: FAIL，`handoff` 不在 `V2Assignment.op` 中。

- [ ] **Step 3：扩展严格 assignment schema**

```ts
const V2Assignment = z
  .object({
    op: z.enum(["create", "update", "handoff"]),
    target: z.enum(["self", "peer"]).default("self"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.op === "handoff") !== (value.target === "peer"))
      ctx.addIssue({ code: "custom", message: "handoff requires target=peer" })
  })
```

保持 v1 canonical schema 不变，避免破坏旧客户端。

- [ ] **Step 4：更新 planner protocol 和三个入口 planner footer**

加入明确规则：普通对话无需任务判断；生成 executable actions 前读取 Current Session Task；无 Task 使用 create，同任务边界变化使用 update，新任务使用 handoff；归属不明使用 input；Handoff package 不包含来源会话 executable actions。

Footer 示例固定为：

```json
{
  "id": "confirm_handoff",
  "kind": "confirm",
  "prompt": "Create a peer session for this new task?",
    "plan": "# Refactor log queries\n\n## Goal\nSeparate query parsing from storage.\n\n## Acceptance\nExisting log filters pass and the new session reports verification evidence.",
  "assignment": { "op": "handoff", "target": "peer" }
}
```

- [ ] **Step 5：重新生成 agent manifest 并验证提示词**

Run: `cd packages/opencode && bun run build:agents && bun test test/protocol/schema.test.ts test/agent/loader.test.ts && bun typecheck`

Expected: PASS，generated manifest 只包含预期提示词差异。

- [ ] **Step 6：提交协议规则**

```bash
git add packages/opencode/src/protocol/schema.ts packages/opencode/config/protocol/planner-protocol.md packages/opencode/config/agents/default/meta.json packages/opencode/config/agents/milestone-planner/meta.json packages/opencode/config/agents/feature-planner/meta.json packages/opencode/src/agent/builtin.generated.ts packages/opencode/test/protocol/schema.test.ts packages/opencode/test/agent/loader.test.ts
git commit -m "feat(protocol): declare task update and handoff intent"
```

## Task 4：在 Runner 中绑定唯一 Task 并累积同版本 action

**Files:**
- Modify: `packages/opencode/src/session/runner.ts`
- Modify: `packages/opencode/src/session/system.ts`
- Modify: `packages/opencode/src/session/task.ts`
- Modify: `packages/opencode/test/session/runner.test.ts`

- [ ] **Step 1：写普通对话、首次绑定、继续执行和冲突测试**

覆盖四条路径：answer/input/confirm-only 不创建 Task；首次非 human action 创建 Task v1；同一当前版本后续 actions 追加到 Task workflow；第二次 `assignment.create` 返回 `session_task_conflict` 且不启动 action。

在 `runner.test.ts` 内增加局部 `runExecutablePackage()` helper：复用现有 `packet()` LLM stream fixture，传入 assignment 时生成一条 confirm action，不传时生成一条可执行 agent action；helper 返回 `SessionPrompt.prompt()` 的结果。这样下面的断言走真实 Runner/Protocol 路径，不直接调用 Task domain 伪造执行。

```ts
expect(await SessionTask.get(session.id)).toBeUndefined()
await runExecutablePackage(session.id, { assignment: { op: "create", target: "self" } })
expect((await SessionTask.get(session.id))?.revision.version).toBe(1)
await runExecutablePackage(session.id)
expect((await SessionTask.get(session.id))?.revision.workflow.actions).toHaveLength(2)
await expect(runExecutablePackage(session.id, { assignment: { op: "create", target: "self" } }))
  .rejects.toMatchObject({ code: "session_task_conflict" })
```

- [ ] **Step 2：运行 Runner 聚焦测试确认失败**

Run: `cd packages/opencode && bun test test/session/runner.test.ts --test-name-pattern "session task|task conflict|ordinary conversation"`

Expected: FAIL，Runner 尚未绑定 Task。

- [ ] **Step 3：在首个非 human action callback 中绑定 Task**

在现有“实际任务开始才创建 Run”的边界调用 `SessionTask.begin()`。任务正文优先使用已确认 assignment content；没有 assignment 的 delegated child 使用 delegation plan；兼容 package 使用 declaration title/actions 生成 Markdown。纯 human package 不调用。

父 action 创建 delegated child 时，在启动 child prompt 前调用 `SessionTask.beginDelegated()`：以 delegation plan 作为 Task 正文、`source="delegation"`、父 action ID 作为 source reference。测试断言子会话尚未产生本地 DSL package 时也已经拥有唯一 Task，重复恢复同一 action 不生成第二个 Task。

- [ ] **Step 4：增加执行归属 guard**

在 executor 启动前实现 `SessionTask.route()`；它只返回归属决策，既有 `execute()` 继续负责真正执行：

```ts
const task = await SessionTask.get(sessionID)
const op = SessionTask.assignment(declaration)
if (!task && op !== "handoff") {
  await SessionTask.begin({ sessionID, declaration, assignment })
  return { type: "execute" as const }
}
if (task && op === "create") throw new SessionTask.Conflict("session_task_conflict")
if (task && op === "handoff") return { type: "handoff" as const }
if (task && op === "update") {
  await SessionTask.prepareUpdate({
    sessionID,
    declaration,
    assignment,
  })
  return { type: "update" as const }
}
if (!task) throw new SessionTask.Conflict("task_handoff_requires_bound_source")
await SessionTask.append({ taskID: task.task.id, revisionID: task.revision.id, declaration })
return { type: "execute" as const }
```

Runner 对 `execute` 继续走现有 executor；`update` 只保存提议并等待确认；`handoff` 在 Task 6 接入 peer 创建，在此阶段不得启动来源会话 actions。

异常在 protocol repair prompt 中明确要求使用 update 或 handoff，不能自动把新任务当作当前 Task。

- [ ] **Step 5：把模型终态结果写入当前 Revision**

保留 `SessionRuns.finish()` 兼容写入，同时调用 `SessionTask.finish()`。父 Task 使用模型 terminal summary；子 Task 继续从 canonical SessionResult 投影。重复相同 message/summary 幂等，不同结果冲突。

- [ ] **Step 6：注入紧凑 Current Session Task 上下文**

在 system prompt 组装阶段调用 `SessionTask.context(sessionID)`。无 Task 时不增加内容；有 Task 时只注入 Task ID、当前版本、状态、标题和 create/update/handoff 规则。完整正文、历史和 action 详情仍通过 `task_inspect` 读取。测试断言普通对话也能看见紧凑上下文，但不会因此创建 Revision。

- [ ] **Step 7：运行 Runner、Runs 和类型检查**

Run: `cd packages/opencode && bun test test/session/runner.test.ts test/session/runs.test.ts test/session/task.test.ts && bun typecheck`

Expected: PASS，原 Runs 兼容测试不退化，新 Task 只有一个。

- [ ] **Step 8：提交 Runner 绑定**

```bash
git add packages/opencode/src/session/runner.ts packages/opencode/src/session/system.ts packages/opencode/src/session/task.ts packages/opencode/test/session/runner.test.ts
git commit -m "feat(session): bind executable work to one task"
```

## Task 5：实现 Task Update 的冻结、停止和恢复

**Files:**
- Create: `packages/opencode/src/session/task-recovery.ts`
- Create: `packages/opencode/src/tool/task-inspect.ts`
- Create: `packages/opencode/src/tool/session-control.ts`
- Modify: `packages/opencode/src/session/task.ts`
- Modify: `packages/opencode/src/session/delegation.ts`
- Modify: `packages/opencode/src/session/recovery.ts`
- Modify: `packages/opencode/src/tool/registry.ts`
- Modify: `packages/opencode/config/agents/default/meta.json`
- Modify: `packages/opencode/config/agents/milestone-planner/meta.json`
- Modify: `packages/opencode/config/agents/feature-planner/meta.json`
- Modify: `packages/opencode/src/agent/builtin.generated.ts`
- Modify: `packages/opencode/test/session/task.test.ts`
- Modify: `packages/opencode/test/session/delegation.test.ts`
- Modify: `packages/opencode/test/session/recovery.test.ts`
- Create: `packages/opencode/test/tool/task-inspect.test.ts`
- Create: `packages/opencode/test/tool/session-control.test.ts`
- Modify: `packages/opencode/test/tool/registry.test.ts`

- [ ] **Step 1：写 update 生命周期和中断恢复测试**

测试确认后 Task 为 revising、旧 child 全部收到停止、completed child 不重复停止、结果收口前 draft 不激活、重启后继续未完成步骤。

```ts
const draft = await SessionTask.confirmUpdate({ sessionID: parent.id, proposalID })
expect((await SessionTask.get(parent.id))?.task.status).toBe("revising")
await SessionTaskRecovery.resume(parent.id)
expect(SessionStatus.get(runningChild.id).type).toBe("aborted")
expect(SessionStatus.get(completedChild.id).type).toBe("completed")
expect((await SessionTask.get(parent.id))?.revision.id).toBe(draft.id)
```

- [ ] **Step 2：运行测试并确认缺少 update orchestrator**

Run: `cd packages/opencode && bun test test/session/task.test.ts test/session/delegation.test.ts test/session/recovery.test.ts --test-name-pattern "task update|revision recovery"`

Expected: FAIL。

- [ ] **Step 3：实现 prepare/confirm/freeze 状态转换**

`prepareUpdate()` 创建 draft；`confirmUpdate()` 校验当前 Revision 未变化后把 Task 设为 revising；`freeze()` 禁止旧 Revision 创建新 Assignment。所有写入携带 expected revision ID，避免迟到确认覆盖新版本。

同时写入 Runtime 保留的 `task_update_proposal` part metadata，包含 proposal/revision ID、版本差异摘要、受影响子会话 ID 和可复用结果引用。公开 prompt metadata 继续剥离该 kind，客户端不能伪造确认卡。

- [ ] **Step 4：复用 Session Tree 控制停止非终态 child**

从当前 Revision workflow/Assignment 查出 child IDs。对 queued、running、waiting_child、waiting_user、waiting_permission 和 recoverable interrupted 调用现有 abort/terminate；completed、failed、aborted、archived 跳过。结果读取顺序保持 ActionResult、existing fallback、transcript partial summary。

- [ ] **Step 5：实现 TaskRecovery 幂等状态机**

```ts
export async function resume(sessionID: SessionID) {
  const task = await SessionTask.get(sessionID)
  if (task?.task.status !== "revising") return false
  const pending = await SessionTask.pendingChildren(task.revision.id)
  if (pending.length) {
    await Promise.all(pending.map((id) => SessionTask.stop(id)))
    return true
  }
  await SessionTask.activateDraft(task.task.id)
  await SessionTask.startCurrent(task.task.id)
  return true
}
```

接入 `SessionRecovery` 启动扫描；任何阶段重复调用不重复停止、不重复激活、不重复启动。

- [ ] **Step 6：提供模型可调用的 Task 查询与子会话控制工具**

新增两个原生工具并注册到 `ToolRegistry`，避免和现有负责派发 agent 的 `task` 工具重名：

```ts
export const TaskInspectTool = Tool.define("task_inspect", {
  description: "Inspect the current session task, active revision, actions, child sessions, and reusable results.",
  parameters: z.object({
    include: z.enum(["summary", "workflow", "results"]).default("summary"),
  }),
  async execute(params, ctx) {
    const task = await SessionTask.inspect(ctx.sessionID, params.include)
    return {
      title: task ? `${task.task.title} · v${task.revision.version}` : "No task bound",
      output: JSON.stringify(task ?? { status: "unbound" }, null, 2),
      metadata: task ? { task_id: task.task.id, revision_id: task.revision.id } : {},
    }
  },
})
```

`session_control` 只接受 `list`、`stop`、`stop_all`。Runtime 从当前会话的 active/draft Revision 反查合法 child session IDs；`stop` 传入的 ID 只要不属于该集合就拒绝，不能控制任意会话、父会话或平级会话。`list` 返回状态、父 action、结果可复用性；`stop/stop_all` 复用 Step 4 的幂等停止逻辑，并返回逐会话结果。

```ts
const parameters = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
  z.object({ action: z.literal("stop"), session_ids: z.array(SessionID.zod).min(1) }),
  z.object({ action: z.literal("stop_all") }),
])
```

测试覆盖：无 Task 查询、summary 不加载历史正文、workflow/results 明确展开；只能查看/停止当前 Task Revision 的 child；终态 child 不重复停止；越权 ID 被拒绝；工具注册表可发现两个 ID。

在 default、milestone-planner、feature-planner 的 `runtime_boundary.actions.allow` 和 `allowed_tools` 中加入 `task_inspect`、`session_control`。这两个工具进入 Protocol tool catalog，planner 仍然只原生调用一次 `AgentProtocolOutput`：先在一个 package 中声明 `kind="tool"` 查询/停止 action，Runtime 执行后把结果交给下一次模型 turn，再由下一 package 生成修改提议或新 workflow，不能绕开 DSL 直接调用工具。

Prompt 说明：普通对话不必调用；判断 update 前优先声明 `task_inspect`，用当前状态和已完成结果形成待确认的 draft workflow；确认修订后先声明 `session_control.stop_all`，终止结果收口后作为新版本的只读上下文引用。若收口结果证明已确认方案存在实质性错误，保持 `revising/blocked` 并重新向用户提议，不静默扩大范围。若模型中断或输出不合法，`TaskRecovery` 仍按同一 scope 自动停止非终态 child，Runtime 状态机是最终约束，不能只依赖模型自觉。

- [ ] **Step 7：重新生成 agent manifest 并验证 update、恢复与工具权限**

Run: `cd packages/opencode && bun run build:agents && bun test test/session/task.test.ts test/session/delegation.test.ts test/session/recovery.test.ts test/tool/task-inspect.test.ts test/tool/session-control.test.ts test/tool/registry.test.ts test/agent/loader.test.ts && bun typecheck`

Expected: PASS，旧子会话收口后才激活新版本，崩溃点均可恢复，planner 只能控制当前 Task Revision 的 child sessions。

- [ ] **Step 8：提交修订状态机和受控工具**

```bash
git add packages/opencode/src/session/task.ts packages/opencode/src/session/task-recovery.ts packages/opencode/src/session/delegation.ts packages/opencode/src/session/recovery.ts packages/opencode/src/tool/task-inspect.ts packages/opencode/src/tool/session-control.ts packages/opencode/src/tool/registry.ts packages/opencode/config/agents/default/meta.json packages/opencode/config/agents/milestone-planner/meta.json packages/opencode/config/agents/feature-planner/meta.json packages/opencode/src/agent/builtin.generated.ts packages/opencode/test/session/task.test.ts packages/opencode/test/session/delegation.test.ts packages/opencode/test/session/recovery.test.ts packages/opencode/test/tool/task-inspect.test.ts packages/opencode/test/tool/session-control.test.ts packages/opencode/test/tool/registry.test.ts
git commit -m "feat(session): revise tasks after child shutdown"
```

## Task 6：实现平级 Session Handoff

**Files:**
- Create: `packages/opencode/src/session/task-handoff.ts`
- Modify: `packages/opencode/src/session/index.ts`
- Modify: `packages/opencode/src/session/session.sql.ts`
- Modify: `packages/opencode/src/session/delegation.ts`
- Modify: `packages/opencode/src/session/runner.ts`
- Modify: `packages/opencode/src/session/recovery.ts`
- Create: `packages/opencode/test/session/task-handoff.test.ts`
- Modify: `packages/opencode/test/session/delegation.test.ts`

- [ ] **Step 1：写平级关系、确认门槛和幂等测试**

```ts
const proposed = await SessionTaskHandoff.propose({ sourceID: child.id, messageID, title, body, contextRefs: [] })
expect(proposed.status).toBe("proposed")
expect(await Session.children(parent.id)).toHaveLength(1)
const first = await SessionTaskHandoff.confirm(proposed.id)
const replay = await SessionTaskHandoff.confirm(proposed.id)
expect(replay.target_session_id).toBe(first.target_session_id)
expect((await Session.get(first.target_session_id!)).parentID).toBe(child.parentID)
expect((await SessionTask.get(first.target_session_id!))?.task.id).toBe(first.target_task_id)
```

- [ ] **Step 2：运行测试确认失败**

Run: `cd packages/opencode && bun test test/session/task-handoff.test.ts`

Expected: FAIL，缺少 Handoff service。

- [ ] **Step 3：实现 proposed Handoff 与确认校验**

`propose()` 保存 title/body/hash/context refs 和稳定 dedupe key，不创建 Session。`confirm()` 只接受 proposed/failed，校验来源 Task 未被删除、确认消息属于来源 Session。

`propose()` 同时写入 Runtime 保留的 `task_handoff_proposal` part metadata；启动成功写 `task_handoff_started`，只包含 handoff ID、目标 Session、目标 Task 和状态。完整新任务正文只从 Handoff API 读取。

- [ ] **Step 4：事务创建平级 Session、Task 和 Revision v1**

复用 `Session.createNext()` 的 row 构造逻辑，增加接受外部 transaction 的内部 helper。目标 `parentID` 使用 source.parentID。Task source 记录 `{ type: "handoff", handoffID, sourceSessionID }`。

- [ ] **Step 5：扩展 outbox kind 并幂等启动目标会话**

把 `OutboxKind` 扩展为 `"parent_handoff" | "task_handoff"`。payload 保存 handoff ID、target session/task/revision；dedupe key 使用 `task_handoff:<handoff-id>`。delivery 调用 `SessionPrompt.enqueue()` 写入内部 bootstrap message，并启动目标 Task；成功后 handoff=started，失败保留 error。

- [ ] **Step 6：接入恢复扫描并验证**

Run: `cd packages/opencode && bun test test/session/task-handoff.test.ts test/session/recovery.test.ts test/session/delegation.test.ts && bun typecheck`

Expected: PASS，确认前零目标、确认后一个平级目标、重试不重复。

- [ ] **Step 7：提交 Handoff**

```bash
git add packages/opencode/src/session/task-handoff.ts packages/opencode/src/session/index.ts packages/opencode/src/session/session.sql.ts packages/opencode/src/session/delegation.ts packages/opencode/src/session/runner.ts packages/opencode/src/session/recovery.ts packages/opencode/test/session/task-handoff.test.ts packages/opencode/test/session/delegation.test.ts
git commit -m "feat(session): hand off new tasks to peer sessions"
```

## Task 7：增加 Task API、OpenAPI 和 SDK

**Files:**
- Modify: `packages/opencode/src/session/index.ts`
- Modify: `packages/opencode/src/server/routes/session.ts`
- Create: `packages/opencode/test/server/session-task.test.ts`
- Modify: `packages/sdk/openapi.json`
- Modify: `packages/sdk/js/src/v2/gen/`

- [ ] **Step 1：写 Task route 权限、历史按需和确认测试**

覆盖 GET current、GET history、GET revision、POST update confirm、POST handoff confirm；错误 session、错误 revision、跨会话 proposal 返回 404/403/409。

- [ ] **Step 2：运行 route 测试确认 404**

Run: `cd packages/opencode && bun test test/server/session-task.test.ts`

Expected: FAIL，Task routes 尚不存在。

- [ ] **Step 3：实现读取路由**

```ts
.get(
  "/:sessionID/task",
  describeRoute({
    summary: "Get the current session task",
    operationId: "session.task",
    responses: {
      200: { description: "Current task", content: { "application/json": { schema: resolver(SessionTask.View) } } },
      ...errors(400, 403, 404),
    },
  }),
  validator("param", z.object({ sessionID: SessionID.zod })),
  async (c) => {
    const id = c.req.valid("param").sessionID
    await Session.get(id)
    const task = await SessionTask.current(id)
    if (!task) return c.json({ message: "Task not found" }, 404)
    return c.json(task)
  },
)
.get(
  "/:sessionID/task/history",
  describeRoute({
    summary: "List archived task revisions",
    operationId: "session.task.history",
    responses: {
      200: { description: "Task history", content: { "application/json": { schema: resolver(SessionTask.History.array()) } } },
      ...errors(400, 403, 404),
    },
  }),
  validator("param", z.object({ sessionID: SessionID.zod })),
  async (c) => c.json(await SessionTask.history(c.req.valid("param").sessionID)),
)
```

历史摘要 schema 不含 body/workflow/result 正文；单 Revision route 返回完整只读快照。

- [ ] **Step 4：实现确认路由和关联校验**

Update confirm body 包含 proposal/revision ID 和 confirm/cancel；Handoff confirm route 包含 handoff ID 和 confirm/cancel。服务端从记录读取 source session，不信任客户端传入 target IDs。

- [ ] **Step 5：给 Session list/tree 增加轻量 Task summary**

扩展 Session/Tree response 的可选 `task` 字段，只包含 `id`、`title`、`version`、`status`、`completed_actions` 和 `total_actions`。列表查询通过一次批量 task lookup 组装，禁止对每个 Session 发单独查询。顶部按钮消费该摘要；完整 Markdown 仍只从 current Task route 加载。

- [ ] **Step 6：生成并检查 SDK**

Run: `./packages/sdk/js/script/build.ts`

Run: `cd packages/opencode && bun run check:sdk`

Expected: Task response、history summary、revision、update/handoff confirm 方法出现在 v2 SDK，生成后工作树只有预期文件变化。

- [ ] **Step 7：运行 API 测试和类型检查**

Run: `cd packages/opencode && bun test test/server/session-task.test.ts test/server/session-runs.test.ts && bun typecheck`

Expected: PASS，旧 Runs routes 仍可用。

- [ ] **Step 8：提交 API 与 SDK**

```bash
git add packages/opencode/src/session/index.ts packages/opencode/src/server/routes/session.ts packages/opencode/test/server/session-task.test.ts packages/sdk/openapi.json packages/sdk/js/src/v2/gen
git commit -m "feat(api): expose session task lifecycle"
```

## Task 8：用 Task 主视图替换 Runs 入口

**Files:**
- Create: `packages/app/src/pages/session/session-task-data.ts`
- Create: `packages/app/src/pages/session/session-task.tsx`
- Create: `packages/app/src/pages/session/session-task.test.ts`
- Modify: `packages/app/src/pages/session.tsx`
- Modify: `packages/app/src/i18n/en.ts`
- Modify: `packages/app/src/i18n/zh.ts`

- [ ] **Step 1：写 view model 测试**

覆盖尚未生成、running、revising、completed、blocked、failed；结果 recorded/fallback/missing；历史默认未加载：

```ts
expect(view(runningTask)).toMatchObject({ status: "running", showResult: false })
expect(view(completedTask)).toMatchObject({ status: "completed", result: "recorded" })
expect(view(fallbackTask)).toMatchObject({ result: "fallback" })
expect(initial().history).toEqual({ loaded: false, items: [] })
```

- [ ] **Step 2：运行前端单测确认失败**

Run: `cd packages/app && bun test:unit -- src/pages/session/session-task.test.ts`

Expected: FAIL，Task view model 不存在。

- [ ] **Step 3：实现 Task 页面数据加载**

`SessionTask` 首次挂载只调用 current endpoint。点击“查看历史”后才调用 history；点击版本后才调用 revision。sessionID 变化时清空所有 state，旧请求结果不得覆盖新会话。

- [ ] **Step 4：实现主区域布局**

页面固定顺序：标题/版本/状态、Markdown 任务正文、执行进度与 action 摘要、任务结果、相关 Handoff。历史使用按需 drawer/list；历史详情只读并提供“返回当前任务”。复用现有 `Markdown`、Button、状态 tone 和文档安全渲染。

- [ ] **Step 5：替换顶部 Runs tab**

把 `sessionView` 改为 `"timeline" | "logs" | "task"`；Runs 按钮替换为 Task，按钮旁显示轻量状态。Task view 打开在当前 session 主区域，composer 保持可用，不把任务完成态当作会话只读态。

- [ ] **Step 6：补齐中英文文案并验证**

Run: `cd packages/app && bun test:unit -- src/pages/session/session-task.test.ts && bun typecheck`

Expected: PASS；不再从主 UI 直接导入 `SessionRuns`，但兼容组件可暂时保留未删除。

- [ ] **Step 7：提交 Task 主视图**

```bash
git add packages/app/src/pages/session/session-task-data.ts packages/app/src/pages/session/session-task.tsx packages/app/src/pages/session/session-task.test.ts packages/app/src/pages/session.tsx packages/app/src/i18n/en.ts packages/app/src/i18n/zh.ts
git commit -m "feat(app): show one task per session"
```

## Task 9：实现 Task Update 与 Handoff 卡片

**Files:**
- Create: `packages/app/src/pages/session/session-task-proposal.tsx`
- Modify: `packages/app/src/pages/session/message-timeline.tsx`
- Modify: `packages/app/src/pages/session/session-task.test.ts`
- Modify: `packages/app/src/i18n/en.ts`
- Modify: `packages/app/src/i18n/zh.ts`

- [ ] **Step 1：写 proposal 卡片状态测试**

覆盖 update/handoff 的 proposed、confirming、revising/creating、started、failed、cancelled；确认按钮防双击；Handoff 成功显示目标链接。

- [ ] **Step 2：运行测试确认组件不存在**

Run: `cd packages/app && bun test:unit -- src/pages/session/session-task.test.ts`

Expected: FAIL。

- [ ] **Step 3：实现结构化 proposal 解析和卡片**

卡片只接受 Runtime 写入的保留 metadata/part kind，不能从用户 metadata 伪造。Update 展示任务 diff 摘要、受影响子会话、可复用成果和完整 Markdown；Handoff 展示新任务、归属原因和 context refs。

- [ ] **Step 4：接入确认、继续讨论、取消和重试**

确认调用 Task API；继续讨论只关闭当前卡片的确认态并聚焦 composer；取消持久化 cancelled。failed Handoff 的重试复用 handoff ID，不重新提交正文。

- [ ] **Step 5：接入 Timeline 和跳转**

Timeline 对 task_update_proposal、task_handoff_proposal、task_handoff_started 渲染专用卡片。目标跳转使用 `navigate(/<dir>/session/<target>)`，不修改来源 session 的 parent/child 树。

- [ ] **Step 6：运行 UI 测试、类型检查和 smoke**

Run: `cd packages/app && bun test:unit -- src/pages/session/session-task.test.ts && bun typecheck`

Run: `cd packages/app && bun test:e2e:local -- app/smoke.spec.ts`

Expected: PASS，session boot、timeline 和 Task tab 无 Vite overlay。

- [ ] **Step 7：提交交互卡片**

```bash
git add packages/app/src/pages/session/session-task-proposal.tsx packages/app/src/pages/session/message-timeline.tsx packages/app/src/pages/session/session-task.test.ts packages/app/src/i18n/en.ts packages/app/src/i18n/zh.ts
git commit -m "feat(app): confirm task updates and handoffs"
```

## Task 10：旧会话迁移、模块文档和整体验收

**Files:**
- Modify: `packages/opencode/src/session/task.ts`
- Modify: `packages/opencode/src/server/routes/session.ts`
- Modify: `packages/opencode/test/session/task.test.ts`
- Modify: `packages/opencode/test/server/session-task.test.ts`
- Modify: `docs/harness-module/delegation-results.md`
- Modify: `docs/harness-module/ui-console.md`
- Modify: `docs/features/2026-07-17-session-single-task-and-handoff-design.md` only if implementation reveals an approved semantic correction

- [ ] **Step 1：写零 Run、单 Run、多 Run 兼容测试**

零 Run 返回 404/unbound；单 Run 懒迁移创建 Task v1 且结果可信；多 Run 返回 legacy_multi_run，不自动创建 Task，直到用户确认 migration proposal。

- [ ] **Step 2：实现懒迁移与兼容响应**

单 Run 迁移使用稳定 dedupe key `legacy-task:<session-id>:<run-id>`。多 Run migration proposal 把旧 Runs 作为只读历史执行快照，不能恢复或写入当前 Revision action 图。

- [ ] **Step 3：更新模块文档**

`delegation-results.md` 记录子会话唯一 Task、ActionResult/fallback 结果和任务修订时的终止行为。`ui-console.md` 记录 Task tab、当前内容/进度/结果顺序、历史按需加载、proposal 卡和 Handoff 跳转。明确 Runs API 仍为兼容接口。

- [ ] **Step 4：运行后端完整聚焦验证**

Run: `cd packages/opencode && bun test test/session/task.test.ts test/session/task-handoff.test.ts test/session/runner.test.ts test/session/delegation.test.ts test/session/recovery.test.ts test/session/runs.test.ts test/server/session-task.test.ts test/server/session-runs.test.ts test/server/session-tree.test.ts test/tool/task-inspect.test.ts test/tool/session-control.test.ts test/tool/registry.test.ts test/agent/loader.test.ts`

Expected: PASS，无 flaky 重跑依赖。

- [ ] **Step 5：运行生成、类型和前端验证**

Run: `cd packages/opencode && bun run build:agents && bun run check:sdk && bun drizzle-kit check && bun typecheck`

Run: `cd packages/app && bun test:unit -- src/pages/session/session-task.test.ts && bun typecheck && bun test:e2e:local -- app/smoke.spec.ts`

Run: `git diff --check && git status --short`

Expected: 所有命令退出 0；generated agent/SDK 已同步；只有计划内文件变化。

- [ ] **Step 6：进行独立代码与设计一致性审查**

审查以下风险：Task 唯一并发、两个 active Revision、迟到子结果写入新版本、跨会话 proposal 伪造、Handoff 重复创建、peer parent_id、普通对话误绑定、历史正文默认加载、当前 result 来源、旧 Runs 兼容。

修正 blocking/material findings 后，重新运行受影响测试和 Step 4-5 的最终验证。

- [ ] **Step 7：提交文档与兼容收尾**

```bash
git add packages/opencode/src/session/task.ts packages/opencode/src/server/routes/session.ts packages/opencode/test/session/task.test.ts packages/opencode/test/server/session-task.test.ts docs/harness-module/delegation-results.md docs/harness-module/ui-console.md
git commit -m "docs(harness): document single-task sessions"
```

- [ ] **Step 8：合并并推送**

确认工作树干净、分支基于最新 `dev`，按项目工作流快进或合并到 `dev`，在合并后的 `dev` 重跑 Step 4-5 的关键验证，然后执行：

```bash
git push origin dev
```

Expected: 远端 `dev` 包含全部提交，本地 `dev...origin/dev` 为 `0 0`。

---

## Task 5 规格审查修订（2026-07-17）

本轮修订只覆盖已确认 Task update 的收口与恢复边界，不调整 prompt-runner 的既有 BASE 失败。

1. Runner 在 update assignment 持久化并完成当前提交副作用后，自动调度 `SessionTaskRecovery.resume(sessionID)`；取消确认不调度。恢复错误要把 Task 置为 `blocked` 并写入 progress metadata，不能依赖进程启动扫描。
2. `SessionDelegation.stop()` 以 `SessionTask.scope()` 返回的 canonical child session ID 为选择权威，逐个直接停止并收口；`pending_delegations` 只用于补充上下文和同步清理。重启后即使 pending DSL 为空，running child 仍生成 fallback/result 并允许激活。
3. stop 对终态 child 保留原状态与 reason：已有结果直接复用，缺结果只补 fallback；仅非终态 child 执行 cancel 并转为 `user_completed`。重复 stop 不新增结果或 summary。
4. bootstrap outbox 采用 `pending -> delivering -> delivered` 原子 claim。并发恢复只有 claim 者发 prompt；固定 message 已存在时恢复为 delivered；无 message 仅在 lease 过期后重领；delivered 不可再次 claim。
5. revising scope 只读取 `current_revision_id` 指向的旧 active workflow。draft workflow/assignment 不得扩大 list/stop 边界；激活后历史 revision 不再进入 scope。
6. proposal/progress metadata 的 `difference_summary` 从旧/草稿 title、body hash 与 action identity 变化计算；`reusable_result_refs` 使用持久化 `SessionResult.id`，`affected_child_ids` 单独保留。

验证采用真实 Runner、Task、Assignment、Delegation、SessionResult 与持久化 outbox；按 RED/GREEN 顺序覆盖在线触发、重启 direct stop、终态参数化、并发/崩溃恢复、旧 active scope 与 metadata 稳定引用。最终从 `packages/opencode` 运行 task、recovery、delegation、runner、tool 全量多轮、`bun typecheck` 与 build，并在仓库根运行 `git diff --check`。

收尾审计补充：在线恢复由提交后的异步 effect 启动，避免当前 Runner 等待同 Session bootstrap prompt；bootstrap 成功状态为 `delivered`，只写 `delivered_at`，不提前写 `acked_at`。direct stop 忽略可损坏的 pending/child DSL assignment 并从 canonical Assignment row 重建。外部 prompt part 会剥离 proposal/progress 的全部保留字段，而不只剥离 `kind`。

Critical 收口补充：stop、activate 或 bootstrap 任一步失败都由 `SessionTaskRecovery` 统一将 Task 置为 `blocked` 并写入幂等 progress error；启动扫描不得静默丢失该证据。已激活 Revision 的 bootstrap 可从 blocked 状态继续重试，成功投递后恢复为 `running`。`session_control` 的 stop/stop_all 仅在 `revising` 或 `blocked` 阶段开放，running/waiting_user 状态不能绕过 update confirm 停止 child。

## 实施顺序和并行边界

- Task 1-2 必须串行，先锁定数据库和 read model。
- Task 3 可在 Task 2 完成后并行准备，但合并前必须使用 Task 1 的最终类型。
- Task 4 依赖 Task 1-3。
- Task 5 和 Task 6 都依赖 Task 4；代码都触及 recovery/runner 时应使用独立顺序提交，避免并行编辑同一文件。
- Task 7 依赖 Task 2、5、6。
- Task 8 可在 Task 7 的 OpenAPI schema 固定后开始。
- Task 9 依赖 Task 6-8。
- Task 10 最后执行，不与功能实现并行。

## 完成条件

- 新会话只能拥有一个用户可见 Task。
- 任务绑定后普通对话不受影响。
- 同任务追加 action 不创建第二个 Task。
- 任务边界变化通过确认、子会话收口和 Revision 切换完成。
- 新任务只能通过确认后的 Handoff 进入平级会话。
- Task 页面默认只展示当前内容、进度和结果，历史按需只读。
- Task、Revision、Handoff、结果和恢复状态以 SQLite/SessionResult 为权威来源。
- 旧 Runs API 和旧会话在兼容期仍可读取。
- 后端聚焦测试、前端单测、两端 typecheck、migration check、SDK check、agent generation 和 app smoke 全部通过。
