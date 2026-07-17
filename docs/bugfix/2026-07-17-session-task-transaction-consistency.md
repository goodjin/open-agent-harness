# Session Task 事务一致性修复

## 问题描述

- 日期：2026-07-17
- 严重程度：High
- 影响范围：Session Task 的多 Run 动作投影、迟到同步、确认绑定与委托绑定

当前实现存在四类一致性缺口：超过 50 个 Run 时动作与 `run_id` 的窗口索引可能错配；终态 Task/Revision 仍可能接收迟到同步；确认 assignment 的校验与 Task 写入分属两个事务；委托 assignment 的校验与子 Task 创建也分属两个事务。

## 修复范围

1. 使用同一个 recent Run 窗口完成读取与动作身份标记，并明确窗口外动作不进入当前进度。
2. 为 `sync` 增加 Task/Revision 生命周期 CAS 和动作单向状态迁移规则。
3. 在 Task 持有的 immediate 事务内读取当前 confirmed assignment 并完成路由写入。
4. 在 Task 持有的 immediate 事务内验证 child parent、当前 delegated assignment 并创建或复用 Task。

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

## 实际修复

- 同一个 `recent` 数组负责 Run 加载、动作标记和归并，当前投影仅包含最后 50 个 Runs。
- `sync()` 要求 Task 为 `running`、`waiting_user` 或 `revising`，Revision 为当前 `active`；动作只允许 planned 到 real 的一次升级，相同 real 幂等，其他重放冲突。
- `SessionAssignment.withCurrent()` 接受 Task 持有的事务句柄，比较完整 assignment fingerprint、active identity 与 source locator。confirmed/delegated 在 Task 写入前后各校验一次，竞争变化会回滚整个 immediate 事务。
- delegated 调用方只传 parent/session/Run/action locator，标题和正文来自 canonical assignment snapshot。

## 验证计划

- 55+ Run 窗口内每个动作的 `run_id` 与实际 Run 一致，窗口外动作不计入当前 progress。
- completed/failed Task 或非 active Revision 的迟到同步不改变数据库。
- planned 到 real 仅允许一次升级；相同 real 重放幂等，不同 real 或 real 到 planned 被拒绝。
- confirmed 与 delegated assignment 在竞争替换时无法绑定旧身份。
- `bun typecheck`、`git diff --check` 与四个相关完整测试文件通过。

## 验证结果

- Session Task：36 passed
- Session Runner：62 passed
- Session Runs：29 passed
- Session Delegation：36 passed
- 合计：163 passed，0 failed
- `bun typecheck`：通过
