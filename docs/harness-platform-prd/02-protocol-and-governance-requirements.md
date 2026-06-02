# 协议与治理需求

## 1. 协议定位

本系统以 Harness 治理协议为产品和工程边界。协议规定 Runtime 如何接受模型、用户、UI、Adapter 和 Executor 的输入，如何把它们转化为 Action、Event、Projection、Trace 和 Artifact。

协议目标是建立一个可治理的 Agent operating environment。系统实现可以分阶段推进，但产品语义按本文件定义。

## 2. 治理原则

| 编号 | 原则 | 系统要求 |
|---|---|---|
| GP-001 | Runtime 控制状态变更 | Command、Action、Adapter operation 和执行结果都经 Runtime 校验、记录和投影。 |
| GP-002 | Agent Session 由 Runtime 协调 | Agent Session 之间通过 Assignment、Handoff、Artifact、Event 和 Trace 协作。 |
| GP-003 | 模型声明意图 | 模型输出目标、动作、依赖和结果偏好，Runtime 判断执行资格和执行路径。 |
| GP-004 | ToolCall 归一化为 Action | 任何 toolCall、delegation request、human approval 或 service invocation 先归一化为 Action。 |
| GP-005 | Context Bundle 由 Runtime 构造 | Runtime 根据 Projection、Memory、Artifact、Trace、约束和语义解释生成模型输入。 |
| GP-006 | Event 与 Projection 分离 | Event 是已接受历史；Projection 是当前操作视图；Materialized State 服务查询和恢复。 |
| GP-007 | Trace 是治理证据层 | Trace 连接 Action、Assignment、Executor、Artifact、Gate、Decision 和 Observation。 |
| GP-008 | Adapter 基于基础 DSL 扩展 | Workflow、Evaluation Loop、Release Gate 和 Long-running Monitor 使用统一 Action/Event/Projection 模型。 |
| GP-009 | 产物面向人和 Agent 可读 | Artifact、Trace、Projection 和 UI record 提供稳定 id、summary、refs、evidence、visibility 和 provenance。 |

## 3. 协议构件

| 构件 | 要求 |
|---|---|
| Model | 通过模型-Runtime 协议声明 Action、Answer 或 Done。 |
| Runtime | 负责 normalization、validation、routing、gate、execution control、event、projection、trace、context、recovery。 |
| Agent Template | 定义身份、入口、能力、权限策略、模型偏好、关系和编排策略。 |
| Agent Session | Runtime 创建的执行会话，绑定 Assignment、authority、session log、Context Bundle 和 trace refs。 |
| State | 由 Event Log、Projection、Materialized State、Trace、Artifact Index、Memory 和 Concept 组成。 |
| Executor | 执行 Action 的目标，包括 tool、Agent Session、Runtime service、human、pipeline 或 service。 |
| Adapter | 基于 Harness 基础 DSL 实现场景化结构，例如 Workflow 或 Evaluation Loop。 |
| UI | 读取 Projection/Trace，提交 Command，展示和推进系统状态。 |

## 4. 模型与 Runtime 协议

### 4.1 输出类型

模型到 Runtime 的输出使用扁平结构：

```ts
type ProtocolOutput =
  | { kind: "act"; message?: string; calls: Call[] }
  | { kind: "answer"; message: string }
  | { kind: "done"; message?: string }
```

字段要求：

| 字段 | 要求 |
|---|---|
| `kind` | 取值为 `act`、`answer`、`done`。 |
| `message` | 用户可见说明、进度或最终回答。 |
| `calls` | `act` 的 Action Graph 节点数组。 |

### 4.2 Call 字段

| 字段 | 要求 |
|---|---|
| `id` | 稳定 call id，用于 logs、graph、result reference 和 dependency。 |
| `type` | executor class：`tool`、`agent`、`runtime`、`human`、`pipeline`、`service`。 |
| `name` | 具体 executor target；`agent` 可使用具体 Agent id 或 `auto`。 |
| `title` | UI 和 transcript 使用的短标题。 |
| `args` | 目标 executor 的结构化输入。 |
| `depends_on` | string 或 string array，表达 Action Graph 依赖。 |
| `result` | `summary`、`full`、`structured`、`on_failure`、`on_demand` 或 `adaptive`。 |
| `criteria` | 成功标准。 |
| `failure` | retry、block、ask_user、handoff、abort 等失败偏好。 |
| `budget` | timeout、cost、tokens、attempts、parallelism、cache 等预算。 |
| `visibility` | 结果进入 model、user、logs、trace、future_runs 或 runtime_only 的规则。 |
| `artifacts` | 期望产生、读取、更新或引用的 Artifact。 |
| `handoff` | 下游交接目标、约束、依赖、证据、Artifact、预算、风险和未决问题。 |
| `context` | 需要 Runtime 展开的 Memory、Artifact、Projection 或 external refs。 |
| `gate` | approval、verification、review、privacy、release 或 budget gate。 |

### 4.3 Action Graph

系统应把 `calls[]` 解释为 Action Graph：

- 每个 call 是一个 graph node。
- `depends_on` 是 dependency edge。
- 无依赖 node 可进入 `ready`。
- 互不依赖的 ready node 可并行调度。
- Runtime 校验 duplicate id、missing dependency、cycle、权限、budget、resource lock 和 unsafe side effect。
- Workflow Profile 进入 Runtime 后也展开为同一 Action Graph。

### 4.4 ToolCall carrier 与恢复

模型可以通过 Runtime 自有 toolCall entrypoint 提交协议对象。直接 tool request 或 delegation request 满足安全条件时，Runtime 可恢复为协议 Action，并标记 `origin.kind: "recovered"`。

恢复后的 Action 进入同一 validation、routing、execution、event、projection 和 trace 路径。

## 5. Action 与 Executor

### 5.1 Action

Action 是 Runtime 接受后的可执行语义单元。内部 Action 应包含：

- `id`
- `operation`
- `origin`
- `executor`
- `args`
- `resources`
- `side_effects`
- `depends_on`
- `criteria`
- `failure`
- `permission`
- `budget`
- `result`
- `artifacts`
- `handoff`
- `visibility`
- `idempotency`
- `cancellation`

### 5.2 Executor 类型

| Type | 语义 |
|---|---|
| `tool` | 有边界的本地 tool、MCP tool 或平台 tool。 |
| `agent` | Runtime 创建 Agent Session 和 Assignment。 |
| `runtime` | Harness 内部服务，例如 summarize、checkpoint、merge、wait、projection rebuild。 |
| `human` | 用户或 Owner 澄清、审批或决策。 |
| `pipeline` | 预定义确定性多步过程。 |
| `service` | 外部系统、CI、仓库、云服务或业务 API。 |

### 5.3 执行环境

每次执行应绑定 Manifest：

- Sandbox：进程、文件系统、网络、secret 和外部服务隔离边界。
- Workspace：executor 可见工作区域。
- Manifest：cwd、读写范围、可用工具、env refs、secret refs、网络策略、artifact 输出策略、snapshot refs 和 timeout。
- Snapshot：workspace、materialized state、artifact index 或 executor state 检查点。
- Rehydration：根据 Manifest、Snapshot、Event、Projection 和 Artifact refs 重建执行环境。

## 6. Routing、Delegation 与 Handoff

### 6.1 多 Agent 适用条件

Runtime 在以下条件满足时使用多 Agent：

- 任务可分解。
- 上下文可隔离。
- 并行或专业分工收益覆盖模型、工具和协调成本。
- 子任务结果可通过 Artifact、summary、evidence、status 和 unresolved issues 聚合。
- 每个子任务有清晰 authority、contract、trace 和 handoff boundary。

### 6.2 Routing 输入

Routing 使用：

- Action operation
- executor type / target
- capability
- resources
- side effects
- Agent entry
- Agent capability
- Agent relationships
- Agent orchestration_policy
- permission policy
- availability、cost、model preference
- 当前 run state 和 dependency state

### 6.3 Assignment

当 Action 委派给 Agent Session，Runtime 创建 Assignment。Assignment 应包含：

- `id`
- `action_id`
- `agent_id`
- `capabilities`
- 生效 `authority`
- `contract`
- `context_bundle_ref`
- `status`
- `trace_refs`

模板级 metadata 不授予 authority。Runtime 根据 Action policy、run policy、用户审批和 gate requirements 推导 Assignment authority。

### 6.4 Handoff Contract

Handoff 是下游接力契约，不是执行结果本身。它应包含：

- target
- constraints
- depends_on
- evidence
- artifacts
- budget
- risks
- unresolved
- source session / source action

Runtime 使用 Handoff 创建下一个 Action 或 Assignment，并保持 Trace continuity。

## 7. Agent 模型

Agent Template 基础字段包括：

- `id`
- `name`
- `description`
- `persona`

Agent Template 应支持：

- `entry`：primary、delegable、mentionable、default、hidden。
- `capability`：purpose、tags、cost、writes。
- `permission`：permission_mode、allowed_tools、denied_tools、inherit_permissions；`inherit_permissions` 默认 false。
- `model_preference`
- `execution_mode`
- `relationships`
- `orchestration_policy`

Agent id 使用直观的 `lower_snake_case`，形态为 `<domain>_<work_type>`，例如 `frontend_developer`、`code_test`、`technical_reviewer`、`workflow_runner`。

## 8. 状态、Projection 与 Trace

### 8.1 状态对象

| 对象 | 要求 |
|---|---|
| Event | Runtime 接受的事实记录，带 seq、time、actor、type、scope、refs。 |
| Projection | 从 Event 和状态规则推导出的当前操作视图。 |
| Materialized State | 数据库行、状态文件、adapter JSON、artifact index、UI summary cache 和 executor checkpoint。 |
| Trace | 从 Event、Action、Assignment、Artifact、Gate、Decision 和 Observation 组织出的证据链。 |
| Artifact Index | 记录产物 id、来源、状态、可见性、摘要和引用位置。 |

### 8.2 规范状态词

系统统一使用：

- `draft`
- `ready`
- `running`
- `waiting_user`
- `waiting_permission`
- `blocked`
- `partial`
- `failed`
- `completed`
- `skipped`
- `cancelled`
- `aborted`

`partial` 表示已产生可用结果，但部分必要子项、验证、handoff、Artifact 或 gate 未完成或未通过。下游只能消费 Runtime 标记为可用的 Artifact，并需要处理未决部分。

### 8.3 事务边界

每个改变状态的 Command：

1. 校验 schema。
2. 校验 authority。
3. 校验 gate 和当前 Projection。
4. 追加 accepted Event。
5. 更新 Projection。
6. 发出 subscription/update event。

Projection 更新失败时，系统将 Projection 标记为 stale，并要求 rebuild 后再接受新的 mutation。

## 9. Context、Memory 与 Visibility

Runtime 构造模型输入。Agent Session 的 session log 是持久记录，Context Bundle 是每次模型调用前由 Runtime 构造出的输入。

Context Bundle 应包含：

- 当前目标和约束。
- 当前 Projection summary。
- 相关 Artifact refs。
- 相关 Memory records。
- 环境信息。
- 依赖和未决问题。
- Visibility 允许进入模型的历史证据。
- 对动态内容的语义解释提示。

Memory scope：

- `run`
- `project`
- `team`
- `global`

Visibility channel：

- `model`
- `user`
- `logs`
- `trace`
- `future_runs`
- `runtime_only`

Runtime 可以降低模型可见结果粒度以满足隐私、安全或 context budget 约束。

## 10. Workflow Adapter

Workflow 是基于 Harness 基础 DSL 的 durable orchestration adapter。

Workflow Profile 可增加 durable orchestration 所需字段：

- `nodes`
- `loop`
- `verification`
- `decision`
- `durable state`

Node 内的完成标准、失败处理、预算、可见性、Artifact 和 Handoff 使用统一字段：

- `criteria`
- `failure`
- `budget`
- `visibility`
- `artifacts`
- `handoff`

Workflow Profile 进入 Runtime 后展开为 Harness Action Graph、Action、Assignment、Contract、Artifact、Event、Projection 和 Trace。

## 11. UI 管理协议

UI 读取 Projection、Trace、Event、Artifact、Memory 和 Agent Registry。会改变系统状态的操作提交为 Command。

Command 类型包括：

- `run.create`
- `run.pause`
- `run.resume`
- `run.abort`
- `task.retry`
- `task.cancel`
- `action.retry`
- `assignment.cancel`
- `decision.answer`
- `permission.approve`
- `permission.reject`
- `verify.rerun`
- `session.message.submit`
- `session.focus`
- `agent.enable`
- `agent.disable`
- `agent.update`
- `concept.replace.request`
- `projection.rebuild.request`
- `trace.export.request`

UI 应支持用户与 root、child、descendant Agent Session 分别交互。用户输入进入 Runtime，由 Runtime 根据目标 session 的 authority、Assignment、Context Bundle 和当前 Projection 构造下一次模型调用。

## 12. 待补充协议模块

| 模块 | 目标 |
|---|---|
| Model Policy | 定义模型选择、成本预算、fallback、缓存、调用策略和 provider 约束。 |
| Evaluation Adapter | 定义 Trial、Grader、Outcome、Metric、Regression Gate 和评测 Trace。 |
| Release Gate Adapter | 定义发布前验证、审批、阻塞、回滚和证据导出。 |
| Long-running Monitor Adapter | 定义周期性检查、条件触发、状态快照、告警和恢复策略。 |
