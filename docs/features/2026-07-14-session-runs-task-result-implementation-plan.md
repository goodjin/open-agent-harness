# Session Runs Task Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Runs 页面按 DSL 任务包和子会话委派任务展示完整任务内容，并把父会话模型综合结果、子会话 ActionResult 或 fallback summary 作为 `run.summary` 持久化展示。

**Architecture:** 保留 `session_protocol_run` 作为父会话 DSL Run 的执行记录，新增同路径域下的轻量 outcome sidecar 保存父模型终态结果；子会话委派 Run 从 `SessionAssignment` 与 canonical `SessionResult` 投影，不复制完整 payload。`SessionRuns` 统一生成 API read model，区分最终结果与执行摘要，UI 只消费该 read model。

**Tech Stack:** Bun、TypeScript、Zod、Hono/OpenAPI、SolidJS、Agent Protocol DSL、SessionResult、workspace JavaScript SDK。

---

## 文件职责

- `packages/opencode/src/session/runs.ts`：Run API schema、父 Run outcome 存取、父/子 Run 聚合、任务文本和历史结果兼容。
- `packages/opencode/src/session/runner.ts`：识别可展示 Run、关联上一 Run、在终态协议输出后写入父 Run 结果。
- `packages/opencode/config/protocol/planner-protocol.md`：要求模型先给出上一 Run 的综合结果，再终止或继续分派。
- `packages/opencode/test/session/runs.test.ts`：Run read model、outcome、委派结果和安全关联测试。
- `packages/opencode/test/session/runner.test.ts`：Run 创建边界、普通终态、fan-in 和继续分派测试。
- `packages/opencode/test/server/session-runs.test.ts`：路由和 OpenAPI contract 测试。
- `packages/app/src/pages/session/session-runs-data.ts`：结果展示状态和现有列表 helper。
- `packages/app/src/pages/session/session-runs.tsx`：任务内容、Markdown 结果、子任务、文档和执行信息布局。
- `packages/app/src/pages/session/session-runs.test.ts`：前端结果状态 helper 测试。
- `packages/app/src/i18n/zh.ts`、`packages/app/src/i18n/en.ts`：Runs 新语义文案。
- `docs/harness-module/delegation-results.md`、`docs/harness-module/ui-console.md`：实现后的模块契约。

## Task 1: 建立 Run read model 与父结果存储

**Files:**
- Modify: `packages/opencode/src/session/runs.ts`
- Test: `packages/opencode/test/session/runs.test.ts`

- [ ] **Step 1: 为父 Run 的任务、结果和执行摘要编写失败测试**

在 `runs.test.ts` 增加以下行为：旧 `AgentProtocol.Result.summary` 映射到 `execution_summary`，没有 outcome 时 `summary` 缺失；写入 outcome 后，列表和详情都返回模型结果。再构造 storage 中仍为 blocked、`dsl_context.protocol.runs` 已完成的 delegation Run，断言 API 使用最新投影状态和 actions。

```ts
const before = await SessionRuns.list(session.id)
expect(before[0]).toMatchObject({
  kind: "protocol",
  task: expect.stringContaining("Implement backend"),
  execution_summary: "Completed",
})
expect(before[0]?.summary).toBeUndefined()

await SessionRuns.finish({
  sessionID: session.id,
  runID: run.run_id,
  summary: "# Final result\n\nBackend work is complete.",
  messageID: MessageID.ascending(),
})

const after = await SessionRuns.get(session.id, run.run_id)
expect(after?.summary).toBe("# Final result\n\nBackend work is complete.")
expect(after?.summary_source).toBe("protocol")
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `cd packages/opencode && bun test test/session/runs.test.ts`

Expected: FAIL，缺少 `task`、`execution_summary`、`summary_source` 或 `SessionRuns.finish`。

- [ ] **Step 3: 定义最小 Run API schema 和 outcome sidecar**

在 `runs.ts` 中让 API schema 脱离执行器 `summary` 语义：

```ts
const Source = z.enum(["protocol", "action_result", "fallback_summary"])

const Outcome = z.object({
  run_id: z.string(),
  summary: z.string().trim().min(1),
  message_id: z.string(),
  completed_at: z.number().nonnegative(),
})

export const Run = AgentProtocol.Result.omit({ status: true, summary: true })
  .extend({
    kind: z.enum(["protocol", "delegation"]),
    status: z.enum(["running", "completed", "blocked", "failed"]),
    task: z.string(),
    summary: z.string().optional(),
    summary_source: Source.optional(),
    execution_summary: z.string().optional(),
    action_id: z.string().optional(),
    fallback: z.boolean().default(false),
    documents: z.array(Document).default([]),
  })
  .strict()
```

`finish()` 只接受当前 session 下已存在的协议 Run，将规范化结果写入 `session_protocol_run_outcome/<session>/<run>`。重复写入同一 message 的结果保持幂等；不同 message 只允许更新尚未记录结果的 Run，避免迟到回复覆盖已确认结果。

- [ ] **Step 4: 归一化父 Run 任务并合并最新状态投影**

新增内部 `protocol()` 映射：

```ts
function task(run: AgentProtocol.Result) {
  return [
    run.title,
    ...run.actions.map((item) => {
      const input = item.input?.prompt ?? item.input?.task ?? item.input?.request
      const body = typeof input === "string" ? input : item.input ? JSON.stringify(item.input, null, 2) : ""
      return [`## ${item.title}`, body].filter(Boolean).join("\n\n")
    }),
  ]
    .filter((item): item is string => Boolean(item))
    .join("\n\n")
}
```

持久化 Run 和 `dsl_context.protocol.runs` 投影都经过同一 mapper。把现有只接受 `status: "running"` 的 Active parser 改成接受 running、completed、blocked、failed 的 Projection parser；同 runID 的 projection 覆盖 storage 中的状态和 actions，但保留 storage 的 metrics、执行摘要和 outcome。运行中不再填充 `summary: ""`；旧执行器摘要只进入 `execution_summary`。

- [ ] **Step 5: 为历史父 Run 增加同会话只读回退**

先写测试：不创建 outcome sidecar，只创建带 `metadata.turn.run_id` 或 internal `metadata.run_id` 的 user message，以及其 `assistant_id`/`parentID` 对应的 `protocol_response` text part，断言 API 恢复该 Run 的 summary。

实现 `legacy(sessionID, runID)`：只扫描当前 session 的 MessageV2 stream；匹配 `SessionTurn.get(user)?.run_id` 或受信 internal delegation metadata 的 run_id；只读取关联 assistant 的 `metadata.kind === "protocol_response"` 或已接受 plain final part。历史回退不写 sidecar，不读取有保留期限的 Session Log，也不接受普通用户 metadata 伪造的 run_id。

- [ ] **Step 6: 运行聚焦测试**

Run: `cd packages/opencode && bun test test/session/runs.test.ts`

Expected: PASS，父 Run 的 task、outcome、execution summary、最新 projection、历史回退和 list/get 一致。

- [ ] **Step 7: 提交父 Run read model**

```bash
git add packages/opencode/src/session/runs.ts packages/opencode/test/session/runs.test.ts
git commit -m "feat(session): model run task outcomes"
```

## Task 2: 投影子会话委派 Run

**Files:**
- Modify: `packages/opencode/src/session/runs.ts`
- Test: `packages/opencode/test/session/runs.test.ts`

- [ ] **Step 1: 编写 ActionResult、fallback 和安全关联失败测试**

使用 `SessionAssignment.delegate()` 创建 child assignment，使用 `SessionResult.put()` 写 canonical 结果。覆盖以下断言：

```ts
const runs = await SessionRuns.list(child.id)
expect(runs).toHaveLength(1)
expect(runs[0]).toMatchObject({
  kind: "delegation",
  run_id: parentRun,
  action_id: "backend",
  task: expect.stringContaining("Implement backend"),
  summary: "Backend implementation completed.",
  summary_source: "action_result",
  fallback: false,
  actions: [],
})
```

再写 fallback case，断言 `parsed.output` 优先于 canonical summary；构造跨 child、parent、run、action 的伪造 `result_id`，断言结果内容不泄漏且 `summary` 保持缺失。

- [ ] **Step 2: 运行测试并确认失败**

Run: `cd packages/opencode && bun test test/session/runs.test.ts`

Expected: FAIL，当前 API 不生成 delegation Run。

- [ ] **Step 3: 读取并校验委派任务**

在 `runs.ts` 增加 `delegation(session)`：

- 校验 `dsl_context.protocol.delegation.type === "agent.delegation.assignment"`。
- 校验 `child_session_id === session.id`、`parent_session_id === session.parentID`。
- 用 `SessionAssignment.bySource({ sessionID: parent, runID, actionID })` 查找 assignment。
- 再校验 assignment 的 `session_id`、`source_session_id`、`source_run_id`、`source_action_id`。
- 从 `SessionAssignment.content(id)` 的 `plan` 读取完整 task；关联失败时只回退 `action_title`。

- [ ] **Step 4: 按 carrier 生成最终 summary**

只通过 canonical `SessionResult.parse()` 读取 payload，并验证 parent、child、run、action 四元组：

```ts
function summary(result: SessionResult.Parsed) {
  if (result.carrier === "action_result") {
    const value = result.action_result?.result
    return typeof value === "string" ? value : undefined
  }
  if (result.carrier === "fallback_summary") return result.output ?? result.summary
  if (result.carrier === "agent_protocol_output") {
    const value = result.protocol_result
    return text(value?.message) ?? text(value?.summary) ?? result.output ?? result.summary
  }
  return result.output ?? result.summary
}
```

委派 Run 复用父 `run_id`，`actions` 为空，`metrics` 为零；没有 canonical 结果时状态为 `running`。本地 protocol Runs 与 delegation Run 同时列出，不能把整体 ActionResult 复制给内部 Run。

- [ ] **Step 5: 运行完整 SessionRuns 测试**

Run: `cd packages/opencode && bun test test/session/runs.test.ts`

Expected: PASS，ActionResult、fallback、protocol child、pending、伪造关联和内外 Run 共存均通过。

- [ ] **Step 6: 提交委派投影**

```bash
git add packages/opencode/src/session/runs.ts packages/opencode/test/session/runs.test.ts
git commit -m "feat(session): project delegated runs"
```

## Task 3: 修正 Runtime 的 Run 创建边界

**Files:**
- Modify: `packages/opencode/src/session/runner.ts`
- Test: `packages/opencode/test/session/runner.test.ts`

- [ ] **Step 1: 为 input-only、confirm-only 和混合确认包编写失败测试**

扩展现有 confirm-only 和 input 测试，直接检查持久化键：

```ts
expect(await Storage.list(["session_protocol_run", session.id])).toHaveLength(0)
```

混合 `confirm + agent` package 在确认前应为 0；批准并开始首个非 human action 后应为 1。普通多 action DSL package 仍只生成一个 Run。

- [ ] **Step 2: 运行目标 runner 测试并确认失败**

Run: `cd packages/opencode && bun test test/session/runner.test.ts --test-name-pattern "confirm-only|input|package-level confirmation"`

Expected: FAIL，当前 `pending()` 和 `project()` 会保存纯 human Run。

- [ ] **Step 3: 只在实际任务开始时创建 Run 投影**

在 `execute()` 中使用单词命名的 helper：

```ts
function tracked(actions: AgentProtocol.Action[]) {
  return actions.some((item) => item.executor.type !== "human")
}
```

把 `pending()` 从 executor 启动前移到第一个非 human action 的 callback 中，并用局部 `started` 保证只调用一次。让 `execute()` 返回 `{ run, tracked: started }`；`settle()` 仅在 `tracked` 为 true 时调用 `project()`。纯 input、纯 confirm 和取消确认仍可使用内部 runID 完成交互，但不进入 Session Runs。

- [ ] **Step 4: 运行创建边界测试**

Run: `cd packages/opencode && bun test test/session/runner.test.ts --test-name-pattern "confirm-only|input|package-level confirmation|executes native"`

Expected: PASS，澄清和批准流程不产生空 Run，实际任务开始后只产生一个 Run。

- [ ] **Step 5: 提交创建边界修复**

```bash
git add packages/opencode/src/session/runner.ts packages/opencode/test/session/runner.test.ts
git commit -m "fix(protocol): create runs for executable work"
```

## Task 4: 保存父会话模型综合结果

**Files:**
- Modify: `packages/opencode/src/session/runner.ts`
- Modify: `packages/opencode/config/protocol/planner-protocol.md`
- Generated: `packages/opencode/src/agent/builtin.generated.ts`
- Test: `packages/opencode/test/session/runner.test.ts`

- [ ] **Step 1: 编写普通终态、fan-in 和继续分派失败测试**

使用 runner 现有 provider fixture 分别返回：

```ts
{ version: "2", items: [{ id: "done", kind: "success", message: "Run one completed." }] }
```

以及带上一 Run 结果的新执行包：

```ts
{
  version: "2",
  items: [
    { id: "prior", kind: "success", message: "Research completed." },
    { id: "next", kind: "agent", target: "backend", prompt: "Implement the reviewed design." },
  ],
}
```

断言普通完成写入当前 Run；delegation synthetic user 的 `metadata.run_id` 写回旧 Run；继续分派先完成旧 Run，再创建 summary 为空的新 Run。再覆盖 plain Markdown fallback 和“缺少上一 Run 结果却继续分派”的一次 repair。

- [ ] **Step 2: 运行目标测试并确认失败**

Run: `cd packages/opencode && bun test test/session/runner.test.ts --test-name-pattern "protocol final|delegation.*fan|run result"`

Expected: FAIL，当前终态输出没有回写 `session_protocol_run_outcome`。

- [ ] **Step 3: 识别 delegation fan-in 的上一 Run**

只接受 Runtime 写入的 internal metadata，避免用户文本伪造：

```ts
function prior(user: MessageV2.User) {
  const meta = object(user.metadata)
  if (meta.internal !== true || meta.source !== "delegation") return
  return text(meta.run_id)
}
```

常规 `protocol()` 解析 DSL 后，如果存在 `prior(stream.user)`，先处理上一 Run 的结果，再进入 respond 或 execute 分支。

- [ ] **Step 4: 在 `final()` 和 fan-in 路径写 outcome**

复用 canonical `declaration.message`，它已按 `message -> answer -> text` 并拼接 terminal summary 和 changed files。写入前要求非空：

```ts
async function finish(input: {
  sessionID: SessionID
  runID: string
  parsed: AgentProtocolParser.Parsed
  messageID: MessageID
}) {
  const summary = input.parsed.declaration.message?.trim()
  if (!summary) return false
  return SessionRuns.finish({
    sessionID: input.sessionID,
    runID: input.runID,
    summary,
    messageID: input.messageID,
  })
}
```

`final()` 的 terminal-only 分支写完 outcome 再调用 `response()`；terminal + actions 分支先写旧 Run，再执行新 package。plain fallback 使用最终 Markdown 写 outcome，`summary_source` 仍为 `protocol`。

- [ ] **Step 5: 缺少上一 Run 结果时进入协议修复**

当存在待收口 Run、下一包仍有 executable actions、但没有 terminal message 时，不执行新 actions。复用现有一次重试结构，提示：

```text
Your previous Run has finished execution but the new package omitted its terminal result.
Include one success, failure, error, or reply item whose message or summary describes the completed Run.
If more work remains, put the new executable items after that terminal item; they will form the next Run.
```

第二次仍缺失时保留旧 Run 的 actions 和 `execution_summary`，不伪造 `summary`，并以 protocol malformed 结束当前回复。

- [ ] **Step 6: 更新 planner protocol 并生成内置 Agent**

在 `planner-protocol.md` 的 terminal item 规则后补充同样约束：有待收口 Run 时，下一包先提供 terminal result；空 `done` 只适用于没有待收口 Run 的对话。

Run: `cd packages/opencode && bun run build:agents`

Expected: `packages/opencode/src/agent/builtin.generated.ts` 只出现对应协议提示变更。

- [ ] **Step 7: 运行 runner 回归测试**

Run: `cd packages/opencode && bun test test/session/runner.test.ts test/session/delegation.test.ts`

Expected: PASS，普通完成、fan-in、继续分派、plain fallback 和缺结果 repair 均通过。

- [ ] **Step 8: 提交父结果链路**

```bash
git add packages/opencode/src/session/runner.ts packages/opencode/config/protocol/planner-protocol.md packages/opencode/src/agent/builtin.generated.ts packages/opencode/test/session/runner.test.ts
git commit -m "feat(protocol): persist model run results"
```

## Task 5: 更新 API、SDK 与 Runs 界面

**Files:**
- Modify: `packages/opencode/test/server/session-runs.test.ts`
- Generated: `packages/sdk/openapi.json`
- Generated: `packages/sdk/js/src/v2/gen/`
- Modify: `packages/app/src/pages/session/session-runs-data.ts`
- Modify: `packages/app/src/pages/session/session-runs.tsx`
- Modify: `packages/app/src/pages/session/session-runs.test.ts`
- Modify: `packages/app/src/i18n/zh.ts`
- Modify: `packages/app/src/i18n/en.ts`

- [ ] **Step 1: 编写 API contract 和前端结果状态失败测试**

路由测试断言 `task`、可选 `summary`、`summary_source`、`execution_summary` 和 `kind`。前端 helper 定义四态：

```ts
expect(outcome({ status: "running" } as never)).toBe("running")
expect(outcome({ status: "completed", summary: "Done", summary_source: "protocol" } as never)).toBe("recorded")
expect(outcome({ status: "failed", summary: "Partial", summary_source: "fallback_summary" } as never)).toBe("fallback")
expect(outcome({ status: "completed" } as never)).toBe("missing")
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `cd packages/opencode && bun test test/server/session-runs.test.ts`

Run: `cd packages/app && bun test:unit -- src/pages/session/session-runs.test.ts`

Expected: FAIL，SDK 和 helper 尚无新字段。

- [ ] **Step 3: 生成 OpenAPI 与 JavaScript SDK**

Run: `./packages/sdk/js/script/build.ts`

Expected: OpenAPI Run schema 和 SDK `SessionRunsResponse` 包含新字段；不手工编辑 generated types。

- [ ] **Step 4: 实现结果状态 helper 和新详情布局**

在 `session-runs-data.ts` 增加：

```ts
export const outcome = (run: Run) => {
  if (run.status === "running") return "running" as const
  if (run.summary_source === "fallback_summary") return "fallback" as const
  if (run.summary) return "recorded" as const
  return "missing" as const
}
```

`session-runs.tsx` 的详情顺序固定为：

1. 任务内容：`<Markdown text={run().task} />`
2. 运行结果：有 summary 时用 Markdown；fallback 显示来源提示；running 不显示结果卡；终态缺失显示“未记录最终结果”。
3. 子任务：保留现有 action cards。
4. 文档：保留现有安全读取和分组。
5. 执行信息：时间、进度、metrics 和 `execution_summary`。

左侧把“协议运行”改为“任务”，增加 recorded、fallback、missing 的短标识。委派 Run 没有 actions 时仍展示任务和结果，不显示空的子任务容器。

- [ ] **Step 5: 更新中英文文案**

新增或调整以下 key：`task`、`result`、`execution`、`recorded`、`fallback`、`missingResult`、`started`、`completed`、`progress`；`count` 和 `empty` 不再使用 protocol run 语义。

- [ ] **Step 6: 运行 API、UI 和类型测试**

Run: `cd packages/opencode && bun test test/server/session-runs.test.ts && bun typecheck`

Run: `cd packages/app && bun test:unit -- src/pages/session/session-runs.test.ts && bun typecheck`

Expected: PASS，无 OpenAPI、SDK 或 Solid 类型错误。

- [ ] **Step 7: 提交 API 和界面**

```bash
git add packages/opencode/test/server/session-runs.test.ts packages/sdk packages/app/src/pages/session/session-runs-data.ts packages/app/src/pages/session/session-runs.tsx packages/app/src/pages/session/session-runs.test.ts packages/app/src/i18n/zh.ts packages/app/src/i18n/en.ts
git commit -m "feat(app): show run tasks and results"
```

## Task 6: 模块文档与完整验证

**Files:**
- Modify: `docs/harness-module/delegation-results.md`
- Modify: `docs/harness-module/ui-console.md`
- Modify: `docs/features/2026-07-14-session-runs-task-result-semantics.md` only if implementation resolves a documented conditional differently

- [ ] **Step 1: 更新模块契约**

在 delegation 模块记录：子会话委派 Run 从 SessionAssignment 与 canonical SessionResult 投影；ActionResult 只展示 `result`，fallback 保留来源且不代表验证通过。

在 UI Console 模块记录：Run 由可执行 DSL 包或子会话委派创建；结果与执行摘要分离；详情顺序和缺失结果行为固定。

- [ ] **Step 2: 运行后端聚焦测试**

Run: `cd packages/opencode && bun test test/session/runs.test.ts test/server/session-runs.test.ts test/session/runner.test.ts test/session/delegation.test.ts`

Expected: PASS。

- [ ] **Step 3: 运行 package-local 类型检查**

Run: `cd packages/opencode && bun typecheck`

Run: `cd packages/app && bun typecheck`

Expected: PASS。

- [ ] **Step 4: 运行前端 smoke**

Run: `cd packages/app && bun test:e2e:local -- app/smoke.spec.ts`

Expected: PASS，Vite 编译、应用启动和项目会话渲染正常。

- [ ] **Step 5: 检查生成物与 diff**

Run: `cd packages/opencode && bun run check:sdk`

Run: `git diff --check`

Run: `git status --short`

Expected: SDK 一致，diff 无空白错误，只包含本功能文件。

- [ ] **Step 6: 请求代码审查并修正重要问题**

按 `superpowers:requesting-code-review` 检查：Run 创建边界、outcome 幂等、fan-in 关联、跨会话结果泄漏、fallback 标识、历史兼容和 UI 缺失结果行为。修正 blocking 或 material findings 后重跑相关测试。

- [ ] **Step 7: 提交文档和审查修正**

```bash
git add docs/harness-module docs/features/2026-07-14-session-runs-task-result-semantics.md
git commit -m "docs(harness): document run result behavior"
```

- [ ] **Step 8: 推送完成的 feature**

Run: `git push origin dev`

Expected: `origin/dev` 包含全部实现、测试和模块文档提交。
