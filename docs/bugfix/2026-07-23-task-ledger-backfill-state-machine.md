# Task Ledger 懒回填状态机修复

## 问题描述

- 日期：2026-07-23
- 严重程度：Critical
- 影响范围：T-09 旧 Task Ledger 懒回填

首版 `ensure()` 把 Task 下的 Requirement、Resource 和 Event 全量加载到内存，并假设旧 Task 最多只有一个 Requirement。Flag 开启创建 v1、关闭后创建并激活 v2、再次开启时，current Revision 没有 Ledger 引用，但历史 v1 Requirement 必须保留；首版会将其误判为歧义。首版对 partial Command/Event 的恢复也没有形成完整状态机。

## 根因分析

- Requirement 的裁决依据应是 Task 当前指针、current Revision 指针和可验证的 supersedes 链，不能用 Task 下 Requirement 总数代替。
- 热路径只需要 current Requirement、current spec、baseline Event 和 migration Command，不需要扫描完整历史。
- Command 的 missing、accepted、applied 状态与 baseline Event 是否存在构成不同恢复分支；不可变 Event 已存在时只能验证和复用，不能覆盖或重复追加。

## 修复方案

1. 用 current 指针和 `max(version)` 确定下一 Requirement；Flag-off 新 Revision 缺引用时创建连续版本并 supersede Task 先前 current Requirement。
2. partial candidate 通过精确 identity 查询，并逐节点验证版本连续、同 Task、supersedes、无自引用和错误链；保留全部历史 Requirement。
3. fast path 使用精确查询、聚合、`limit` 和存在性查询，不调用全量 Ledger 列表，也不排序全部历史 Event。
4. missing Command 可创建并补齐；accepted Command 可继续，兼容 Event 已存在时复用；applied Command 只验证完整事实，缺失或漂移直接冲突。
5. baseline Event 仅保存稳定 current-snapshot identity，不保存会在后续写操作中变化的 Task/Revision 状态。
6. `get`、`current`、`open` 继续保持纯读；不实现 T-10 全量审计。

## 验证计划

1. 覆盖 Flag on v1、off v2、on ensure，并验证并发和数据库重开。
2. 覆盖多个历史 Requirement、缺号、自引用和错误 supersedes。
3. 覆盖 missing、accepted、applied-drift Command。
4. 覆盖兼容 partial Event 复用和 Event command/data 漂移。
5. 验证长 Event 历史的 fast path 只执行有界查询。
6. 运行 Ledger、Task、Recovery 差分、数据库检查和类型检查。

## 验证结果

- T-09 原有聚焦用例：8/8 通过，33 assertions。
- 新增迁移状态机用例：5/5 通过，32 assertions；Flag toggle 并发与重开用例：1/1 通过。
- Ledger 与 Task 回归：146/146 通过，688 assertions。
- Ledger、Task 与 Recovery 差分：164/165 通过，817 assertions；唯一失败为既有 `SessionControl` child scope 基线问题，Recovery 单组为 18/19，与本次改动无关。
- `bun db check` 通过。
- `bun typecheck` 通过。
- T-09 独立测试和独立审计保持 pending，待提交后复核。

## 影响文件

- `packages/opencode/src/session/task-ledger.ts`
- `packages/opencode/test/session/task.test.ts`
- `packages/opencode/test/session/task-ledger.test.ts`
- `docs/harness-module/protocol-runtime.md`
