# Task Read Model Security And Concurrency Fixes

## 问题描述

- 日期：2026-07-17
- 严重程度：Critical / High
- 影响范围：Task canonical result、`.harness` Task 文档投影、Revision manifest、跨进程 draft 创建

Task 读取与文档投影存在四组边界问题：delegated result 未完整验证 canonical ActionResult；文档发布在目录校验后仍可能遭遇 symlink 替换；旧 Revision 的异步投影可能覆盖新 manifest；跨进程 draft 测试缺少确定性起跑屏障，并可能暴露 SQLite transient busy。

## 根因与验证路径

1. `SessionRuns` 从 `SessionResult` 读取 `raw.input.result`，没有复用 `ActionResult.stored()` 校验完整结构与 `action_id`。
2. `TaskDocuments.publish()` 先按路径 `lstat`，随后仍按同一路径写临时文件和 rename，校验与使用之间存在窗口。
3. manifest 内容来自 effect 入参，没有在发布锁内重新读取当前 DB Revision。
4. 跨进程测试由进程启动时序碰运气，无法区分版本竞争、数据库迁移启动和 transient busy。

每项修复先增加真实行为测试并观察失败，再实施最小修复。安全测试使用真实目录、symlink 和跨进程 barrier，不以 mock 代替文件系统或 SQLite 行为。

## 修复方案

- delegated result 通过 canonical ActionResult schema 解析，并验证 stored `action_id` 与 SessionResult identity 一致；fallback 使用严格 Zod 边界。
- Task 文档发布记录祖先目录的 canonical path、device 和 inode；临时文件以 exclusive/no-follow 方式创建，rename 前重新验证祖先与临时 inode，目录变化时拒绝发布并清理。
- 为每个 Task 增加跨进程有界文件锁；锁内读取 DB 当前 Revision 后生成 manifest，旧 effect 只发布自己的 immutable revision 文档。
- 跨进程 draft 测试增加 barrier；若证据确认是 `SQLITE_BUSY/LOCKED`，只对该错误做有界重试，唯一性冲突仍由事务约束处理。

## 验证计划

1. canonical ActionResult 与 malformed fallback RED/GREEN。
2. 中间目录 symlink swap 不写出项目外文件。
3. 反转旧、新 Revision effect 顺序，manifest 始终指向 DB 当前 Revision。
4. barrier 驱动的跨进程 draft 测试区分 transient busy 与版本唯一性。
5. `task.test.ts` 与 `runs.test.ts` 连续至少三轮通过。
6. `bun typecheck` 与 `git diff --check` 通过。

## 设计约束

- 保持 `SessionRuns.get/list` 的兼容行为。
- 保持 Task persisted result 不读取 transcript。
- 数据库正文与 current Revision 指针仍是权威记录；文档投影只能从 DB 重建，不能反写。

## 验证结果

- canonical ActionResult 缺字段、raw action id 不一致和非 canonical fallback 均被拒绝；合法结果保持可读。
- 在祖先目录校验后将 `revisions` 替换为项目外 symlink，发布返回失败，项目外未生成 `task.md`。
- 两个进程按新 Revision、旧 Revision 的顺序执行投影，最终 manifest 仍指向 DB current Revision。
- Task 级 manifest 锁等待上限为 2 秒；超过 30 秒的锁按原子 rename 后清理，锁所有权以 device/inode 校验。
- draft 并发失败证据为 transient `task_revision_locked`；仅该类错误执行 5 次以内指数退避，唯一性冲突不重试。
- `task.test.ts` 与 `runs.test.ts` 连续三轮均为 46 pass、0 fail；每轮 241 个断言。
