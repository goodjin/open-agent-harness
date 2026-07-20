# Bug Fix: Task update double confirmation and delayed decision state

## 问题描述

- 日期：2026-07-20
- 严重程度：High
- 影响范围：Planner 协议确认、Task update/handoff、Session timeline、确认恢复

当 Planner 输出带 `assignment=update/self` 或 `assignment=handoff/peer` 的 `confirm` Action 时，Runtime 同时创建通用方案 Question 和 Task 提案确认。用户因此看到两个语义重复的确认入口。确认 Task 提案后，后端又先同步执行 continuation 模型请求，直到模型链返回才把公开提案状态从 `pending` 改为 `confirmed`，造成模型已运行但界面仍显示等待确认。

## 根因分析

- `packages/opencode/src/session/runner.ts`
  - `confirm()` 为 update/handoff 创建 Task proposal 后，仍无条件调用 `Question.askReply()`。
  - 同一个 Action 因此产生 Task proposal 与 generic Question 两个交互载体。
- `packages/opencode/src/session/task-confirmation.ts`
  - `respond()` 只先写内部 `continuation_pending`，随后同步等待 `deliver()`。
  - `deliver()` 调用 `SessionPrompt.loop()` / `SessionPrompt.prompt()`。
  - 公开的 DSL confirmation 状态在 continuation 返回后的 `complete()` 中才改为 `confirmed/cancelled`。
- `packages/opencode/src/server/routes/question.ts`
  - Task proposal 的通用 Question 兼容入口将除明确 cancel 之外的响应全部解释为 confirm，存在空响应或未知响应被误确认的风险。
- 现有测试把 continuation mock 成立即完成，只验证调用次数，没有覆盖确认决策提交与长时间 continuation 的先后顺序。

## 约定行为

1. `confirm` 带 Task Assignment：只展示 Task proposal；一次用户决策同时批准计划与 Task create/update/handoff。
2. `confirm` 不带 Task Assignment：继续使用 generic Question。
3. Task proposal 的确认或取消先持久化为公开决策；UI 在请求期间立即进入 revising/creating，不继续显示待确认。
4. continuation 仍由 durable outbox 交付；失败保留内部恢复状态，但不把已经确认的用户决策改回 pending。
5. Task proposal API 只接受明确的 confirm/cancel。空响应和未知答案 fail closed。

## 修复方案

- 调整 Planner confirm 执行：update/handoff proposal 落库后直接形成等待用户状态，不再创建第二个 Question。
- 拆分 Task confirmation 的“用户决策提交”和“continuation 交付完成”状态：先更新 DSL confirmation，再投递 outbox。
- 保留 confirmation proof、generation、lease、snapshot 和 outbox 幂等恢复约束。
- 收紧通用 Question 到 Task confirmation 的决策解析，只接受明确响应。
- 前端保持 Task proposal 为 assignment confirmation 的唯一展示入口。

## 验证计划

1. 后端测试：assignment confirm 不创建 generic Question，普通 confirm 仍创建。
2. 后端时序测试：阻塞 continuation 时，DSL 状态已经 confirmed，内部 proof 保持 continuation_pending。
3. 后端恢复测试：异步 continuation 失败后可由 scan 重试，且公开决策不回退。
4. 后端输入测试：空响应、未知响应不能确认 Task proposal。
5. 前端测试：同一 Action 只渲染 Task proposal，不渲染重复确认卡。
6. 运行 `packages/opencode` 定向测试与 `bun typecheck`。
7. 运行 `packages/app` 单元测试、`bun typecheck` 和 `bun test:e2e:local -- app/smoke.spec.ts`。
8. 使用本地服务执行一次真实 Task update confirm 路径，核对 DB、日志和 UI 投影。

## 文档影响

- 更新 `docs/harness-module/protocol-runtime.md`：Task Assignment confirmation 是单一交互门禁，公开决策与 continuation delivery 分离。
- 如 UI 展示契约发生变化，更新 `docs/harness-module/ui-console.md`。

## 验证结果

- ✅ `packages/opencode`: `bun test test/session/runner.test.ts test/server/session-task.test.ts`（88 passed）
- ✅ `packages/opencode`: `bun typecheck`
- ✅ `packages/app`: `bun test src/pages/session/session-task.test.ts src/pages/session/message-timeline.test.ts`（44 passed）
- ✅ `packages/app`: `bun typecheck`
- ✅ `packages/app`: `bun test:e2e:local -- app/smoke.spec.ts`（1 passed，隔离临时数据库）
- ✅ 真实 Server route 测试覆盖 update/handoff confirm、阻塞 continuation、失败恢复与空响应 fail-closed
- ✅ 独立只读代码审查通过，无阻断问题
