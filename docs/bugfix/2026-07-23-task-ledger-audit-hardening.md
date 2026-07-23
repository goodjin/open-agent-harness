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

### 第二轮独立门禁修复

8. Command identity 按可证明程度分层：`task.create`、`revision.activate`、`task.migrate` 从持久事实精确重建；`task.revise` fallback、`task.workflow.sync`、`task.finish` 的正文摘要无法从紧凑 Event 完整重建，只校验固定 kind、精确 Task/Revision ownership 前缀与 64 位十六进制 suffix，不用 Event 摘要冒充原始正文。
9. `task.create` 镜像真实写路径的 assignment、handoff、delegation 完整/降级、legacy 完整/降级、user message/降级分支，并用同 kind 跨 Task 反例验证 ownership。
10. `current_revision_id` 缺失且只有一个 active Revision 时，将它作为 derived current 继续 Requirement、spec、plan 和 terminal 审计；派生指针本身是 repairable，但派生目标的冲突仍使最终结果 blocked。
11. accepted Command 不再跳过 Event role 校验。零 Event、合法不完整 family 与合法完整但尚未 apply 分别记录可修复状态；已有 Event 的 type prefix、数量上限、顺序、Revision ownership 与 activate previous 关系都必须成立。
12. 缺 Task Requirement 指针但 current Revision 指针存在时，issue 定位到 Task，而不是把 Requirement id 标成 Revision。
13. 同步 M0 计划、feature output files 与实际交付规模；保留原估算记录，新增 actual 说明。

## 验证计划

- 坏 JSON、JSON null 和 strict contract 漂移不抛异常。
- 双指针缺失加坏 v1 blocked；合法 draft 分支 ok；orphan blocked。
- spec 缺 ref 的 0/1/>1 候选分别 blocked/repairable/blocked。
- 六类 Command 覆盖 key ownership、family 缺失/重复/乱序和 activate 旧 Revision result。
- terminal 覆盖反向缺失、错误 Revision 和 blocked 状态。
- 重复 issue 去重；前 50 条 repairable、后续 blocked 仍返回 blocked 且 truncated。
- 大历史通过索引/调用计数证明无重复全表 filter。
- 健康 workflow sync 不误报；create delegation/legacy fallback 与同 kind 跨 Task key 被区分。
- derived current 仍能发现坏 spec、坏 lineage 与 terminal 漂移。
- accepted family 覆盖零 Event、合法 prefix、完整未 apply、超长/乱序和 Revision role 冲突。

## 验证结果

- audit 聚焦测试 19/19 通过，61 assertions。
- 覆盖坏 JSON、JSON null、strict contract、合法 draft 分支、orphan、坏 lineage、spec 0/1/>1 候选、plan ref、跨 Task Command key、activate result、终态反向缺失、issue 去重和截断后 blocked 优先级。
- 400 条额外 Event 的审计以 `Map.get` 调用数断言索引路径，未使用耗时阈值。
- Ledger 与 Task 回归 167/167 通过，768 assertions；数据库回归 8/8 通过，23 assertions。
- `bun db check`、`bun typecheck` 和 `git diff --check` 通过。
