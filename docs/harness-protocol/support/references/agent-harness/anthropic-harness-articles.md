# Anthropic Harness 相关文章

本文件索引 Anthropic 官网中与 Open Agent Harness 设计相关的文章。

## Effective harnesses for long-running agents

- 来源：https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- 发布时间：2025-11-26
- 主题：跨多个上下文窗口的长任务 harness。

要点：

- 长任务失败常见于两类情况：模型试图一次性完成过多工作；后续会话看到已有进展后过早宣布完成。
- 文章提出 initializer agent + coding agent 的两阶段结构。
- initializer agent 准备 init script、progress file、feature list 和初始 commit。
- 后续 coding agent 读取进度、选择下一步、做增量工作，并留下结构化交接信息。
- 这与我们的 Agent Session、Assignment、Artifact、Context Bundle、Projection 和 durable workflow adapter 方向一致。

## Scaling Managed Agents: Decoupling the brain from the hands

- 来源：https://www.anthropic.com/engineering/managed-agents
- 发布时间：2026-04-08
- 主题：Managed Agents 的接口化与 brain / hands / session 解耦。

要点：

- Anthropic 把 agent 组件虚拟化为 session、harness、sandbox。
- session 是追加式日志；harness 是调用模型并路由工具调用的循环；sandbox 是执行代码和文件操作的环境。
- harness 与 sandbox 分离后，sandbox 可以失败、替换、扩展，session 仍可恢复。
- 这与我们的 Runtime / Event Log / Executor / Agent Session / Materialized State 分层高度一致。

## Harness design for long-running application development

- 来源：https://www.anthropic.com/engineering/harness-design-long-running-apps
- 发布时间：2026-03-24
- 主题：长时间应用开发中的 planner / generator / evaluator 多 agent harness。

要点：

- 文章强调复杂任务中的上下文焦虑、上下文重置、结构化 handoff 和外部 evaluator。
- generator 负责生产，evaluator 负责独立评估，planner 负责展开目标。
- 对我们有两个启发：Verification / Review 应作为协议对象存在；多 Agent 协作需要 Runtime 明确管理 Assignment、Evidence 和 Decision。

## Demystifying evals for AI agents

- 来源：https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- 发布时间：2026-01-09
- 主题：Agent eval 的结构、术语和实践。

要点：

- Agent eval 需要记录完整 trace / trajectory、工具调用、中间结果和最终环境状态。
- Evaluation harness 是运行 eval、记录步骤、评分和聚合结果的基础设施。
- Agent harness 和 model 需要一起评估。
- 这支持我们把 evaluation loop 定位为 Harness 基础 DSL 上的 adapter，并把 trace/export/evidence 纳入状态协议。

## How we built our multi-agent research system

- 来源：https://www.anthropic.com/engineering/multi-agent-research-system
- 发布时间：2025-06-13
- 主题：多 Agent research 系统。

要点：

- 多 Agent 对 breadth-first research 价值明显，尤其适合多个独立方向并行搜索。
- 子 Agent 用独立上下文窗口探索，再把压缩摘要交给 lead agent。
- 多 Agent 会显著增加 token 和工具调用成本，不适合强共享上下文或强依赖任务。
- 这支持我们在协议中强调 Runtime delegation、Assignment、Context Bundle 和结果压缩，而不是让 Agent 会话直接通信。

## Building a C compiler with a team of parallel Claudes

- 来源：https://www.anthropic.com/engineering/building-c-compiler
- 发布时间：2026-02-05
- 主题：并行 Claude agent team 的长任务原型。

要点：

- 多个 Claude Code session 在共享代码库上并行工作。
- 原型使用循环、容器、git、task lock 文件和上游仓库同步来协调工作。
- 文章承认该原型缺少更完整的高层目标管理和 agent 间通信模型。
- 对我们而言，它是“为什么需要 Runtime 管理 Assignment、锁、状态、冲突和 trace”的直接案例。

