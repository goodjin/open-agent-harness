# 持久化 Interaction 与 Continuation 恢复修复计划

## 问题描述

- 日期：2026-07-26
- 严重程度：Critical
- 影响范围：协议确认、Task 创建/更新确认、用户输入、Session 热重载与进程重启恢复

当前 Runtime 可以持久化部分确认事实和页面投影，但确认等待仍依赖进程内
`QuestionService` Deferred，继续执行仍可能依赖一次性的
`Question.reply()` 或 `SessionPrompt.prompt()` 调用。

热重载或进程重启后，页面能够从数据库恢复待确认内容，但原始 Deferred、Prompt
callbacks 和执行调用栈已经丢失。用户确认后可能出现：

- 确认记录已经是 `confirmed`；
- outbox 被标记为 `delivered`；
- 没有 Runtime 消费者真正恢复执行；
- Session 继续显示 `waiting_user`；
- 重试也无法重新建立原始等待关系。

## 根因分析

### 错误的恢复边界

系统持久化了“用户需要确认什么”，但没有完整持久化：

- Runtime 在哪个 Task、Revision、Run、Action 上暂停；
- 用户决定后应创建哪个继续命令；
- 继续命令是否被领取和完成；
- 应从哪个安全 checkpoint 恢复。

### 双重权威

- SQLite/Storage 保存协议 confirmation 和 Task confirmation。
- `QuestionService.pending` 保存实际等待者。
- `SessionPrompt.state` 保存活动循环和 callbacks。
- `SessionStatus` 单独保存 `waiting_user` 投影。

这些状态没有通过同一事务收敛。持久化确认可以存在，而实际等待者已经丢失。

### 非原子投递

确认状态更新、Task/Revision 更新、continuation 创建和 Runtime 唤醒没有统一成一个
数据库事务。即使存在 outbox，投递目标仍可能是已经丢失的内存 Deferred，而且返回
失败后仍可能被标记为 delivered。

## 已确认目标

1. 所有 Runtime human interaction 在对外可见前先持久化。
2. Runtime 不跨 human interaction 持有必须恢复的 Deferred 调用栈。
3. 用户决定与 continuation command 在同一 SQLite 事务中提交。
4. continuation 使用幂等键、lease、generation 和 fencing。
5. 热重载与进程重启后自动恢复 pending interaction、queued continuation 和过期 lease。
6. SessionStatus 从持久化事实重建，不把内存等待状态当作权威。
7. `create/self`、`update/self` 确认后只调度新的执行图生成回合，不执行准入包中的图。
8. 旧数据只做一次性、可审计迁移，不保留长期分叉兼容流程。

## 状态机

### Interaction

```text
pending -> confirmed
pending -> answered
pending -> cancelled
pending -> rejected
confirmed|answered -> continuation_queued
continuation_queued -> completed
continuation_queued -> failed
```

### Continuation

```text
queued -> leased -> running -> completed
                    \-> failed
leased|running --lease expired--> queued
failed --retry policy--> queued
```

### Task 准入

```text
proposal_pending
  -> confirmed
  -> Task/Revision(active, empty workflow)
  -> graph_generation queued
  -> graph_generation running
  -> graph declared
  -> Run queued
```

`create/self` 和 `update/self` 所在协议包中的 executable siblings 始终忽略。

## 数据设计

### Runtime Interaction

新增 SQLite 表保存：

- interaction identity；
- Session、Task、Revision、Run、Action 和 Message 关联；
- interaction kind 与可展示 payload；
- pending/decision/terminal 状态；
- generation、checkpoint 和时间；
- 唯一业务键，保证重放不重复创建。

### Runtime Continuation

新增或扩展持久化命令，保存：

- interaction identity；
- continuation kind；
- checkpoint/cursor payload；
- queued/leased/running/completed/failed 状态；
- owner token、generation、lease expiry；
- attempts、错误和幂等键。

### 状态投影

Session 状态优先从以下事实计算：

1. pending interaction；
2. queued/leased/running continuation；
3. active Action Attempt；
4. waiting child；
5. terminal Task/Run。

## 实现计划

### 数据层

- 增加 migration 和 Drizzle schema。
- 增加唯一键、状态索引、Session 外键和 interaction-command 关联约束。
- 提供原子 resolve-and-enqueue API。

### Runtime

- human action 先写 interaction，再结束当前执行边界。
- 确认接口不再以唤醒内存 Deferred 作为成功条件。
- Worker 通过 lease 消费 continuation。
- Task create/update 生成 `graph_generation` continuation。
- 普通 confirm/input 从持久化 Run/Action cursor 恢复。

### Recovery

- 启动扫描 pending interaction、queued continuation 和过期 lease。
- 重建 SessionStatus。
- 对已确认但尚无 continuation 的旧数据按稳定 identity 做一次性迁移。
- 恢复过程可重复执行，不重复创建消息、Revision、Run 或 Action。

### UI/API

- UI 只读取持久化 interaction。
- Task 提案继续只显示任务 Markdown。
- API 返回明确的 pending、queued、running、failed 和 completed 状态。

## 影响模块

- `packages/opencode/src/session/session.sql.ts`
- `packages/opencode/src/storage/migration/`
- `packages/opencode/src/question/`
- `packages/opencode/src/server/routes/question.ts`
- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/status.ts`
- `packages/opencode/src/session/recovery.ts`
- 新增 interaction/continuation 领域模块
- 对应后端与前端测试
- `docs/harness-module/protocol-runtime.md`

## 验证计划

### 状态与事务

- interaction 在事件发布前已提交。
- 重复创建返回同一 interaction。
- 重复确认只生成一个 continuation。
- 决定或 continuation 创建失败时整体回滚。
- 错误 owner/generation 无法完成旧 lease。

### 热重载与重启

- 确认前热重载：确认卡恢复，确认后继续。
- 确认提交后、Worker 领取前重启：自动执行 queued continuation。
- Worker 领取后重启：lease 过期后自动接管。
- 执行中重启：从 checkpoint 恢复，不重复已提交副作用。
- pending interaction 不会因为内存 Question 丢失而消失。

### 两阶段 Task 准入

- create/update 准入包中的执行图不执行。
- 确认后只创建一次 graph-generation continuation。
- 模型下一回合读取已确认 Task 后生成执行图。
- 不再次请求相同 Task assignment。

### 命令

从 `packages/opencode` 执行：

```bash
bun test test/session/interaction.test.ts
bun test test/session/task-confirmation.test.ts
bun test test/session/recovery.test.ts
bun typecheck
```

如修改 `packages/app`，从 `packages/app` 执行：

```bash
bun typecheck
bun test:e2e:local -- app/smoke.spec.ts
```

最后使用真实本地服务验证确认、热重载和自动恢复路径。

## 完成条件

- 确认和输入流程不再依赖不可恢复的内存 Deferred。
- 热重载和进程重启能够从 SQLite 自动恢复。
- `confirmed + waiting_user + no runnable continuation` 不再是合法状态。
- Task 两阶段准入和普通执行确认都有自动化测试。
- 模块文档与实际状态机一致。
- 测试、typecheck 和真实请求路径验证通过。

## 实施结果

### 权威边界

- 新增 `runtime_interaction` 表。Question 只负责展示与进程内通知，不再是确认和输入恢复的事实源。
- 确认或输入决定与 `runtime_continuation` outbox 在同一 SQLite immediate transaction 中提交。
- Interaction 在发布 Question 事件前写入；`Question.list()` 合并进程内请求与当前项目目录下的持久化 pending interaction。
- `SessionStatus` 从 pending interaction、pending/delivering continuation 等持久事实修复，过期的 `waiting_user` 不再永久保留。

### Checkpoint 与续跑

- human action 写入 interaction 后结束当前协议回合，不跨用户等待保留必要调用栈。
- 协议摘要和 Turn 终态提交后，checkpoint 才标记 `ready`。用户快速确认时 outbox 保持 pending，避免与原回合并发修改同一 assistant message。
- 普通确认 continuation 保存原 assistant message id 和原 run id。确认后 Runtime 重新读取已持久化的原始 `AgentProtocolOutput`，沿用原 run id，确认 gate 从 SQLite 读取决定，然后继续同一动作图。
- 普通确认不会再次请求模型生成动作图；取消只提交取消事实，不创建执行 continuation。
- 协议 input 的回答会创建模型 continuation，因为回答本身可能改变后续执行图；捕获内容包含选项 id、标签、描述和自定义文本。
- Task create/self、update/self、handoff/peer 不续跑准入包。create/update 激活空 workflow 后进入现有 Task bootstrap，由模型生成新的执行图。

### 并发与重启

- continuation 使用稳定 dedupe key、owner token、lease、heartbeat 和 payload fencing。
- 同一 Session 已在恢复时，竞争 worker 将 lease 原子释放回 pending；当前恢复者释放 session 栅栏后重新扫描。
- 启动恢复以 `recover: true` 扫描 pending、failed 和过期 delivering continuation；进程重启不依赖旧 Deferred、callback 或内存 Question。
- 历史 DSL confirmation/input 通过稳定 request id 重建 interaction；只有持久化协议摘要能够证明原回合已提交时才补记 ready checkpoint。

### 验证结果

- migration 顺序检查通过。
- `packages/opencode` 的 `bun typecheck` 通过。
- interaction、Question、Question route、Task confirmation、Session Task 测试通过。
- 新增回归覆盖：interaction 先持久化、重复决定只创建一个 outbox、过期 lease 重启接管、原 run id 的普通确认确定性续跑。
- `session/recovery.test.ts` 仍有一个变更前已存在的 scoped-child list 失败；完整 Runner 中仍有三个变更前已存在的工具重复计数失败，均不属于本修复路径。
