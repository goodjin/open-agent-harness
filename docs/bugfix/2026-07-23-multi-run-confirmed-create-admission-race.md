# Multi-run confirmed create admission race 修复计划

## 用户目标

完成 M0 Task Ledger 的 INT-06 集成门禁：多 Run legacy proposal 并发收到 ordinary route 与已确认的 canonical create 时，只允许 confirmed create 建立迁移基线；不得让 ordinary route 抢先创建 Task，也不得生成两套 Task/Revision/Ledger。

## 复现与现状

- 隔离执行 `task.test.ts` 的 `lets only a confirmed create win a multi-run migration race` 时，ordinary route 偶发先 fulfilled，confirmed create 随后被冲突拒绝。
- 同一用例在完整组合测试中可能通过，说明结果依赖并发调度时序。
- Recovery 的 scoped-child 失败是既有非 M0 基线，本次只记录，不修改 Recovery 或 SessionControl。

## 根因假设

ordinary admission 与 confirmed create 共用 session 级写入串行化，但 ordinary 路径在取得锁后只根据当前持久化快照判断是否允许迁移，无法识别同一事件循环中已经提交、但尚未进入锁队列的 confirmed create。两个调用的排队次序因此可能由前置异步读取时序决定，破坏 confirmed create 的既有优先级。

## 修复范围

- 仅调整 `SessionTask` 的 multi-run admission 协调。
- 为 pending confirmed create 提供 session 级、短生命周期的 admission 优先级信号。
- ordinary route 在进入迁移写边界前等待该 confirmed create 完成，再基于最新持久化状态重判。
- 保持 ordinary route 单独执行可成功；confirmed create 失败后清理信号，不阻塞后续 ordinary admission。
- 不重构 legacy migration、Recovery、SessionControl，不引入 M1 Graph、Attempt、Checkpoint 或 Scheduler 行为。

## 影响模块

- `packages/opencode/src/session/task.ts`
- `packages/opencode/test/session/task.test.ts`
- `docs/features/2026-07-23-durable-task-persistence-m0-plan/02-integration-m0-ledger.md`
- `docs/harness-module/protocol-runtime.md`

## 验证计划

- 隔离重复运行 confirmed/ordinary 并发竞态，confirmed create 稳定成功且 ordinary 被拒绝。
- 覆盖 ordinary route 单独执行仍成功。
- 覆盖 confirmed create 失败后不遗留 pending admission，ordinary 后续可成功。
- 回归现有 route/assignment、single-run legacy、multi-run proposal 与 Task Ledger 测试。
- 运行 T-11 指定的完整 Task/legacy、storage、migration、audit、typecheck 矩阵。

## 验收标准

- 并发调用只产生一个 Task 与一个迁移 Revision，workflow 绑定 confirmed assignment。
- ordinary route 不会执行或吸收 multi-run legacy proposal。
- confirmed 失败不会形成永久等待、残留 Task 或重复 Ledger。
- 现有 ordinary、route、assignment 行为无回归。
