# Session Task 事务一致性修复

## 问题描述

- 日期：2026-07-17
- 严重程度：Critical
- 影响范围：Session Task 的多 Run 动作投影、迟到同步、确认绑定与委托绑定

当前实现存在多类一致性缺口：Run 窗口身份和持久化边界不一致；终态 Task/Revision 仍可能接收迟到同步；Assignment blob 与 DB row 可在并发更新中脱节；确认、跨 Run 继承及委托绑定缺少完整事务或补偿边界。

## 修复范围

1. 使用同一个 recent Run 窗口完成读取与动作身份标记，并明确窗口外动作不进入当前进度。
2. 为 `sync` 增加 Task/Revision 生命周期 CAS 和动作单向状态迁移规则。
3. 在 Task 持有的 immediate 事务内读取当前 confirmed assignment 并完成路由写入。
4. 在 Task 持有的 immediate 事务内验证 child parent、当前 delegated assignment 并创建或复用 Task。
5. 让 Assignment blob 使用完整 canonical content digest 与不可碰撞路径，并以 DB CAS 发布新版本。
6. 支持 confirm-only package 后由后续 executable package 绑定当前 canonical Assignment。
7. 为 delegated Task 绑定失败提供可审计、幂等且不可恢复重启的补偿终态。
8. 统一所有 SessionTask public transaction 的 SQLite 错误归一化。
9. 将 workflow 的持久化 working set 限制为最近 50 Runs，同时累计 compact progress。
10. 用明确 pending 状态轮询替换 Runner 测试中的固定 200ms 等待。
11. 让 same-run dependent child launch 在 prompt 前走与 Runner 相同的 delegated Task 绑定与失败补偿。
12. 让 binding failure 同步终结 owner turn 的 child Timeline 投影，保留 canonical child/action/agent/title 映射并保证重复补偿幂等。
13. 让 create/update Assignment 在 Task 路由成功的同一 immediate 事务内完成消费，后续 executable Run 只继续现有 Task。
14. 旧 `rev-<n>` 内容一律忽略 blob 内 assignment metadata，仅从可信 row/source 和当前 Task 上下文恢复有限路由。
15. 将 `SessionTurn.finish` 的最新状态读取、终态优先判断与消息写入收进同一 immediate 事务，阻止 waiting 后写覆盖 terminal。
16. 清理 Runner 测试的共享 spy/loop 计数依赖，并用多轮全文件与组合运行验证稳定性。
17. 将 confirmed create/update Assignment 的 canonical id 写入 Revision workflow，避免相同标题和正文的历史 Assignment replay 串到最新 draft。
18. 让 consumed create/update Assignment replay 统一返回原始 Revision 的只读结果，包括已经 archived、completed 或 activated 的历史版本，不恢复执行或切换 current。

## 实际修复

- 新增共享的 delegated Task 绑定入口，按 delegation、Assignment、Task 的顺序完成绑定，Runner 与 same-run dependent launch 共用该入口。
- 绑定阶段失败时将 Assignment 标记为 failed，清理父会话 pending delegation，将子会话审计迁移到 `failed_delegation`，持久化终态，并禁止进入父会话 fan-in 或发送 child prompt。
- 绑定失败同时从 persisted canonical delegation 终结 owner turn child Timeline；`SessionTurn.finish` 写入前重读 owner message，避免 stale user 覆盖刚写入的 terminal child 投影。
- 对旧 `rev-<n>` Assignment 保留受限兼容：无 Task 的 confirm 可按 create/self 绑定，已有 Task 拒绝隐式操作；delegation 继续按 source locator 绑定；plan hash 不匹配时拒绝。
- create/update Task 路由成功后在同一 immediate 事务内 CAS 消费 Assignment；同 locator replay 返回既有 Revision，后续普通 Run 直接继续当前 Task。handoff 在持久 proposal 落地前保持 running，并阻止普通 execute 越过 pending handoff。
- `SessionTurn.finish` 直接在 MessageTable immediate 事务内读取最新 turn、应用 terminal outcome 优先级并更新消息；Bus effect 仅在提交后发布。
- Runner soft-limit 测试改为等待明确事件与 deadline，并在每个测试后统一恢复 mocks。
- 新建 create/update Revision 的 workflow 持久化可选 `assignment_id`；completed Assignment replay 先校验精确 source locator 与完整 row fingerprint，再按该 id 返回对应 Revision。同一 Assignment 重放幂等，不会新增 Revision。
- 历史 workflow 不含 `assignment_id` 时，仅在 `source_message_id` 或 `workflow.run_id` 与 Assignment source locator 精确一致且候选唯一时兼容；歧义场景直接冲突，不按标题或正文猜测。
- create/update replay 在当前 session Task 的全部 Revisions 中按 canonical assignment id 查找，返回统一 `replay` 类型；Runner 将其作为只读阻断结果处理，不执行 package action。Task 查询受 session 约束，另一 Task 即使伪造相同 workflow id 也不能复用该 Assignment。

## 验证补充

- Runner 与 same-run dependent launch 均注入 Assignment 写入后 `SQLITE_BUSY`，验证统一补偿结果。
- 覆盖 same-run prompt 前 Task 已绑定、重复 complete 不重复启动，以及 legacy confirm/delegation/篡改兼容矩阵。
- Runner 与 same-run failure 额外验证 owner turn child Timeline 由 current/pending 收敛为 failed terminal，重复 fail 不回到 pending。
- 覆盖 Assignment consume/replay、legacy 路由 metadata 注入、handoff pending 拦截和 concurrent finish terminal 优先级。
- 覆盖两个标题和正文完全相同的 update Assignment 各自创建 draft，并验证 first/second locator 精确返回 first/second Revision、重复 first 不产生第三个 draft，以及 legacy locator 歧义拒绝。
- 覆盖 create A 生成 v1、update B 生成并激活 v2 后，A/B locator 分别返回 archived v1 和 active v2，current 仍为 v2、无新 Revision、replay actions 未写入，以及跨 session Task 的相同 id 伪造被拒绝。

## 影响模块

- `packages/opencode/src/session/task.ts`
- `packages/opencode/src/session/assignment.ts`
- `packages/opencode/src/session/runner.ts`
- `packages/opencode/test/session/task.test.ts`
- `packages/opencode/test/session/runner.test.ts`

## 实施计划

1. 先增加真实 SQLite 回归测试并确认 RED。
2. 提供接受事务句柄的 Assignment 窄读取接口，事务所有权保留在 Task 域。
3. 收紧 Task 同步与绑定写入的条件更新。
4. 重跑 Session Task、Runner、Runs、Delegation 全量测试及类型检查。

## 根因分析

- `current()` 对 Runs 做了 `slice(-50)`，但归并时仍按原始 Run 数组索引标记动作，窗口超过 50 后身份发生偏移。
- `sync()` 只校验 Run 是否登记，没有校验 Task/Revision 生命周期，也允许同一真实动作被后续不同结果覆盖。
- confirmed 与 delegated 绑定先在事务外读取 assignment，再另开 Task 事务，旧 assignment 可在两步之间被 supersede。
- Assignment 更新先写共享 `rev-N` blob 再无条件覆盖 DB 行，并发写可让 row fingerprint 与 blob 正文来自不同写者。
- confirm-only package 与后续 executable package 之间没有 persisted Assignment 继承路径。
- delegated child 在 Task 绑定失败后缺少补偿，pending、running Assignment 与可恢复 child 会残留。
- workflow 读取虽有限制，持久化 JSON 仍随 Runs 无界增长。

## 实际修复

- 同一个 `recent` 数组负责 Run 加载、动作标记和归并，当前投影仅包含最后 50 个 Runs。
- `sync()` 要求 Task 为 `running`、`waiting_user` 或 `revising`，Revision 为当前 `active`；动作只允许 planned 到 real 的一次升级，相同 real 幂等，其他重放冲突。
- `SessionAssignment.withCurrent()` 接受 Task 持有的事务句柄，比较完整 assignment fingerprint、active identity 与 source locator。confirmed/delegated 在 Task 写入前后各校验一次，竞争变化会回滚整个 immediate 事务。
- delegated 调用方只传 parent/session/Run/action locator，标题和正文来自 canonical assignment snapshot。
- Assignment 使用完整 canonical content digest 命名 blob，并通过 expected version/ref/hash 的 immediate DB CAS 发布；新读取校验完整 digest，旧 `rev-N` 记录按历史 plan hash 只读。
- 无当前 package locator 时，后续 executable Run 从唯一 active confirmed Assignment 绑定 canonical Task 内容。
- delegated 绑定失败会把 Assignment、delegation 和 child 推进可审计终态，清除 parent pending fan-in 状态。
- workflow 新写仅保留最近 50 Runs；被裁剪进度累计到 compact summary，Session Runs 继续保存详细历史。
- 所有 SessionTask 事务通过同一窄 wrapper 归一化 SQLite busy、locked 和 constraint 错误；普通 Error 原样传播。

## 验证计划

- 55+ Run 窗口内每个动作的 `run_id` 与实际 Run 一致，窗口外动作只通过 compact summary 计入总体 progress。
- completed/failed Task 或非 active Revision 的迟到同步不改变数据库。
- planned 到 real 仅允许一次升级；相同 real 重放幂等，不同 real 或 real 到 planned 被拒绝。
- confirmed 与 delegated assignment 在竞争替换时无法绑定旧身份。
- `bun typecheck`、`git diff --check` 与四个相关完整测试文件通过。

## 验证结果

- Session Task：50 passed
- Session Runner：63 passed
- Session Runs：29 passed
- Session Delegation：37 passed
- Session Turn：5 passed
- 合计：184 passed，0 failed
- `bun typecheck`：通过
- Runner 全文件连续 5 轮均为 63 passed；五文件组合连续 3 轮均为 182 passed。
- 稳定性对照曾复现既有跨进程 draft conflict；单跑及最终三轮组合均通过。另定位并移除 self-delegation 测试对并发 prompt 数组顺序的依赖。
- 最终组合门额外暴露 textual tool-call retry 测试对固定 `inputs[1]` 的顺序依赖；改为按 retry system marker 定位后，focused 连续 5 轮及五文件组合通过。
