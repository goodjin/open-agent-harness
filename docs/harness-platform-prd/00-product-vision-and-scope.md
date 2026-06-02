# 产品愿景与范围

## 文档信息

| 字段 | 内容 |
|---|---|
| 项目名称 | Open Agent Harness Platform |
| 文档版本 | v1.0 |
| 创建日期 | 2026-06-01 |
| 状态 | 草案 |
| 上游协议 | `docs/harness-protocol/00-harness-governance-protocol.md` 到 `09-ui-console-and-agent-management.md` |

## 1. 产品定义

Open Agent Harness Platform 是一个可治理的 Agent operating environment。

它面向多个模型会话、工具、工作流、人工决策和长期记忆共同参与任务的场景，用 Runtime 控制状态变更、权限、执行、恢复、审计和可观测性。

产品从聊天窗口扩展为受治理的任务运行系统：

```txt
User goal
  -> Runtime creates Run
  -> Model declares intent
  -> Runtime normalizes Action Graph
  -> Executor performs work
  -> Event and Projection update
  -> Trace explains what happened
  -> UI lets user observe, decide, recover and continue
```

## 2. 背景与问题

现有 Agent 产品通常以单个会话和工具调用为中心。模型可以调用工具、生成代码、输出建议，但系统很难稳定回答这些问题：

- 当前任务真实执行到哪里？
- 哪些状态变更已经被接受？
- 哪个 Agent 负责了哪一段工作？
- 工具结果如何进入后续模型上下文？
- 失败后能否从已有证据恢复？
- UI 展示的是模型说法，还是 Runtime 接受后的系统状态？
- 多 Agent 之间的交接是否有清晰目标、约束、证据和未决问题？

Harness 的产品目标是把这些问题收束到协议和 Runtime 中，让 Agent 工作从“会话输出”升级为“可治理运行”。

## 3. 产品目标

| 编号 | 目标 | 描述 |
|---|---|---|
| G-001 | Runtime 成为治理中心 | 所有状态变更、执行、权限、门禁、恢复和审计由 Runtime 接受、校验、记录和投影。 |
| G-002 | 模型意图声明化 | 模型通过 DSL 或 toolCall carrier 声明想做什么，Runtime 决定能否执行、由谁执行、如何记录。 |
| G-003 | 多 Agent 可编排 | Agent 模板定义能力和入口；Runtime 创建 Agent Session、Assignment 和 Handoff Contract 来组织协作。 |
| G-004 | 状态可恢复 | Event Log、Projection、Materialized State、Snapshot 和 Rehydration 支持失败、重启和长任务恢复。 |
| G-005 | 证据可观察 | Trace、Artifact、Event、Gate、Decision 和 Observation 形成可审计证据链。 |
| G-006 | UI 可治理 | 用户通过 Console 观察 Projection 和 Trace，通过 Command 推进、暂停、批准、恢复和导出系统状态。 |
| G-007 | Adapter 可扩展 | Workflow、Evaluation Loop、Release Gate、Long-running Monitor 等场景基于同一套 Action、Event、Projection 和 Trace 模型扩展。 |

## 4. 产品范围

### 4.1 核心能力范围

| 模块 | 范围 |
|---|---|
| Runtime Kernel | Command、Action normalization、policy/gate、routing、scheduler、event writer、projection builder、trace builder。 |
| Model Runtime Protocol | `kind/message/calls` 扁平 DSL、Action Graph、toolCall carrier、tool request recovery、Runtime Observation。 |
| Agent System | Agent Template、Agent Session、Agent Registry、Capability、Permission profile、Relationship、Orchestration Policy。 |
| Execution System | Tool、Agent Session、Runtime Service、Human、Pipeline、External Service executor；Sandbox、Workspace、Manifest、Snapshot、Rehydration。 |
| State System | Event Log、Projection、Materialized State、Trace、Artifact Index、canonical status、replay、export、recovery。 |
| Context System | Context Bundle、Memory、Visibility Policy、Semantic Interpretation、redaction。 |
| Workflow Adapter | Workflow Profile、DAG nodes、bounded loop、verification gate、durable state、workflow trace。 |
| UI Console | Run Console、Agent Session Workbench、Agent Manager、Protocol Panel、Workflow Panel、Governance View。 |
| API / SDK | Runtime API、Command API、Projection query、trace export、agent management、adapter operation。 |

### 4.2 产品边界

Harness 平台聚焦协议、Runtime、执行治理、状态、上下文和 UI 管理。外部模型、外部工具、云服务、CI、代码仓库、评测系统和审批系统通过 adapter 或 executor 接入。

系统应提供清晰的扩展点，而不是把每个外部系统的业务语义写死在 Runtime Kernel 中。

## 5. 核心对象

| 对象 | 产品含义 |
|---|---|
| Run | 用户目标的一次受治理运行。 |
| Agent Template | 可复用 Agent 定义，包含身份、入口、能力、权限策略、模型偏好和编排策略。 |
| Agent Session | Runtime 基于 Agent Template 创建的执行会话，绑定 Assignment、authority、session log 和 trace。 |
| Command | 用户或 UI 提交的状态变更请求。 |
| Action | Runtime 接受后的可执行语义单元。 |
| Action Graph | 由 Action 节点和 `depends_on` 边组成的可调度图。 |
| Executor | 执行 Action 的目标，包括 tool、Agent Session、Runtime service、human、pipeline 或 service。 |
| Assignment | Action 被委派给 Agent Session 后形成的任务边界。 |
| Contract | Action 或 Assignment 的目标、约束、依赖、证据、预算、风险和结果要求。 |
| Handoff | 从一个执行者交给下游执行者的结构化交接契约。 |
| Event | Runtime 接受的状态变更事实。 |
| Projection | 从 Event 和状态规则推导出的当前操作视图。 |
| Trace | 围绕 run、action、assignment、executor、artifact、gate、decision 和 observation 组织的证据链。 |
| Artifact | Action 或 Executor 产生的可引用产物。 |
| Context Bundle | Runtime 为一次模型调用或 Assignment 构造的结构化输入包。 |
| Memory | 可跨 run、project、team 或 global scope 检索的经验和偏好记录。 |
| Workflow Profile | Workflow Adapter 使用的场景化 durable orchestration 描述。 |

## 6. 成功指标

| 指标 | 目标 |
|---|---|
| 可追溯性 | 每个 Run 都能从 UI 查看 Action Graph、Assignment、Event、Projection、Trace 和 Artifact refs。 |
| 可恢复性 | Runtime 重启后可从 Event、Materialized State、Snapshot 和 Artifact Index 恢复未完成 Run。 |
| 协议一致性 | 模型 DSL、toolCall recovery、Workflow Adapter、UI Command 最终进入统一 Action/Event/Projection 路径。 |
| 上下文质量 | 模型默认接收 Context Bundle 的摘要、引用、Projection 和 Memory，而不是完整无关 transcript。 |
| 多 Agent 可控性 | 每个 Agent Session 有独立 Assignment、authority、session log、Context Bundle 和 trace。 |
| 用户治理效率 | 用户可在 UI 中定位阻塞原因、回答 Decision、批准权限、重试 Action、导出 Trace。 |
| Agent 可读性 | Artifact、Trace、Projection 和 UI records 具备稳定 id、summary、refs、evidence、visibility 和 provenance。 |

## 7. 产品原则

### 7.1 Runtime 控制状态变更

所有会改变系统状态的请求进入 Runtime，由 Runtime 校验、执行、记录和投影。

### 7.2 Agent Session 之间由 Runtime 协调

Agent Session 不直接互相通信。协作通过 Action、Assignment、Handoff、Event、Projection 和 Artifact 发生。

### 7.3 模型声明意图

模型声明目标、动作、依赖、结果偏好和上下文需求。Runtime 判断能否执行、如何执行、如何记录。

### 7.4 ToolCall 归一化为 Action

ToolCall 是承载方式。协议边界是 Action。恢复后的 tool request 也进入同一套 Action validation 和 execution path。

### 7.5 状态记录与操作视图分离

Event 是已接受历史。Projection 是当前操作视图。Materialized State 用于快速查询、调度、展示和恢复。

### 7.6 产物同时面向人和 Agent

系统产物需要让用户看懂，也要让后续 Agent Session 能读取、引用、审查和复用。
