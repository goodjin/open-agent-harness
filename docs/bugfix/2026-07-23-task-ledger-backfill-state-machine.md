# Task Ledger 懒回填状态机修复

## 问题描述

- 日期：2026-07-23
- 严重程度：Critical
- 影响范围：T-09 旧 Task Ledger 懒回填

首版 `ensure()` 把 Task 下的 Requirement、Resource 和 Event 全量加载到内存，并假设旧 Task 最多只有一个 Requirement。Flag 开启创建 v1、关闭后创建并激活 v2、再次开启时，current Revision 没有 Ledger 引用，但历史 v1 Requirement 必须保留；首版会将其误判为歧义。首版对 partial Command/Event 的恢复也没有形成完整状态机。

第一次修复后，complete `task.created` fast path 和 applied migration replay 仍在调用全链校验前返回。当 Task 与 current Revision 同时指向正文正确但 `supersedes` 损坏的 Requirement 时，两条路径会把坏链误判为可重放。

## 根因分析

- Requirement 的裁决依据应是 Task 当前指针、current Revision 指针和可验证的 supersedes 链，不能用 Task 下 Requirement 总数代替。
- 热路径只需要 current Requirement、current spec、baseline Event 和 migration Command，不需要扫描完整历史。
- Command 的 missing、accepted、applied 状态与 baseline Event 是否存在构成不同恢复分支；不可变 Event 已存在时只能验证和复用，不能覆盖或重复追加。
- 双指针指向同一 Requirement 只能证明 current identity 一致，不能证明从 current 到 v1 的完整版本链有效。

## 修复方案

1. 用 current 指针和 `max(version)` 确定下一 Requirement；Flag-off 新 Revision 缺引用时创建连续版本并 supersede Task 先前 current Requirement。
2. partial candidate 通过精确 identity 查询；complete、applied 与 partial 三条路径统一在返回或写入前验证完整版本链。
3. 用单条 SQLite recursive CTE 验证 current id/version、同 Task、每跳 `version - 1`、终点 v1、终点 `supersedes=null`、无缺号/错误跳转/循环和深度越界；只返回结构化校验结果，不把完整 Requirement 链加载到应用内存。
4. fast path 使用精确查询、聚合、`limit` 和存在性查询，不调用全量 Ledger 列表，也不排序全部历史 Event。
5. missing Command 可创建并补齐；accepted Command 可继续，兼容 Event 已存在时复用；applied Command 只验证完整事实，缺失或漂移直接冲突。
6. baseline Event 仅保存稳定 current-snapshot identity，不保存会在后续写操作中变化的 Task/Revision 状态。
7. `get`、`current`、`open` 继续保持纯读；不实现 T-10 全量审计。

## 验证计划

1. 覆盖 Flag on v1、off v2、on ensure，并验证并发和数据库重开。
2. 覆盖多个历史 Requirement、缺号、自引用和错误 supersedes。
3. 覆盖 missing、accepted、applied-drift Command。
4. 覆盖兼容 partial Event 复用和 Event command/data 漂移。
5. 验证长 Event 历史的 fast path 只执行有界查询。
6. 覆盖 Task 与 Revision 双指针均指向坏 v2 的 `task.created` complete fast path 和 applied migration replay，分别验证 null、自引用及错误 supersedes 均被拒绝。
7. 运行 Ledger、Task、Recovery 差分、数据库检查和类型检查。

## 验证结果

- T-09 原有聚焦用例：8/8 通过，33 assertions。
- 迁移状态机用例：7/7 通过，47 assertions；其中新增 complete `task.created` 与 applied migration replay 坏链用例 2/2 通过，覆盖 null、自引用和错误跳转共 6 个场景。
- Flag toggle 并发与重开用例：1/1 通过。
- Ledger 与 Task 回归：148/148 通过，707 assertions。
- Ledger、Task 与 Recovery 差分：166/167 通过，832 assertions；唯一失败为既有 `SessionControl` child scope 基线问题，Recovery 单组为 18/19，与本次改动无关。
- `bun db check` 通过。
- `bun typecheck` 通过。
- 上一轮独立审计已指出逐节点查询的非阻塞性能问题，本轮以 recursive CTE 一并消除；本轮 T-09 独立测试和独立审计仍保持 pending，待提交后重新复核。

## 影响文件

- `packages/opencode/src/session/task-ledger.ts`
- `packages/opencode/test/session/task.test.ts`
- `packages/opencode/test/session/task-ledger.test.ts`
- `docs/harness-module/protocol-runtime.md`
