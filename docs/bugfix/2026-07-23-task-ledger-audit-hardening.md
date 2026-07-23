# Task Ledger 审计门禁修复

## 问题描述

- 日期：2026-07-23
- 严重程度：Critical
- 影响范围：T-10 `TaskLedger.audit`

首版审计直接读取 Drizzle JSON 列，损坏 JSON 会在校验前抛错；Requirement、spec、Command family 和 terminal 的证明规则也不完整。issues 没有稳定去重，多个交叉 `filter` 使 CPU 复杂度随历史增长放大。

## 根因分析

- 读取、解码、索引和规则校验混在一个大函数中，坏行会进入后续推导。
- Requirement 只校验一个 selected 指针，未区分合法 draft 分支、orphan 和双指针缺失的唯一候选。
- Command 只验证 kind 前缀，没有按各 kind 重建稳定身份、完整 Event family 与 Revision 角色。
- terminal 只做 Event 到 Task 的单向末尾判断。
- issues 在截断前没有规范化去重，且 blocked 可能出现在输出上限之后。

## 修复方案

1. 拆分 raw read、安全 JSON decode、parsed indexes、各领域 validator 和 Collector；坏 JSON/null/strict contract 只生成 blocked issue。
2. 对全部 Task/Revision 引用 Requirement 做 memoized lineage，允许共享祖先的 draft 分支，拒绝 orphan；缺双指针只接受唯一可证明且链健康的 current candidate。
3. current spec 缺 ref 仅在唯一合法 spec Resource 存在时 repairable。
4. 为六类 Command 分别校验稳定 key、Event family 数量/顺序/角色、状态时间和 result_ref。
5. terminal 做双向 current projection 校验，要求 terminal 前有同 Command/Revision 的 result Event。
6. Collector 规范化 severity/code/entity/id/refs 后稳定去重，issues 上限 50，但最终 status 基于全部唯一 issues。
7. 预建反向索引与 memoized lineage，使 Event、Command、Requirement 校验保持线性 CPU。

## 验证计划

- 坏 JSON、JSON null 和 strict contract 漂移不抛异常。
- 双指针缺失加坏 v1 blocked；合法 draft 分支 ok；orphan blocked。
- spec 缺 ref 的 0/1/>1 候选分别 blocked/repairable/blocked。
- 六类 Command 覆盖 key ownership、family 缺失/重复/乱序和 activate 旧 Revision result。
- terminal 覆盖反向缺失、错误 Revision 和 blocked 状态。
- 重复 issue 去重；前 50 条 repairable、后续 blocked 仍返回 blocked 且 truncated。
- 大历史通过索引/调用计数证明无重复全表 filter。

## 验证结果

- audit 聚焦测试 15/15 通过，47 assertions。
- 覆盖坏 JSON、JSON null、strict contract、合法 draft 分支、orphan、坏 lineage、spec 0/1/>1 候选、plan ref、跨 Task Command key、activate result、终态反向缺失、issue 去重和截断后 blocked 优先级。
- 400 条额外 Event 的审计以 `Map.get` 调用数断言索引路径，未使用耗时阈值。
- Ledger 与 Task 回归 163/163 通过，754 assertions；数据库回归 8/8 通过，23 assertions。
- `bun db check`、`bun typecheck` 和 `git diff --check` 通过。
