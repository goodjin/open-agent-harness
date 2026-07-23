# Multi-run confirmed create admission race 修复计划

## 用户目标

完成 M0 Task Ledger 的 INT-06 集成门禁：多 Run legacy proposal 并发收到 ordinary route 与已确认的 canonical create 时，只允许 confirmed create 建立迁移基线；不得让 ordinary route 抢先创建 Task，也不得生成两套 Task/Revision/Ledger。

## 复现与现状

- 隔离执行 `task.test.ts` 的 `lets only a confirmed create win a multi-run migration race` 时，ordinary route 偶发先 fulfilled，confirmed create 随后被冲突拒绝。
- 同一用例在完整组合测试中可能通过，说明结果依赖并发调度时序。
- Recovery 的 scoped-child 失败是既有非 M0 基线，本次只记录，不修改 Recovery 或 SessionControl。

## 根因假设

ordinary admission 与 confirmed create 共用 session 级写入串行化，但 ordinary 路径在取得锁后只根据当前持久化快照判断是否允许迁移，无法识别同一事件循环中已经提交、但尚未进入锁队列的 confirmed create。两个调用的排队次序因此可能由前置异步读取时序决定，破坏 confirmed create 的既有优先级。

初版 gate 仍有两个 Critical：

- timeout 会删除当前 Map entry，旧 generation 的延迟 release 可能误删其后建立的新 generation。
- wait 只等待一次 Set 快照；等待期间加入的 confirmed admission 不在该快照内，ordinary 可能提前进入 `admit/write`。timeout 后继续执行也会绕过仍 pending 的 canonical confirmation。

## 修复范围

- 仅调整 `SessionTask` 的 multi-run admission 协调。
- 将 admission gate 提取为内部 generation helper；release 只操作自己捕获的 generation 和 promise。
- ordinary route 在同一 deadline 内循环等待并重读 gate，直到跨 microtask 的稳定空态，再基于最新持久化状态重判。
- timeout 保留 pending gate 并 fail-closed；ordinary 返回明确冲突，不进入 `admit/write`，confirmed release 后调用方可重试。
- timeout timer 在 promise 提前完成时取消并 `unref`，不让短进程被五秒 timer 拖住。
- 保持 ordinary route 单独执行可成功；confirmed create 失败后清理信号，不阻塞后续 ordinary admission。
- 不重构 legacy migration、Recovery、SessionControl，不引入 M1 Graph、Attempt、Checkpoint 或 Scheduler 行为。

## 影响模块

- `packages/opencode/src/session/task.ts`
- `packages/opencode/src/session/task-admission.ts`
- `packages/opencode/test/session/task-admission.test.ts`
- `packages/opencode/test/session/task.test.ts`
- `docs/features/2026-07-23-durable-task-persistence-m0-plan/02-integration-m0-ledger.md`
- `docs/harness-module/protocol-runtime.md`

## 验证计划

- 隔离重复运行 confirmed/ordinary 并发竞态，confirmed create 稳定成功且 ordinary 被拒绝。
- 覆盖 ordinary route 单独执行仍成功。
- 覆盖 confirmed create 失败后不遗留 pending admission，ordinary 后续可成功。
- 用受控 deferred/barrier 覆盖同 generation 新增 pending、新 generation、stale release、跨 Session 隔离和 fast release timer 取消。
- 覆盖生产五秒 timeout：ordinary 不创建 Task、不删除 pending gate；release 后重试成功。
- 回归现有 route/assignment、single-run legacy、multi-run proposal 与 Task Ledger 测试。
- 运行 T-11 指定的完整 Task/legacy、storage、migration、audit、typecheck 矩阵。

## 验收标准

- 并发调用只产生一个 Task 与一个迁移 Revision，workflow 绑定 confirmed assignment。
- ordinary route 不会执行或吸收 multi-run legacy proposal。
- confirmed 失败不会形成永久等待、残留 Task 或重复 Ledger。
- stale release 不能删除新 generation；wait 不能漏掉等待期间新增的 confirmed。
- timeout 只返回可重试冲突，不写 Task；快速完成不保留 timer。
- 现有 ordinary、route、assignment 行为无回归。

## 执行结果

- 内部 `Admission` helper 已按 generation identity 实现；timeout 不修改 Map，release 幂等且只移除 own promise。
- wait 使用单一 deadline 循环重读 generation 和 pending 快照，稳定空态跨 microtask double-check。
- timer 在快速 settle 时 `clearTimeout`，并使用 `unref`；自然退出子进程测试不调用 `process.exit`。
- helper 聚焦测试 6/6 通过；confirmed/ordinary race 与异常清理连续十轮 20/20 通过。
- admission、Ledger、Task 按文件串行 177/177 通过；其余 T-11 矩阵仅保留已记录的非 M0 Recovery scoped-child 基线失败。
