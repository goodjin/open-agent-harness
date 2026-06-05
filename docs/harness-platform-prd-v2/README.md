# Harness Platform PRD v2

本文档集是 `docs/harness-platform-prd/` 的 v2 版本。

v1 已经完成作为基线 PRD 的职责：它定义了产品愿景、用户流程、协议治理、功能模块、系统架构和 Phase 0-5 验收。v2 不覆盖 v1，而是在 v1 基础上推进下一层设计：把持久化、文档化、资源引用、上下文编译、Agent 协作、任务验收、Workflow 资产、Memory 沉淀和性能基线统一到一套可恢复、可交接、低上下文消耗的 Runtime 机制中。

## v2 核心判断

Harness 不能把会话当数据库，也不能把 transcript 当模型上下文。

Runtime 接受的重要事实、状态、产物、证据、交接记录和中间过程都应进入可引用资源。模型上下文只放当前任务需要的最小 Context Bundle，包括摘要、路径、refs、约束和必要证据。

## 文档地图

| 编号 | 文档 | 作用 |
|---|---|---|
| 00 | [v2 范围与增量](00-v2-scope-and-deltas.md) | 说明 v1 已覆盖什么，v2 补什么，以及新的核心对象。 |
| 01 | [v2 里程碑与验收](01-v2-milestones-and-acceptance.md) | 定义 Resource-first 路线下的阶段目标、交付物和验收标准。 |
| 02 | [v2 执行顺序、Worktree 与 Prompt](02-execution-worktrees-and-prompts.md) | 定义里程碑并行策略、worktree 命名、合并顺序和新会话执行 prompt。 |

## 与 v1 的关系

- v1 是产品和协议基线。
- v2 是实现推进和架构细化基线。
- v1 中的 `Artifact Index`、`Context Bundle`、`Memory`、`Trace` 和 `Workflow Adapter` 在 v2 中继续保留，但会被放进更明确的 Resource / Reference / Context Compiler 机制中。

## 维护规则

- 新增协议对象时，先判断它是事实、视图、证据、资源、上下文还是策略。
- 大内容默认进入 Resource / Document，不进入 session message。
- Handoff、Workflow、Memory 和 Trace 默认引用 Resource refs，不复制完整内容。
- 每个任务都必须有 Acceptance Criteria，Runtime 根据验收标准和风险决定自动校验、Agent 审查、人工验收、组合验收或抽样审计。
- 高数据量和高并发路径必须有分页、索引、背压、缓存、异步处理和可观测指标。
- 每个 v2 里程碑都必须给出可查看、可恢复、可审计的验收方式。
