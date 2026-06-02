# Harness 治理协议总纲

本文档是 Open Agent Harness 的治理协议总纲。它按顺序说明协议目标、设计原则、协议架构、控制流、决策边界、Workflow/UI 定位、共享字段、状态词、对象定义、待讨论问题和文档地图。

`01` 到 `09` 是本总纲的分章详细协议，分别展开 Agent、Skill 导入、模型-Runtime 交互、Action/Executor、Routing/Delegation、状态、上下文、Workflow Adapter 和 UI 管理。总纲聚焦稳定抽象和关系边界。

## 协议目标

Harness 的目标是建立一个可治理的 agent operating environment。

它面向多个模型会话、工具、工作流、人工决策和长期记忆共同参与任务的场景，让系统保持可控、可审计、可恢复。

## 设计原则

### 1. Runtime 控制状态变更

所有会改变系统状态的请求都必须由 Runtime 接受、校验、执行和记录。

Runtime 接受结构化 Command、Action 或 adapter operation，并据此推进 run、修改任务状态、批准审查或替换概念。

### 2. Agent 会话之间不直接通信

Agent 会话之间的通信和协作由 Runtime 控制协调。

Runtime 通过 Action、Assignment、Event、Projection 和 Artifact 建立协作关系、记录协作过程、推进协作状态。

Agent 模板可以声明默认编排策略，但编排仍由 Runtime 评估、创建和执行。Agent 会话不会因为编排策略而直接调用其他 Agent 会话。

### 3. 意图采用声明式

模型声明想做什么，而不是直接调用具体工具。Runtime 判断是否允许，再决定如何执行、如何记录结果。

Harness 通过一套 DSL 供模型声明 semantic action graph。Runtime 负责解析、校验、执行、存储、投影和恢复。

为了利用当前模型能力，模型可以使用现有 toolCall 机制表达意图。toolCall 进入 Runtime 后统一归一化为协议对象。

### 4. Tool Call 归一化为 Action

Tool call 先归一化为 Action，再通过 Runtime 获得执行资格。

任何模型侧请求、工具调用、Agent delegation、Runtime operation、human approval 或 adapter operation，在执行前都必须归一化为 Harness `Action`，再经过 policy、gate、executor、event、projection。

```txt
model intent
  -> normalized Action
  -> policy and gate checks
  -> executor invocation
  -> result
  -> event and projection
```

### 5. 会话上下文由 Runtime 智能构造

Runtime 根据场景动态构造会话上下文，让模型在合适的信息环境中判断和生成输出。

比如可以主动补充记忆、环境信息、当前 Projection、相关 Artifact、约束、依赖和历史证据，还可以对会话中产生的动态内容进行语义解释后生成结构化提示，用于辅助模型理解这些内容是什么原因生成的，代表什么含义。

### 6. 状态记录与操作视图分离

Runtime 将被接受的状态变更记录为 Event，并从 Event 和状态文件推导当前 Projection。

Projection 是 Runtime、Agent Session 和 UI 的默认操作视图；Event Log 用于审计、回放、调试和恢复。

### 7. Trace / Observability 是治理证据层

Trace 是 Runtime 从 Event、Action、Assignment、executor invocation、Artifact、Gate、Decision 和 observation 中组织出的可观察证据链。

Observability 是 Harness 治理能力的一部分，用于解释系统为什么执行、执行到了哪里、哪个环节失败、哪些证据支撑当前 Projection，以及如何审计、评测和恢复。

### 8. 场景编排通过 Adapter 扩展

Harness 基础 DSL 提供通用语义表达。针对常见场景，可以定制场景化结构、模板和约束，例如 Workflow、evaluation loop、release gate、long-running monitor。

这些场景化结构最终由 Runtime 按统一的 Action、状态迁移和事件投影模型执行。

### 9. 协议产物面向人和 Agent 可读

Artifact、Trace、Projection 和 UI 视图都需要提供稳定 id、结构化摘要、状态、引用、来源、证据和可见性信息。

这些产物既服务人类观察和治理，也服务后续 Agent Session 读取、接续、审查和复用。

## 协议架构

协议架构说明 Harness 的协议构件、运行平面和分层边界。

### 协议构件

Harness 协议由六类协议构件协同工作：

- **Model**：负责判断、规划、解释和产生产物，通过模型-Runtime 协议声明意图。
- **Runtime**：负责状态、权限、调度、执行、门禁、持久化、审计和恢复。
- **Agent**：可复用执行模板。Runtime 基于 Agent 模板创建会话，由会话接收 assignment，并在授权上下文中完成具体工作。Agent 模板可以声明默认 Orchestration Policy，供 Runtime 主动评估前置准备、完成后验证、失败恢复、风险审查和冲突仲裁。
- **State**：通过 Event Log、Projection、Trace、Artifact、Memory 和 Concept 表示可审计系统状态。
- **Adapter**：在 Harness 协议之上实现 Workflow、release gate、evaluation loop、long-running automation 等编排形态。
- **UI**：负责观察、管理、批准、暂停、恢复和追溯，通过 Command 推进系统。

### 运行平面

运行平面说明协议构件如何沿运行链路协作，覆盖用户输入、模型声明、Runtime 归一化、执行、状态持久化、投影更新和产品观察。

由五个平面组成。

```txt
Model interaction plane
  Model
  -> Model-Runtime Protocol
  -> Action declaration / answer / recovery input

Execution plane
  Runtime
  -> Normalize
  -> Validate
  -> Route
  -> Gate
  -> Assign
  Executor
  -> Tool / Agent Session / Runtime Service / Human / Pipeline

State plane
  -> Event Log
  -> Projection
  -> Trace
  -> Artifact
  -> Concept

Context construction plane
  -> Context Bundle
  -> Memory
  -> Visibility Policy

Adapter and product access plane
  Adapter -> Workflow / Evaluation loop / Release gate / Long-running automation
  UI -> Command / Approval / Observation
```

#### 模型交互平面

模型与 Runtime 的交互由 `03-model-runtime-protocol.md` 定义。

该协议定义了：

- 模型如何声明 Action、依赖、上下文引用和结果策略？
- 当模型不遵循协议仍然输出 toolCall 时，Runtime 如何把直接 tool request 安全恢复为协议 Action？
- Runtime 如何把结果重新呈现为精简 observation，而不仅仅是原样塞回会话？
- 如何兼容模型的特点，利用 toolCall 机制来实现协议。

#### 执行平面

执行平面由 `04-action-executor-contract.md` 和 `05-routing-and-delegation-policy.md` 定义。

- **Action**：Runtime 接受后的可执行语义单元，描述要执行什么操作、携带什么参数、涉及哪些资源、具有什么 side effect、期望什么结果返回策略，以及建议由哪类 executor 执行。所有模型请求、toolCall、delegation request、runtime operation 或 human approval 在执行前都归一化为 Action。
- **Executor**：执行 Action 的统一抽象，表示由哪类执行者完成这个 Action。具体目标可以是 tool、Agent Session、runtime service、human、pipeline 或 external service。Executor 的执行环境契约覆盖 Sandbox、Workspace、Manifest、Snapshot 和 Rehydration。
- **Routing**：Runtime 把 Action 绑定到具体 executor 的选择过程。Routing 根据 operation、executor hint、资源范围、side effect、权限、可用性、成本、agent entry/capability 和当前 run state 做选择，并记录选择结果。
- **Delegation**：Routing 选择 Agent Session 作为 executor 时形成的执行形态。Runtime 基于 Agent 模板创建会话，生成 Assignment，并记录 child session trace；Assignment 是 Action 绑定给 Agent Session 后形成的执行边界。

#### 状态控制平面

状态控制平面定义 Harness 中状态如何被记录、投影、读取、同步和恢复，由 `06-state-event-projection-model.md` 定义。

它通过以下对象和机制控制状态：

- **Event**：状态变更记录，说明发生了什么，用于审计、回放和恢复。
- **Projection**：当前操作视图，由 Event 和状态规则推导，供 Runtime、Agent Session 和 UI 读取。
- **Trace / Observability**：围绕 run、action、assignment、executor、artifact、gate、decision 和 observation 组织出的可观察证据链，供 UI、审计、调试、评测和恢复使用。
- **Materialized state**：状态的持久化形态，例如数据库行、状态文件、adapter JSON、索引文件和 UI summary，用于快速查询、展示、调度和恢复。
- **Canonical status**：统一状态词汇，例如 `ready`、`running`、`blocked`、`partial`、`completed`，用于对齐 run、action、assignment、adapter 的状态含义。
- **Transaction / replay / export**：状态控制机制，定义状态如何安全写入、如何从历史重建、如何导出为可审计 trace。

#### 上下文构造平面

上下文构造平面定义 Runtime 如何根据当前场景组织模型输入，由 `07-context-memory-visibility-policy.md` 定义。

它通过以下对象和机制运行：

- **Context Bundle**：一次模型调用或 assignment 的结构化输入包。Runtime 将当前会话内容、Projection、环境信息、Artifact refs、约束、依赖、相关 Memory 和语义解释提示组织到 Context Bundle 中，供模型判断和生成输出。
- **Memory**：上下文构造的一类内容来源。Runtime 可以从 run、project、team、global 等 scope 检索相关记忆，并以带 scope、status、evidence refs 和 freshness 信息的记录形式加入 Context Bundle。
- **Visibility Policy**：定义同一份信息如何进入不同通道，例如 model context、UI、logs、future memory 或 runtime-only control。Runtime 根据 visibility 决定内容是摘要、结构化提示、引用、完整输出还是仅作为内部控制信息使用。
- **Semantic interpretation**：Runtime 可以对会话中产生的动态内容生成结构化解释，说明这些内容是什么原因生成的、代表什么含义、与当前 Projection 或历史证据有什么关系，用于辅助模型推理。

#### Adapter 与产品接入平面

Workflow adapter 由 `08-workflow-durable-orchestration-adapter.md` 定义。UI 由 `09-ui-console-and-agent-management.md` 定义。

它们回答：

- Workflow 如何在 Harness 上表达 durable DAG orchestration？
- Workflow Runner agent 如何创建和决策 workflow run？
- UI 如何展示 run、task、decision、event、memory、concept、agent manager 和 session tree？
- 用户如何通过 Command 推进系统状态？

### 分层边界

分层边界用于确定责任归属、状态归属和跨层接口。子协议设计字段、状态机和 UI 行为时，应沿用这组归属关系。

| Layer | 拥有内容 | 跨层接口 |
|---|---|---|
| Model Layer | 判断、计划、协议声明、用户可见解释 | 协议输出、DSL 声明、回答、恢复输入 |
| Runtime Layer | 状态迁移、权限校验、调度、门禁、事件追加、投影更新、恢复 | `Command`、`Action`、`Assignment`、`Event`、`Projection` |
| Execution Layer | 工具、Agent 会话、Runtime 服务、人工批准、流水线、外部服务 | 执行器调用、执行结果、产物 |
| State Layer | Event Log、Projection、Trace、Artifact、Memory、Concept、Adapter 状态 | 状态查询、上下文引用、trace/export 引用 |
| Adapter Layer | Workflow、evaluation loop、release gate、long-running automation | 场景化操作、Adapter 状态投影 |
| Product Layer | Harness Console、Session Tree、Agent Manager、Protocol Panel | UI 命令、批准、观察、trace 视图 |

## 控制流

Harness 的标准执行链路是：

```txt
User request
  -> Runtime creates or updates Run intent
  -> Model declares answer or protocol output
  -> Runtime returns answer, or normalizes protocol output into Action
  -> Runtime validates policy and gates
  -> Runtime routes Action to Executor
  -> Runtime creates Assignment when delegating to Agent Session
  -> Executor returns result
  -> Runtime stores artifact and appends Event
  -> Runtime updates Projection
  -> Model receives concise observation when needed
  -> UI observes Projection and trace
```

关键点：

- 模型输出先进入 Runtime normalization。
- 工具结果通过 Runtime observation policy 进入下一轮模型上下文。
- Executor 是执行 Action 的目标；Assignment 是 Action 被委派给 Agent 会话时形成的任务边界。
- Agent delegation 通过 Runtime Assignment 发生。
- UI 中会改变系统状态的操作必须提交为 Command，由 Runtime 校验、执行并记录。
- Adapter 状态必须投影回统一 Harness run state。

## 决策边界与升级规则

Harness 按风险、影响半径、可逆性和价值判断含量确定决策边界。Runtime 可以直接处理确定性执行；局部可逆执行可以交给授权执行者；影响目标、约束、架构、长期概念或 owner 偏好的决策需要升级。

分级如下：

| Level | 含义 | 典型处理 |
|---|---|---|
| L0 | 确定性执行 | Runtime 或 deterministic tool 直接处理。 |
| L1 | 局部可逆执行 | 授权执行者可在授权 scope 内处理。 |
| L2 | 影响局部工程质量 | 授权评估者或决策者审查后推进。 |
| L3 | 影响目标、约束、架构或长期概念 | 授权决策者必须显式记录理由。 |
| L4 | 影响 owner 偏好、成本、风险或不可逆外部后果 | 需要 human owner 或等价授权。 |

子协议可以细化 gate，但应保持同一套升级语义。

## Workflow 定位

Workflow 是基于 Harness 基础 DSL 的 durable orchestration adapter。

它适合：

- 多阶段任务
- 并行子任务
- 多 Agent 执行
- 可恢复运行
- 失败后 retry、replan、decision
- 用户需要进度、暂停、恢复和审计

Workflow Profile 的 DAG、node、loop、verification、artifact、decision 和 handoff 都基于 Harness 基础 DSL 表达。Runtime 将它们展开为 Action Graph、Action、Assignment、Event、Projection、Trace 和 Artifact，并投影到统一 run state。

## UI 定位

UI 是 Harness 治理能力的操作面。

UI 读取 Projection、Event、Artifact、Trace、Memory 和 Concept。UI 中会改变系统状态的操作提交 Command，由 Runtime 执行状态变更。

UI 视图、Trace export 和 Artifact summary 需要保持 agent-readable：提供稳定引用、结构化摘要、状态、来源、证据和可见性信息，让人类和后续 Agent Session 都能理解和复用。

UI 需要展示：

- run 当前状态
- task 和 assignment 进度
- blocker 和 pending decision
- gate 失败原因
- artifact 和 evidence
- child session trace
- memory 和 concept 的来源
- agent 配置、entry、capability 和 permission

## 共享字段与状态词

### 统一字段

模型 DSL、Action、Assignment Contract、Handoff Contract 和 Adapter Profile 使用同一组治理字段。字段名保持短、稳定、模型友好；概念解释保留完整语义名称。

| 字段 | 语义对象 | 用途 |
|---|---|---|
| `depends_on` | Action Graph Edge | 声明当前工作依赖哪些上游 call、Action、node、Artifact 或 Decision。 |
| `criteria` | Success Criteria | 声明完成标准，供 Runtime、Executor、Gate、Review、UI 判断是否完成。 |
| `failure` | Failure Policy | 声明失败、阻塞或验证未通过后的处理路径，例如 retry、block、ask_user、handoff、abort。 |
| `budget` | Budget Policy | 声明成本、时间、token、attempt、parallelism、缓存和外部资源约束。 |
| `visibility` | Visibility Policy | 声明结果进入 model context、user UI、logs、trace、future runs 或 runtime-only control 的方式。 |
| `artifacts` | Artifact Contract | 声明期望产生、读取、更新或引用的 Artifact 类型、名称、scope、visibility 和 evidence 要求。 |
| `handoff` | Handoff Contract | 声明下游交接目标、约束、依赖、证据、Artifact、预算、风险和未决问题。 |
| `context` | Context Request | 声明需要 Runtime 选择、展开或摘要的 memory、artifact、projection、trace 或 environment refs。 |
| `gate` | Gate Policy | 声明 approval、verification、review、privacy、release gate 等状态迁移条件。 |
| `result` | Result Policy | 声明执行结果回放给模型、用户、日志和 Artifact store 的粒度。 |

这些字段在不同层表达同一语义。模型侧可以只声明其中一部分，并可使用 string、array 等简写形态；Runtime 在归一化时根据 Projection、authority、routing、adapter policy 和 safety policy 展开为对象形态，补齐可执行边界。

### 规范状态词

Run、Action、Assignment、Adapter run、Workflow node 和 UI Projection 使用同一组状态词。

| Status | 语义 |
|---|---|
| `draft` | 已创建，尚未进入可调度状态。 |
| `pending` | 已接受，但还在等待依赖、输入 materialization 或调度窗口。 |
| `ready` | 合法且可调度。 |
| `running` | 正在执行。 |
| `waiting_user` | 等待用户或 Owner 输入。 |
| `waiting_permission` | 等待权限、审批或授权。 |
| `blocked` | 缺少决策、前置条件、权限、证据或资源，无法继续。 |
| `partial` | 已产生可用结果，但部分必要子项、验证、handoff、Artifact 或 gate 未完成或未通过。`partial` 不是 `completed`，下游只能消费被 Runtime 明确标记为可用的 Artifact，并需要通过 failure、Decision 或 Handoff 处理未决部分。 |
| `failed` | 执行失败，当前 `failure` 未恢复。 |
| `completed` | 成功完成，满足 criteria 和必要 gate。 |
| `skipped` | 被 Decision、Gate 或依赖规则跳过，且跳过行为已记录。 |
| `cancelled` | Runtime 或用户在完成前取消。 |
| `aborted` | Run 或高层编排被有意终止为最终状态。 |

## 对象定义

本节定义 Harness 协议的共享对象。子文档可以细化字段和状态机，但应沿用这些对象语义。

### Actor

可以参与协议并出现在事件、命令、审计记录中的主体。Actor 是最宽的执行身份概念，覆盖 Agent Session、Runtime 服务、确定性程序、工具包装器、adapter runner 和 human owner。

示例：

- `agent-session-13`
- `memory-service`
- `workflow_runner`
- `bun-test-runner`
- `human-owner`

### Model

生成回答、协议输出和推理结果的模型能力。Model 可以由不同 provider 或 runtime backend 提供，通常通过 Agent Session 被使用。

Model 不直接改变 Harness 状态；状态变更需要通过 Runtime 接受的 Command、Action 或 adapter operation 发生。

示例：

- 用于主会话的 LLM
- 用于 review session 的 LLM
- 用于 summarization 的模型服务

### Agent

可复用执行模板。Agent 定义 persona、prompt material、entry、capability、permission profile、模型偏好、运行策略、relationship metadata 和可选 Orchestration Policy。

Agent 本身不直接执行 assignment。Runtime 基于 Agent 模板创建 Agent Session，由会话执行具体工作。

Orchestration Policy 用于声明 Runtime 可以围绕当前 Agent Session 评估的默认编排策略。Runtime 会将命中的策略展开为标准 Action / Assignment；需要交接给后续 Agent 或 human 时，展开为 Handoff Contract，并为每个后续 Assignment 独立校验权限、预算、gate 和状态。

Agent 模型由 `01-agent-model-and-authoring.md` 定义。

示例：

- 负责开发工作的 `code_developer`
- 负责审查补丁的 `technical_reviewer`
- 负责准备上下文的 memory agent
- 负责 durable DAG 编排的 `workflow_runner`

### Orchestration Policy

Agent 模板上的默认 Runtime 编排策略。Orchestration Policy 描述 Runtime 可以根据请求状态、结果状态、Artifact、side effect、风险、阻塞、失败和冲突触发哪些额外 Action / Assignment。

Orchestration Policy 的产物是标准 Contract；涉及跨 Agent 或 human owner 交接时，产物是 Handoff Contract。Runtime 负责判断是否触发、选择目标 Agent、推导 authority、构造 Context Bundle、追加 Event、更新 Projection 和记录 Trace。

示例：

- 需求不清楚时触发 `requirements_clarifier`
- `code_developer` 完成写入后触发 `code_test`
- `code_test` 完成后触发 `technical_reviewer`
- `frontend_developer` 完成 UI 修改后触发 `accessibility_reviewer`
- 测试失败后触发 `code_debugger`
- 多个 Agent 判断冲突时触发 `technical_reviewer` 仲裁

### Agent Session

Runtime 基于 Agent 模板创建的执行会话。Agent Session 有会话 id、session log、trace、状态和权限边界，可以作为 root session、child session 或 descendant session 存在。

Agent Session 接收 assignment，生成协议输出、Action 请求、Artifact 或结果摘要。Agent 会话之间不直接通信，协作由 Runtime 通过 assignment、event、projection 和 trace 协调。

Agent Session 不等同于模型上下文。Session log 是会话的持久记录，保存会话中被 Runtime 接受和引用的消息、协议输出、Action、observation、Artifact ref 和状态变化；Context 是 Runtime 在模型调用前基于 session log、Projection、Memory、Artifact、环境信息和语义解释动态构造出的模型输入。

示例：

- root coding session
- review child session
- workflow runner session
- memory summarization session

### Adapter

基于 Harness 基础 DSL 的场景化编排结构。Adapter 用于表达 Workflow、evaluation loop、release gate、long-running monitor 等常见场景。

Adapter 定义场景化结构、模板和约束。Runtime 将 Adapter 输入展开为统一 Action Graph、Action、Assignment、状态迁移、事件投影、Trace 和 Artifact。

示例：

- workflow adapter
- evaluation loop adapter
- release gate adapter
- long-running monitor adapter

### Capability

Agent 或 executor 的适配能力描述，用于 routing、selection 和 prompt construction。

Capability 是匹配元数据，不授予执行权限。实际可执行边界由 Authority 决定。

示例：

- `read_code`
- `write_code`
- `run_tests`
- `code_review`
- `query_project_memory`
- `summarize_artifacts`

### Authority

Runtime 授予 Actor 在某个 scope 内可以改变、读取、批准或触发什么。Authority 是执行边界，通常绑定到 Action、Assignment 或 Command。

Authority 由 Runtime 强制执行。

示例：

- 读取 `repo://current`
- 写入 `packages/harness/src/workflow/**`
- 创建 review artifact
- 批准 L2 task completion
- 请求 L4 owner decision

### Scope

协议对象生效的边界。Scope 用于限定权限、记忆、上下文、artifact 和审计范围。

示例：

- `run`
- `project`
- `team`
- `global`
- `assignment`
- `workflow`

### Namespace

Scope 内的命名空间。Namespace 让不同项目、团队或运行上下文中的对象使用统一格式，同时保持身份明确。

示例：

- `project:open-agent-harness`
- `team:runtime`
- `global:user`
- `run:run_123`

### Runtime

Harness 的执行控制层。Runtime 负责解析协议、校验权限、选择 executor、创建 assignment、追加事件、更新 projection、执行 gate、构造上下文和管理恢复。

示例职责：

- 接受 `Command`
- 将模型输出归一化为 `Action`
- 选择合适的 `Executor`
- 创建 `Assignment`
- 写入 `Event`
- 重建 `Projection`

### Command

用户、UI 或 Actor 提交给 Runtime 的结构化状态变更请求。

Command 经过 schema、authority、gate 和 projection 校验后，才能产生 Event 或 Action。

示例：

- `run.create`
- `run.pause`
- `task.retry`
- `decision.answer`
- `verify.rerun`

### Action

Runtime 接受后的可执行语义工作单元。

Action 可以映射到 tool、Agent Session、runtime service、human approval、pipeline 或 adapter operation。Action 契约由 `04-action-executor-contract.md` 定义。

示例：

- 读取文件
- 搜索代码
- 委派 review agent session
- 请求 human approval
- 启动 workflow run

### Action Graph

由 Action nodes 和 dependency edges 组成的执行图。Action Graph 表达哪些工作可以并行、哪些工作依赖上游结果、哪些 gate 或 handoff 决定下游是否可继续。

Action Graph 可以来自模型侧 `calls[]`，也可以来自 Workflow、Evaluation、Release Gate 等 Adapter Profile。Runtime 负责校验 graph、调度 ready actions、记录状态、处理失败并更新 Projection。

示例：

- `inspect -> implement -> test -> review`
- `read_a + read_b -> compare -> summarize`
- `implement -> [unit_test, typecheck] -> gate`

### Executor

执行 Action 的目标抽象。Executor 可以是 tool、Agent Session、Runtime service、human、pipeline 或 external service。

示例：

- `tool:read`
- `tool:grep`
- `agent-session:reviewer`
- `runtime:summarize`
- `human:owner_approval`

### Assignment

Runtime 将 Action 委派给 Agent Session 后形成的任务边界。

Assignment 包含 action refs、agent session refs、authority、input contract、output contract、context refs、artifact refs 和 trace refs。

示例：

- 把 `review_changes` action 绑定给 reviewer session
- 把 `implement_fix` action 绑定给 coding session
- 把 `summarize_context` action 绑定给 memory session

### Contract

Assignment 或 Action 的输入输出契约。Contract 定义执行者收到什么、要达成什么目标、遵守什么约束、依赖哪些对象、提交什么 Artifact、提供什么证据、消耗什么预算、披露什么风险、遗留哪些未决问题，以及结果如何被 Runtime 验收。Contract 使用总纲定义的统一字段表达这些边界。

示例：

- 目标：完成指定 review、实现或验证任务
- 约束：scope、权限、时间、成本、风格、兼容性
- 依赖：`depends_on` 中的 upstream action、artifact refs、decision refs
- 输出：result summary、artifact refs、status
- 证据：test log、diff artifact、review finding
- 风险：已知失败、未验证路径、scope drift
- 未决问题：需要 owner、reviewer 或后续 Agent Session 继续判断的事项
- 验收：status、summary、gate result

### Success Criteria

Action、Assignment、Run 或 Adapter node 的完成标准。Success Criteria 让 Runtime、Executor、Review、Verification 和 UI 可以围绕同一组验收条件判断工作是否完成。

示例：

- “焦点测试通过。”
- “Review finding 都有 evidence 和 severity。”
- “发布 gate 所需审批全部完成。”

### Failure Policy

执行失败、阻塞或验证未通过后的处理规则。Failure Policy 可以描述 retry、block、ask_user、handoff、abort、continue_with_warning 等路径，并受预算、权限和 gate 约束。

示例：

- retry max attempts 2
- 失败后交给 debugger Agent Session
- review 未通过时阻塞 parent run

### Budget Policy

Runtime 对成本、时间、token、attempt、parallelism、缓存和外部资源的约束。Budget Policy 可以绑定到 Run、Action、Assignment、Adapter 或 Model Policy。

示例：

- `timeout_ms: 600000`
- `max_attempts: 2`
- `max_parallel: 3`
- `cache: read_allowed`

### Visibility Policy

控制信息进入不同通道的方式。Visibility Policy 规定 Artifact、Trace、Action result、Memory 或 Observation 如何进入 model context、user UI、logs、future runs 和 runtime-only control。

示例：

- model: summary
- user: summary
- logs: full
- future_runs: ref

### Handoff

Runtime 在 Assignment 之间建立的结构化交接关系。Handoff 用于把一个 Agent Session 的结果、证据、风险和未决问题交给另一个 Agent Session 或 human owner 继续处理。

Handoff 包含目标、约束、依赖、证据、Artifact refs、预算、风险、未决问题、来源 session 和目标 executor，并使用 `handoff` 字段进入 Action、Assignment 或 Adapter node。

Handoff 可以来自模型声明的 next Action，也可以来自 Agent 模板上的 Orchestration Policy。无论来源如何，Runtime 都将其转换为受治理的 Action / Assignment。

示例：

- coding session 完成 patch 后交给 review session
- review session 提出 rework 后交给 coding session
- verification session 发现 blocker 后交给 human owner 决策

### Event

Runtime 接受并追加的不可变事实。

事件是审计、回放和恢复基础。模型上下文通过 Projection、Context Bundle 和 observation 获得。

示例：

- `run.created`
- `action.accepted`
- `assignment.started`
- `artifact.written`
- `gate.blocked`
- `decision.applied`

### Event Log

Event 的追加式记录。Event Log 是审计和 replay 的事实来源，回答“系统接受了什么、何时接受、由谁提交、Runtime 为什么接受”。

示例用途：

- 回放 run 状态
- 解释一次 gate block
- 导出审计材料
- 恢复 projection

### Projection

由 Event 和状态规则推导出的当前操作视图。

UI、Runtime 调度、Agent Session 上下文都默认读取 Projection。

示例：

- run 当前状态
- task 当前状态
- pending decision queue
- artifact index
- concept current version
- memory index

### Trace

围绕一次 run、action、assignment 或 Agent Session 组织出的可观察证据链。Trace 连接 Event、Projection、executor invocation、Artifact、observation、Gate、Decision 和 error，用于审计、调试、评测、恢复和后续 Agent Session 接续。

示例：

- protocol action trace
- child session trace
- executor invocation trace
- gate failure trace
- audit export trace

### Materialized State

Projection 或场景状态的持久化形态，用于快速查询、展示、调度和恢复。

示例：

- 数据库里的 run/action/assignment 行
- workflow node state 文件
- artifact index
- UI summary cache

### Trigger

Runtime 根据 Event 和 Projection 执行的确定性规则。Trigger 把已接受事实转化为下一步系统动作。

示例：

- task submitted 后触发 review assignment
- review approved 后触发 verification
- verification failed 后触发 rework decision
- decision answered 后恢复 blocked run

### Gate

状态迁移或执行前需要满足的 Runtime 强制条件。

Gate 可以校验 schema、authority、scope、dependency、review、verification、human approval、privacy 和 budget。

示例：

- schema valid
- write scope allowed
- required review approved
- verification passed
- human approval granted
- sensitive output redacted

### Run

一次受 Harness 管理的工作执行。Run 聚合目标、任务、Action、Assignment、Artifact、Event、Projection、Decision 和 trace。

示例：

- 修复一个 bug 的 run
- 一次代码审查 run
- 一次 workflow DAG run
- 一次 release gate run

### Task

Run 内的可管理工作单元。Task 表达用户或 Planner 关心的工作拆分，可以由一个或多个 Action、Assignment、Artifact 和 gate 组成。

示例：

- `inspect_auth`
- `implement_timeout`
- `review_patch`
- `verify_sdk_build`

### Artifact

由 Actor 或 Runtime 生成、存储、引用的产物。Artifact 用引用进入上下文，避免把完整内容反复放入模型输入。

示例：

- diff patch
- test log
- review report
- generated plan
- protocol trace export
- workflow node result

### Artifact Contract

Action、Assignment 或 Adapter node 对产物的声明。Artifact Contract 定义期望产生、读取或更新的 Artifact type、name、scope、visibility 和 evidence 要求。

示例：

- 期望 `patch` artifact
- 期望 `test_report` artifact
- 读取 upstream `review_report`

### Environment Manifest

Runtime 为 Executor 创建的环境声明。Environment Manifest 描述 executor 的 sandbox、workspace、工具、网络、secret、artifact 输出、snapshot 和 timeout。

示例：

- 只读 workspace manifest
- 可写临时 worktree manifest
- 带 snapshot refs 的恢复 manifest

### Context Bundle

Runtime 为一次模型调用或 assignment 构造的上下文包。

它包含当前会话内容、目标、约束、当前 Projection 摘要、必要 Artifact refs、Memory refs、环境信息和语义解释提示。

示例内容：

- task goal
- relevant files
- accepted decisions
- artifact refs
- current projection summary
- memory refs

### Memory

跨时间保存的知识或偏好。

Memory 记录需要包含 scope、status、source、visibility 和 evidence。Projection 提供当前操作真相，Memory 提供可检索证据。

示例：

- 项目命名约定
- 团队 review policy
- 用户偏好的输出格式
- 架构决策摘要

### Concept

系统需要长期稳定引用的概念，例如 API 名、schema、module ownership、architecture decision。

Concept 可以记录版本、替换关系、引用、证据和影响范围。Concept replacement 需要说明新的事实、需求、失败或约束，并触发 impacted reference scan。

示例：

- `user-profile-api`
- `agent-entry-model`
- `workflow-node-state`
- `runtime-permission-policy`

### Goal Contract

Run 的目标边界。Goal Contract 记录目标、non-goal、约束和成功标准，让 Runtime 和授权决策者判断目标漂移。

示例：

- goal: “修复 auth refresh timeout”
- non-goal: “重写 auth provider”
- constraint: “保持 public API”
- success: “typed timeout error + focused tests pass”

### Decision

对不确定性、风险、目标变化或恢复路径的结构化选择。Decision 由 Runtime 接受并记录，通常带有 reason、scope、evidence 和 actor。

示例：

- 选择 retry node
- 批准 L2 task completion
- 将概念替换升级到 L3
- 请求 human owner approval

### Review

对提交产物的评估。Review 关注正确性、回归风险、遗漏测试、scope drift、已披露风险和证据质量。

示例输出：

- finding
- severity
- evidence
- recommendation
- decision: approve / request_rework / needs_info

### Verification

通过工具、测试、脚本或确定性检查验证声明。Verification 把“看起来完成”转成可引用证据。

示例：

- `bun typecheck`
- focused unit test
- schema validation
- replay check
- smoke test

### Escalation

把决策提升到更高权限或更大影响半径处理。Escalation 依据风险、可逆性、成本、目标漂移和 owner preference。

示例：

- L2 task issue 升级为 L3 architecture decision
- 发布前 gate 升级给 owner approval
- concept replacement 触发 impact scan 后升级

### Owner

对某类高影响决策拥有最终授权的人类或组织主体。Owner 可以是用户、项目维护者、团队负责人或组织策略。

示例：

- user owner
- repository maintainer
- release owner
- security owner

## 待讨论问题

这些问题需要继续讨论，并在对应子协议中定义：

- direct request recovery 的精确判定规则。
- Agent routing 的 scoring 和 tie-breaker。
- Memory ranking 与 historical evidence 返回规则。
- Concept replacement 的 evidence 和 impact scan 规则。
- UI audit/export 的 redaction policy。
- Model Policy：模型选择、成本预算、fallback、缓存和调用策略。
- Evaluation Adapter：Trial、Grader、Outcome、Metric 和 Regression Gate。

## 文档地图

| 编号 | 文档 | 责任 |
|---|---|---|
| 00 | `00-harness-governance-protocol.md` | 总纲：目标、原则、协议架构、对象定义和边界。 |
| 01 | `01-agent-model-and-authoring.md` | Agent 模板、metadata、entry、capability、permission、relationships、authoring contract。 |
| 02 | `02-skill-format-agent-import.md` | 将 `SKILL.md` authoring format 导入为 virtual agent。 |
| 03 | `03-model-runtime-protocol.md` | 模型与 Runtime 的 DSL / protocol 交互协议。 |
| 04 | `04-action-executor-contract.md` | Action、Executor、toolCall carrier、recovery normalization、执行环境契约。 |
| 05 | `05-routing-and-delegation-policy.md` | Routing、delegation、assignment、child session trace、handoff。 |
| 06 | `06-state-event-projection-model.md` | Event source、Projection、Trace / Observability、状态映射、事务边界、replay。 |
| 07 | `07-context-memory-visibility-policy.md` | Context Bundle、Memory Scope、visibility、privacy、replay policy。 |
| 08 | `08-workflow-durable-orchestration-adapter.md` | Workflow 作为 DSL 之上的 durable orchestration adapter。 |
| 09 | `09-ui-console-and-agent-management.md` | UI 如何管理、观察和使用 Harness 系统。 |

支持性研究、评测材料和参考资料放在 `docs/harness-protocol/support/`，作为协议设计依据和评测背景。
