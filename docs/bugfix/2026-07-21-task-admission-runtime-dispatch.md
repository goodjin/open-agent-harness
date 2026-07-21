# Bug Fix: Task 绑定后的 Runtime 正式投递

## 问题描述

- 日期：2026-07-21
- 严重程度：High
- 影响范围：Task create、update、handoff 的确认、会话启动、协议执行图和会话状态

主会话整理出 Task 后，当前 Runtime 会继续使用任务生成阶段的协议包，或者只向 Handoff 目标会话发送一条要求模型自行调用 `task_inspect` 的通用提示。这会产生三个问题：

1. Handoff 确认后源会话会收到内部续跑消息，再次请求模型，并可能错误执行已经转移给平级会话的新任务。
2. 新会话虽然持久化了完整 Task Revision，但首次请求没有任务正文，模型必须先正确调用 `task_inspect` 才能开始。
3. Task 生成阶段同时产生的 agent/tool 执行图可能在正式绑定前形成，不能作为正式工作流继续执行或进入后续模型上下文。

## 目标行为

Runtime 将“Task 生成/确认”和“正式执行”分成两个阶段：

1. 模型理解用户请求，输出完整 Task Markdown 和 assignment。
2. 用户确认后，Runtime 持久化 Task / Revision。
3. Runtime 丢弃任务生成协议包中的执行图，不执行、不投影为活动 workflow，也不带入后续模型上下文。
4. Runtime 创建一个新的正式执行 Turn，将完整 Task Markdown 作为任务所属会话的首条执行请求，并提示模型任务已经绑定、无需再次确认或查询。
5. 正式执行会话根据完整 Task 重新生成执行图并开始工作。

三类 assignment 的归属规则：

- `create/self`：正式任务请求进入当前会话。
- `update/self`：旧 Revision 归档后，正式任务请求进入当前会话并基于新 Revision 重新规划。
- `handoff/peer`：正式任务请求只进入新建的平级会话；源会话只保留 synthetic + ignored 的 Handoff UI 投影、状态和跳转信息。

## 根因分析

- `packages/opencode/src/session/task-confirmation.ts` 的 durable continuation 对 update 和 handoff 使用同一条源会话续跑路径，Handoff 也会调用源会话 `SessionPrompt.prompt/loop`。
- `packages/opencode/src/session/task-handoff.ts` 的 bootstrap 只提交通用提示，没有提交活动 Revision 正文。
- planner confirmation 的既有契约允许 confirm 与 executable actions 共处一个协议包，确认后可能继续消费同一执行图，不符合 Task 绑定后重新规划的边界。

## 修复方案

1. 为 Task assignment confirmation 增加 Runtime 正式投递语义：确认完成后构造只包含完整 Task Markdown 的新内部用户 Turn。
2. Handoff 的 durable confirmation 不再向源会话创建 continuation Turn；只启动目标会话并完成确认 outbox。
3. Handoff bootstrap 直接提交 Revision body，不再要求首次调用 `task_inspect`。
4. create/update assignment 确认后，不执行任务生成包中的其余 agent/tool actions；由 Runtime 使用正式任务请求启动新的协议 Turn。
5. 确保被忽略的生成阶段执行图不写入活动 Revision workflow，也不作为 protocol context 提交给正式执行模型。
6. 保留 `task_inspect`，仅用于后续修订、恢复、状态和结果查询，不作为首次任务交付机制。

## 影响模块

- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/session/task-confirmation.ts`
- `packages/opencode/src/session/task-handoff.ts`
- `packages/opencode/src/session/task-recovery.ts`
- `packages/opencode/src/session/task.ts`
- `packages/opencode/config/protocol/planner-protocol.md`
- `packages/opencode/config/agents/{epic-planner,milestone-planner,feature-planner}/rules.md`
- `packages/opencode/src/agent/builtin.generated.ts`
- `packages/opencode/test/server/session-task.test.ts`
- `packages/opencode/test/session/runner.test.ts`
- `packages/opencode/test/session/task-handoff.test.ts`
- `packages/opencode/test/session/task.test.ts`
- `docs/harness-module/protocol-runtime.md`

## 验证计划

1. Handoff 确认后源会话不调用模型、不创建子会话、不进入 `waiting_child`。
2. 目标平级会话首条请求包含完整 Task Markdown，并保留 task/revision/handoff metadata。
3. create/update 确认后，生成阶段包内的 agent/tool actions 不执行；正式任务 Turn 重新产生执行图。
4. 被忽略的生成阶段执行图不进入活动 Revision workflow 和正式任务模型上下文。
5. 运行相关 session 测试、`bun typecheck`，并通过真实 Runtime 路径核对 Task、Revision、消息和状态。

## 验证结果

- Runner 集成路径：68 个测试通过，覆盖 create、update、handoff、准备图丢弃和正式 Task bootstrap。
- Task 与 Handoff 持久化路径：101 个测试通过。
- Session Task API 与并发恢复路径：20 个测试通过，包含跨进程去重、lease fence、reclaim 和 live Question 路由。
- Agent loader：35 个测试通过，确认重新生成的内置 planner 配置可加载。
- `bun typecheck`：通过。

## 非目标

- 不删除 `task_inspect` 工具。
- 不改变普通、无 assignment 的协议确认行为。
- 不修改已有用户数据或手工修复当前 actgraph-desktop 会话状态。
