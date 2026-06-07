# 外部 Agent Harness 资料与本协议的差异

本文对比微信文章、OpenAI 文章、Anthropic 文章与 Open Agent Harness 治理协议的关系。

## 总体判断

外部资料主要从工程实践、产品运行、长任务 agent、sandbox、eval、多 agent 经验和企业落地清单出发，回答“怎样让模型变成能工作的 agent”。

Open Agent Harness 治理协议要回答的是另一层问题：当多个模型会话、工具、workflow、UI、人工决策、记忆和长期状态共同参与任务时，系统如何用稳定对象、状态规则、权限边界和 Runtime 控制面来治理这些行为。

因此，外部资料更像组件分类和实践案例；本协议应继续保持治理总纲和通用 DSL / Runtime 协议的定位。

## 关键差异

| 维度 | 外部资料重点 | 本协议重点 | 影响 |
|---|---|---|---|
| Harness 定义 | 模型外部的所有基础设施 | 可治理的 agent operating environment | 外部定义更宽；本协议需要给出可执行对象和边界。 |
| 编排循环 | ReAct / TAO / Ralph loop / agent loop | Runtime normalization、Action、Executor、Event、Projection | 我们不把 loop 作为核心抽象，而把 loop 拆成可治理状态迁移。 |
| 工具调用 | tool schema、tool execution、observation | toolCall 归一化为 Action，再经过 policy、gate、routing、executor | 这是本协议相对外部资料最重要的收敛点。 |
| 状态管理 | checkpoint、progress file、git commit、session store | Event Log、Projection、Materialized State、Canonical Status、replay/export | 本协议对状态有更强的规范化要求。 |
| 上下文与记忆 | compaction、masking、retrieval、memory file | Context Bundle、Visibility Policy、Memory scope、Semantic interpretation | 外部资料给策略，本协议定义 Runtime 构造输入的协议对象。 |
| 多 Agent | subagent、handoff、fork、parallel agents | Agent Session、Assignment、Runtime coordination | 本协议坚持会话之间通过 Runtime 协调。 |
| 安全与权限 | guardrails、sandbox、approval、tripwire | Authority、Scope、Gate、Executor boundary | 外部资料可补充具体风险分类和 sandbox 策略。 |
| 验证与评测 | test、lint、visual feedback、LLM evaluator、eval harness | Gate、Review、Verification、Evidence、Evaluation adapter | 需要继续把 verification / eval loop 的协议字段细化。 |
| 数据底座 | trace、context、tool I/O、footprint、eval data 需要统一 | Event、Trace、Artifact、Materialized State、export | 本协议方向一致，但 trace / runtime data schema 仍需展开。 |
| 产品形态 | Harness 即产品，agent 可读性和 UI 可操作性 | UI 作为治理操作面，Command 推进状态 | UI 文档需要重点定义观察、批准、恢复、trace 和 agent manager。 |

## 与微信文章的差异

第一篇微信文章按“生产级 Harness 组件”拆解，适合作为 checklist。它讲的是一个 Harness 应该具备哪些功能面：

- 编排循环
- 工具
- 记忆
- 上下文管理
- 提示词构建
- 输出解析
- 状态管理
- 错误处理
- 护栏与安全
- 验证循环
- 子智能体编排

我们的协议不是把这些组件平铺成模块，而是把它们归入几组协议平面：

- 模型交互平面：覆盖提示词构建、输出解析、toolCall carrier、observation。
- 执行平面：覆盖工具、executor、routing、delegation。
- 状态控制平面：覆盖状态管理、事件、投影、回放和持久化。
- 上下文构造平面：覆盖记忆、上下文管理、语义解释和可见性。
- Adapter 与产品接入平面：覆盖 workflow、eval loop、release gate、long-running monitor 和 UI。

因此，微信文章比我们更偏组件百科；我们的协议更偏控制面和对象模型。

第二篇微信文章按“企业落地六大组件”拆解，适合作为沟通材料。它把 Harness Engineering 归纳为：

- 提示词系统
- 工具与技能
- 捆绑基础设施
- 编排逻辑
- 钩子与中间件
- 模型配置

这套分类与我们的协议映射关系如下：

- 提示词系统对应 Agent 模板、Context Bundle、Model-Runtime Protocol。
- 工具与技能对应 Action、Executor、Capability、Authority 和 Routing。
- 捆绑基础设施对应 Execution Layer、sandbox / workspace、Artifact、Trace 和 Materialized State。
- 编排逻辑对应 Runtime、Assignment、Workflow adapter、Gate、Decision 和 Projection。
- 钩子与中间件对应 Trigger、Gate、Verification、Review、replay / recovery 和 observation policy。
- 模型配置对应 Agent 模型偏好、runtime backend、model selection 和 cost policy。

它的价值是提醒我们：企业视角会把模型选择、成本控制、沙箱、可观测性、权限和失败处理都视为 Harness 的组成部分；协议设计需要给这些能力留下清晰对象位置。

## 与 OpenAI 的差异

OpenAI 的 Harness engineering 强调 agent-first 工程方法：仓库知识、文档结构、架构约束、可观测性、验证循环和持续清理。它关注如何让 Codex 在一个具体工程组织中持续产出。

OpenAI Agents SDK 的 model-native harness 更接近运行层：sandbox、workspace manifest、MCP、skills、filesystem tools、state externalization、snapshot / rehydration。

我们的协议与 OpenAI 的共同点：

- 都强调 agent 需要可读环境、工具、状态、恢复和验证。
- 都强调长任务需要 durable execution。
- 都重视 harness 与 compute / sandbox 的边界。

差异：

- OpenAI 文章以 Codex / SDK 产品能力为中心。
- 本协议以 provider-agnostic 的 Runtime、Action DSL、Event / Projection 和治理边界为中心。
- OpenAI 用 SDK primitives 表达能力；本协议需要定义跨模型、跨工具、跨 adapter 的规范对象。

## 与 Agent Harness Engineering 综述的关系

《Agent Harness Engineering: A Survey》提出 ETCLOVG 七层分类：Execution、Tooling、Context、Lifecycle、Observability、Verification、Governance。

这套分类与我们的协议架构基本兼容：

- Execution 对应执行平面、Executor、sandbox / workspace contract。
- Tooling 对应模型交互平面和执行平面之间的 Action / toolCall normalization / tool protocol。
- Context 对应上下文构造平面。
- Lifecycle 对应 Run、Assignment、Workflow adapter、Trigger 和 Decision。
- Observability 对应状态控制平面中的 Event、Trace、Artifact、Projection 和 export。
- Verification 对应 Gate、Review、Verification 和 evaluation loop adapter。
- Governance 对应 Authority、Scope、Command、approval、audit 和 UI 操作面。

该综述对本协议的最大补充是：Observability 和 Governance 不应只是执行流程旁边的附属能力，而应作为生产 Harness 的独立控制维度持续展开。它也提出 trace-native evaluation 和 harness coupling problem，这两点会影响状态协议、评测 adapter 和后续兼容策略。

## 与 Anthropic 的差异

Anthropic 的资料与本协议关系最直接，尤其是 Managed Agents 中的 session / harness / sandbox 解耦。

共同点：

- session 需要 durable log。
- harness 负责调用模型和路由工具调用。
- sandbox / hands 应该与 harness / brain 分离。
- 长任务需要结构化 handoff、progress、artifact 和恢复能力。
- 多 agent 需要成本意识、压缩摘要和明确适用场景。

差异：

- Anthropic 文章多是实践架构和实验结论。
- 本协议需要把这些实践上升为对象定义、状态词汇、权限模型、控制流和 adapter 规范。
- Anthropic 的某些原型使用文件锁、git commit、progress file 等工程手段；本协议应把这些统一投影成 Assignment、Event、Artifact、Projection 和 Gate。

## 对后续协议的补充建议

1. 在 `02-model-runtime-protocol.md` 中明确 prompt / context assembly 的优先级、toolCall carrier、structured output fallback、observation policy 和 recovery normalization。
2. 在 `03-action-executor-contract.md` 中细化 tool / runtime service / agent session / human / pipeline / external service 的 executor contract。
3. 在 `04-routing-and-delegation-policy.md` 中补充并行 delegation、成本、冲突、锁、scope 和 assignment lifecycle。
4. 在 `06-state-event-projection-model.md` 中补充 trace、tool I/O、runtime footprint、eval evidence、snapshot、rehydration 和 export schema。
5. 在 `07-context-memory-visibility-policy.md` 中补充 compaction、observation masking、just-in-time retrieval、memory verification 和 semantic interpretation。
6. 在 `08-workflow-profile-action-graph-assets.md` 中明确 workflow、evaluation loop、release gate、long-running monitor 如何基于 Harness 基础 DSL 表达。
7. 在 `09-ui-console-and-agent-management.md` 中强化 agent legibility：UI、logs、trace、artifact、memory、decision 和 projection 都应能被人和 Agent Session 读取。
