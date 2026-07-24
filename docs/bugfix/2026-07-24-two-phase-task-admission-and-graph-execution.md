# 两阶段 Task 准入与执行图生成修复计划

## 用户目标

Task 的创建或更新与执行图生成必须分成两个模型回合：

1. 模型先提交 `create/self` 或 `update/self` 任务提案。
2. Runtime 只展示任务 Markdown 并等待用户确认。
3. 用户确认后，Runtime 持久化 Task、Revision 和确认结果。
4. Runtime 通过可恢复的 bootstrap 通知模型任务已经确认。
5. 模型在下一回合生成执行图，Runtime 此时才创建 Run 并执行。

任务准入包即使携带 agent/tool 执行项，Runtime 也必须忽略，不得持久化为
Revision workflow、创建 Run、启动子会话或调用工具。

## 已确认范围

- `create/self` 和 `update/self` 采用统一的两阶段边界。
- `handoff/peer` 保持目标会话 bootstrap、源会话不执行同包图的现有边界。
- Task 提案卡只展示任务内容、提案类型和状态，不展示：
  - 影响会话 ID
  - ownership 提示
  - reusable refs
  - 带内部 Run、Action 或 Session ID 的差异摘要
- 已完成或失败的当前 Revision 可以通过确认更新创建后继 Revision。
- 确认处理失败必须持久化为 `failed`，不能长期停留在 `claimed`。
- 重试和重启恢复必须幂等，不重复创建 Revision、bootstrap 或 Run。

## 状态机

### 创建 Task

`无 Task -> proposal_pending -> confirmed -> Task/Revision(active, empty workflow) -> bootstrap_pending -> graph_declared -> Run`

取消时：

`proposal_pending -> cancelled`

### 更新 Task

`Task(current Revision) -> proposal_pending -> confirmed -> revising -> Revision(draft, empty workflow) -> old Revision archived -> new Revision active -> bootstrap_pending -> graph_declared -> Run`

当前 Revision 已终态且没有活动子会话时，仍创建后继 Revision，不复用或重开旧
Revision。

### 确认失败

`claimed|continuation_pending -> failed(error persisted) -> claimed(new generation on retry)`

任何异常路径都必须终止当前 lease 并保存可见错误。

## 实现方案

### Runtime 准入边界

- 在协议执行前识别带 Task assignment 的 human confirm。
- Task assignment 包不得把非 human actions 传给 `SessionTask.confirmed()`。
- assignment 确认成功后，当前协议包的非 human actions统一返回 ignored/blocked
  结果，不进入正式 Run。
- Revision workflow 初始 `actions` 为空，只保存 assignment identity 和 task body。
- 普通无 assignment 的确认仍保留“确认后执行同包图”行为。

### Bootstrap

- create/update 确认成功后都写入去重键为
  `task_revision_bootstrap:<revision_id>` 的 durable outbox。
- bootstrap prompt 明确：
  - Task 已经确认并绑定；
  - 不要再次提交 create/update assignment；
  - 现在根据完整 Task 内容生成执行图。
- delivery、恢复和重试继续使用固定 message id 与租约保护。

### Task/Revision

- `update/self` 可从 active、completed 或 failed Revision 创建后继 draft。
- 终态 Revision 不回到 active，也不复用旧 Run。
- 新 Revision 激活后才允许普通执行图注册为新 Run。

### 确认收敛

- `SessionTaskConfirmation.respond()` 捕获 owner 执行阶段的所有异常。
- 在 lease/generation 仍匹配时写入 `failed`、`error` 和更新时间。
- 已完成、已取消和已持久化失败的确认保持幂等语义。

### UI

- 提案模型仍可保留内部 metadata 用于 Runtime 和诊断。
- `SessionTaskProposal` 不渲染 summary、children、ownership 和 refs。
- Markdown task body 是提案主体。

### 模型规则与文档

- 删除“create/self 可以携带并执行 sibling graph”的规则。
- planner 必须先提交纯 Task assignment，再在 bootstrap 回合生成执行图。
- 更新 `docs/harness-module/protocol-runtime.md` 中相反的历史描述。

## 影响模块

- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/session/task.ts`
- `packages/opencode/src/session/task-confirmation.ts`
- `packages/opencode/src/session/task-recovery.ts`
- planner protocol 源文件与生成清单
- `packages/app/src/pages/session/session-task-proposal.tsx`
- 对应 opencode/app 测试
- `docs/harness-module/protocol-runtime.md`

## 验证计划

### 后端

- create/self 同包携带 agent/tool：确认前后均不执行，Task workflow 为空。
- create/self 确认后只投递一次 bootstrap；下一执行图创建 Run。
- update/self 同包携带执行项：旧图不执行，新 Revision workflow 为空。
- completed Revision 更新成功创建 v2，bootstrap 后可生成新 Run。
- 确认中途异常写入 `failed`，重试不再无限停在 `claimed`。
- 重复确认、恢复扫描和进程重启不重复创建 Revision/outbox。

### 前端

- 提案卡只渲染任务 Markdown。
- Session/Run/Action ID 不出现在提案可见文本中。
- 确认、取消、失败与重试状态仍正常。

### 命令

- 在 `packages/opencode` 执行相关 Bun 测试与 `bun typecheck`。
- 在 `packages/app` 执行相关 Bun 测试、`bun typecheck`。
- 在 `packages/app` 执行：
  `bun test:e2e:local -- app/smoke.spec.ts`

## 完成条件

- 两阶段边界由代码和测试共同保证。
- `confirm_handoff_build_and_smoke` 对应的终态更新场景有回归测试。
- 提案不再暴露内部 ID。
- 文档与 planner 提示不存在允许 assignment 同包执行图的相反规则。
- 测试、类型检查和 app smoke 通过。
