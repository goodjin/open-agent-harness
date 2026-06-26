# Bug Fix: Session status DB authority and terminal reply semantics

## 问题描述

- 日期: 2026-06-26
- 严重程度: High
- 影响范围: delegated child session 状态、系统重启恢复、session tree UI、父子会话 handoff

`Protocol: h6_test_author (@general-executor)` 已调用 `ActionResult(status: "reply")`，但状态投影出现混乱:

- assistant/message 层先显示完成；
- delegation/result 层又把同一个 ActionResult 映射为 blocked；
- 重启后内存 `SessionStatus` 缺省为 idle，再被恢复/补偿流程写成 blocked；
- UI 容易把 terminal reply 误呈现为中断或异常阻塞。

这暴露出当前状态设计的问题: 当前状态主要存在内存和 `session_status/*.json` 缓存中，DB 只保存证据和历史，没有一个权威当前状态字段。

## 根因分析

- 问题位置:
  - `packages/opencode/src/session/status.ts`
  - `packages/opencode/src/session/prompt.ts`
  - `packages/opencode/src/session/delegation.ts`
  - `packages/opencode/src/session/result.ts`
  - `packages/opencode/src/project/bootstrap.ts`
  - `packages/opencode/src/session/session.sql.ts`
- 根因:
  1. `SessionStatus` 当前状态不在 `session` 表中，重启时依赖 `session_status` 文件和恢复逻辑。
  2. `SessionStatus.get()` 内存未命中时返回 `idle`，导致恢复补偿日志出现误导性的 `idle -> blocked`。
  3. prompt generic finish 会把 assistant message 完成投影成 session completed，和 delegated ActionResult 语义竞争。
  4. `ActionResult(status: "reply")` 被映射为 blocked，但 reply 更准确是 terminal non-satisfying handoff。
  5. `SessionResult.put()` 缺少 `(parent_session_id, child_session_id, run_id, action_id)` 唯一约束，异步路径可能写出重复结果。

## 目标状态模型

DB 中 `session` 表保存权威当前状态。状态不再只靠内存和 JSON 文件恢复。

第一阶段采用兼容枚举，不一次性删除旧 API:

### 大类

1. `active`: 当前可由 runtime 执行或调度。
2. `blocked`: 等待尚未发生的事件。
3. `interrupted`: 进程中断了原本可继续的执行。
4. `terminal`: 当前执行轮已经结束，可作为历史结果保留；除 archived 外可由用户或父会话显式继续。
5. `archived`: 归档，不允许继续。

### 小类和下一步动作

| class | status | 下一步动作 |
| --- | --- | --- |
| active | `active` | runtime 继续执行；进程退出时转 `interrupted_active` |
| blocked | `blocked_user_input` | 用户提交输入后转 active |
| blocked | `blocked_confirm` | 用户确认后转 active；取消后转 terminal_cancelled |
| blocked | `blocked_permission` | 权限通过后继续工具；拒绝后按工具失败或取消处理 |
| blocked | `blocked_child` | 子会话 terminal 后收集 result，恢复父会话 |
| blocked | `blocked_rate_limit` | 到 reset/due_at 后转 active |
| blocked | `blocked_concurrency` | 槽位释放后转 active |
| blocked | `blocked_retry` | 到 due_at 后重试并转 active |
| blocked | `blocked_external_tool` | durable external tool callback/poll 成功后转 active |
| interrupted | `interrupted_active` | 自动恢复 session loop |
| interrupted | `interrupted_external_tool` | 重新绑定 correlation id 后继续等 external tool |
| interrupted | `interrupted_unknown` | 不自动重放破坏性动作，提示用户继续/终止 |
| terminal | `terminal_success` | satisfying=true，父会话可继续 depends_on |
| terminal | `terminal_reply` | satisfying=false，父会话消费 reply；子会话自然结束 |
| terminal | `terminal_partial` | 父会话决定补任务、继续或结束 |
| terminal | `terminal_failure` | 父会话决定重试、替代方案或报告失败 |
| terminal | `terminal_error` | 可由用户或父会话显式重试 |
| terminal | `terminal_cancelled` | 默认不继续，用户可显式恢复 |
| terminal | `terminal_timeout` | 用户可重试 |
| terminal | `terminal_user_completed` | 用户手动完成，不自动继续 |
| archived | `archived` | 禁止继续 |

`ActionResult(status: "reply")` 映射为 `terminal_reply`，不是 `blocked`。

## 修复方案

### 1. DB schema

在 `session` 表增加权威状态字段:

- `status_class`
- `status`
- `status_message`
- `status_recoverable`
- `status_updated_at`
- `status_source`
- `status_detail` JSON

添加 migration，并在 session create 时写入默认 `active/active` 或兼容初始状态。

### 2. SessionStatus 持久化

- `SessionStatus.set()` 同步更新内存和 DB。
- `SessionStatus.restore()` 从 DB 加载当前状态，`session_status/*.json` 仅作为迁移兼容 fallback。
- `SessionStatus.get()` 内存 miss 时可按 session id 从 DB 补一次，避免无证据返回 idle。
- 保留旧 `type` union 作为 API 兼容层，但内部通过 mapper 维护新 class/status。

### 3. ActionResult reply

- worker `ActionResult.status === "reply"`:
  - session status -> `terminal_reply`
  - `satisfying=false`
  - turn outcome -> `completed` 或新增 `reply` 需评估；第一阶段可保留 `blocked` outcome 兼容 UI，但 SessionStatus 必须是 terminal_reply。
- 父会话通过 completed_delegations / result store 消费 reply。
- 不默认给子会话回消息；只有父会话或用户明确继续时，才向子会话追加 internal/user message 并转 active。

### 4. Handoff delivery

第一阶段不新增 outbox 表，先保证已有 result store 可重放:

- 启动时如果子会话是 `terminal_reply` 且父会话 pending delegation 仍未 notified，则重新 `store/notified/submit`。
- 如果父会话已 completed_delegations 包含该 result，不重复投递。

后续可增加 `session_event_outbox` 做 durable exactly-once handoff。

### 5. 去重和幂等

- 给 `session_result` 增加唯一索引:
  - `(parent_session_id, child_session_id, run_id, action_id)`
- `SessionResult.put()` 改为 deterministic upsert，避免 completed/blocked 双结果。
- 当 raw ActionResult 存在时，row.status 必须从 ActionResult 语义计算，不能被旧 assignment status 覆盖。

### 6. 启动顺序

- `InstanceBootstrap()` 先 `SessionStatus.restore()`，再 `SessionDelegation.init()/recover()`。
- 避免 delegation recovery 在 status map 未加载时把 durable terminal result 记录成 `idle -> ...`。

## 影响文件

预计修改:

- `packages/opencode/src/session/session.sql.ts`
- `packages/opencode/migration/*_session_status_authority/migration.sql`
- `packages/opencode/src/session/status.ts`
- `packages/opencode/src/session/index.ts`
- `packages/opencode/src/session/delegation.ts`
- `packages/opencode/src/session/result.ts`
- `packages/opencode/src/project/bootstrap.ts`
- `packages/opencode/test/session/status.test.ts`
- `packages/opencode/test/session/delegation.test.ts`
- `packages/opencode/test/session/runner.test.ts`

可能需要同步:

- `packages/opencode/src/server/routes/session.ts`
- `packages/opencode/src/session/runtime-tools.ts`
- `packages/app/src/pages/session/helpers.ts`
- `packages/app/src/pages/session/session-side-panel.tsx`
- `docs/harness-module/protocol-runtime.md`

## 验证步骤

1. 新增单测: `ActionResult(reply)` 使 child 进入 `terminal_reply`，parent 收到 non-satisfying result。
2. 新增单测: 重启恢复从 DB 加载状态，不出现无证据 `idle -> blocked`。
3. 新增单测: duplicate ActionResult completion path 只产生一个 `session_result`。
4. 新增单测: `terminal_reply` 可显式继续，`archived` 不可继续。
5. 从 `packages/opencode` 运行:
   - `bun test test/session/status.test.ts`
   - `bun test test/session/delegation.test.ts`
   - `bun test test/session/runner.test.ts`
   - `bun typecheck`

如涉及 `packages/app` UI 状态文案，再从 `packages/app` 运行:

- `bun test:e2e:local -- app/smoke.spec.ts`

## 实施分阶段

### Phase 1: DB authority + reply terminal

- 加 DB 字段和迁移。
- `SessionStatus.set/restore/get` 接入 DB。
- reply 映射为 terminal_reply。
- 修启动顺序。
- 修 `SessionResult.put()` 幂等。
- 添加 focused tests。

### Phase 2: UI/API terminology cleanup

- UI 不再把 terminal_reply / blocked / interrupted 混称为中断。
- session tree resume/continue 按 class/status 决定动作。
- runtime tools 暴露新状态字段。

### Phase 3: durable outbox

- 增加 `session_event_outbox`。
- parent handoff、question、permission、external tool 统一用 outbox 重放和 ack。

## 执行记录

- 已按 Phase 1/2/3 顺序实现。
- `session` row 已保存当前生命周期投影。
- `ActionResult.status=reply` 和 `AgentProtocolOutput(kind=reply)` 已映射为 `terminal_reply`。
- `session_result` 已按 parent/child/run/action 增加唯一逻辑键。
- `session_event_outbox` 已增加 parent handoff 事件记录和 delivered 标记。
- Bootstrap 已调整为先 `SessionStatus.restore()`，再启动 delegation recovery。

已验证:

- `cd packages/opencode && bun test test/session/status.test.ts`
- `cd packages/opencode && bun test test/session/delegation.test.ts`
- `cd packages/opencode && bun typecheck`
- `cd packages/app && bun typecheck`
- `cd packages/app && bun test:e2e:local -- app/smoke.spec.ts`
