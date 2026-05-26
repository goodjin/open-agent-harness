# 阶段二：可操作 Harness Console

## 目标

在只读控制台基础上，允许用户通过受控操作推进 Run。所有操作必须转化为 Command 或受控 Action，由 Runtime 校验后产生 Event 和 Projection 更新。

本阶段回答：

- 用户如何创建 Run？
- 用户如何暂停、恢复、取消 Run？
- 用户如何重试、取消 Task？
- 用户如何回答 Decision Request？
- UI 如何避免直接修改状态？

## 交付物类型

- 后端：interface
- 前端：presentation
- 集成测试：interface + presentation

## 后端工作

### T-01 定义 Command schema

Command 类型：

- `run.create`
- `run.pause`
- `run.resume`
- `run.abort`
- `task.retry`
- `task.cancel`
- `decision.answer`
- `verify.rerun`

建议文件：

- `packages/opencode/src/harness/command.ts`

验收：

- 每个 Command 有 schema。
- 每个 Command 声明 required authority。
- 非法 payload 被拒绝。

### T-02 实现 Command Handler

职责：

- 校验 schema
- 校验 authority
- 写入 Event
- 更新 Projection
- 返回 action result

建议文件：

- `packages/opencode/src/harness/runtime.ts`
- `packages/opencode/src/harness/events.ts`
- `packages/opencode/src/harness/projection.ts`

验收：

- Command 不直接写 task state，必须通过 Event。
- Event append 和 Projection update 顺序稳定。
- 失败时不产生半状态。

### T-03 暴露操作 API

接口：

```txt
POST /harness/commands
POST /harness/runs
POST /harness/runs/:id/pause
POST /harness/runs/:id/resume
POST /harness/runs/:id/abort
POST /harness/tasks/:id/retry
POST /harness/tasks/:id/cancel
POST /harness/decisions/:id/answer
POST /harness/verifications/:id/rerun
```

验收：

- 所有 Action 最终走 Command Handler 或共用校验逻辑。
- API 返回更新后的 Projection 摘要。
- 旧 API 不受影响。

### T-04 实现基础 Gate 校验

Gate：

- `schema_valid`
- `run_mutable`
- `task_retry_allowed`
- `decision_option_valid`
- `verification_rerun_allowed`

验收：

- 已完成 Run 不能随意 resume。
- 非 pending Decision 不能 answer。
- 不允许 retry 不存在的 Task。

## 前端工作

### T-05 新建 Run 表单

字段：

- goal
- mode
- constraints
- memory scopes
- automation level

验收：

- 用户能创建 Run draft。
- 提交前显示结构化预览。
- 创建成功后进入 Run Detail。

### T-06 Run 操作按钮

操作：

- pause
- resume
- abort

验收：

- 按钮根据状态启用/禁用。
- 高风险操作显示确认。
- 操作成功后页面刷新 Projection。

### T-07 Task 操作按钮

操作：

- retry
- cancel
- reassign 占位入口

验收：

- 操作通过 API 提交，不本地伪造状态。
- 失败原因展示给用户。
- 任务详情显示最近操作事件。

### T-08 Decision Inbox 可操作

能力：

- 选择 option
- reject
- request more info
- request impact analysis

验收：

- Decision 以人类可读方式展示。
- 用户选择后生成 `decision.answer`。
- 已回答 Decision 变成只读状态。

### T-09 Verification Rerun

能力：

- 用户可对失败 verification 重新执行。
- UI 显示上次日志和新状态。

验收：

- rerun 操作产生事件。
- 重跑中显示 pending/running。

## 集成测试

### T-10 Command -> Event -> Projection 测试

位置：

- `packages/opencode/test/harness/command-runtime.test.ts`

验收：

- `decision.answer` 产生 decision answered event。
- Projection 中 pending decision 消失。
- 非法 option 不改变 Projection。

### T-11 UI 操作端到端测试

位置：

- `packages/app/e2e/harness/actions.spec.ts`

验收：

- 用户能创建 Run。
- 用户能暂停/恢复 Run。
- 用户能回答 Decision。
- 操作后 UI 状态更新。

## 风险

- 如果 Authority 模型还不完整，第一版需要先用保守策略。
- Command API 和快捷 Action API 可能重复；实现时必须复用校验逻辑。
- 高风险操作需要确认文案，否则用户可能误操作。

## 完成标准

- 用户可以通过新 UI 推进 Run。
- 所有状态变化都有 Event。
- 所有操作通过 Runtime 校验。
- 旧 UI 不受影响。
