# Harness 治理协议总纲

本文档是 Open Agent Harness 的治理协议总纲。它按顺序说明协议目标、设计原则、协议架构、对象关系、控制流、决策模型、Workflow/UI 定位和文档地图。

详细规范由 `01` 到 `09` 承接。总纲聚焦稳定抽象和关系边界。

## 协议目标

Harness 的目标是建立一个可治理的 agent operating environment。

它面向多个模型会话、工具、工作流、人工决策和长期记忆共同参与任务的场景，让系统保持可控、可审计、可恢复。

## 设计原则

### 1. Runtime 控制状态变更

所有会改变系统状态的请求都必须由 Runtime 接受、校验、执行和记录。

Runtime 接受结构化 Command、Action 或 adapter operation，并据此推进 run、修改任务状态、批准审查或替换概念。

### 2. Agent 之间不直接对话

Agent 之间的通信和协作由 Runtime 控制协调。

Runtime 通过 Action、Assignment、Event、Projection 和 Artifact 建立协作关系、记录协作过程、推进协作状态。

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

Projection 是 Runtime、Agent 和 UI 的默认操作视图；Event Log 用于审计、回放、调试和恢复。

### 7. 场景编排通过 Adapter 扩展

Harness 可以基于基础 DSL 为特定场景生成通用 Adapter。Workflow、evaluation loop、release gate、long-running monitor 都可以作为 Adapter 表达特定编排方式。

Adapter 可以拥有自己的场景 DSL、状态文件和运行策略，并复用 Harness 的 Action、权限、状态迁移、事件投影和审计模型。

## 协议架构

协议架构说明 Harness 的静态构件、运行链路和分层边界。

### 协议构件

本节说明 Harness 协议有哪些稳定构件，以及每类构件在治理系统中承担什么角色。

Harness 协议由六类协议构件协同工作：

- **Model**：负责判断、规划、解释和产生产物，通过模型-Runtime 协议声明意图。
- **Runtime**：负责状态、权限、调度、执行、门禁、持久化、审计和恢复。
- **Agent**：作为可复用执行身份接收 assignment，在授权上下文中完成具体工作。
- **State**：通过 Event Log、Projection、Artifact、Memory 和 Concept 表示可审计系统状态。
- **Adapter**：在 Harness 协议之上实现 Workflow、release gate、evaluation loop、long-running automation 等编排形态。
- **UI**：负责观察、管理、批准、暂停、恢复和追溯，通过 Command 推进系统。

### 运行平面

运行平面说明协议构件如何沿运行链路协作，覆盖用户输入、模型声明、Runtime 归一化、执行、状态持久化、投影更新和产品观察。

协议构件回答“有哪些稳定构件”。运行平面回答“构件如何连成运行链路”。分层边界回答“每层拥有什么责任和状态，以及通过哪些对象与其他层交互”。

运行架构由五个平面组成。

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
  -> Tool / Agent / Runtime Service / Human / Pipeline

State plane
  -> Event Log
  -> Projection
  -> Artifact
  -> Concept

Context and memory plane
  -> Context Bundle
  -> Memory Service
  -> Memory Record
  -> Visibility Policy

Adapter and product plane
  Adapter -> Workflow / Evaluation loop / Release gate / Long-running automation
  UI -> Command / Approval / Observation
```

#### 模型交互平面

模型与 Runtime 的交互由 `03-model-runtime-protocol.md` 定义。

该协议回答：

- 模型如何声明 Action、依赖、上下文引用和结果策略？
- v1 如何用 `AgentProtocolOutput` 等 toolCall carrier 承载协议？
- Runtime 如何把直接 tool request 安全恢复为协议 Action？
- Runtime 如何把结果重新呈现为精简 observation？

#### 执行平面

执行平面由 `04-action-executor-contract.md` 和 `05-routing-and-delegation-policy.md` 定义。

它回答：

- 什么是 Action？
- 哪些 executor 类型存在？
- Runtime 如何选择 tool、agent、runtime service 或 human？
- Agent delegation 如何生成 assignment 和 child session trace？
- 权限、side effect、scope 和 cost 如何影响执行？

#### 状态平面

状态平面由 `06-state-event-projection-model.md` 定义。

它回答：

- 什么事件可以被接受？
- Projection 如何从 Event 和状态文件推导？
- 状态迁移的事务边界是什么？
- adapter 状态如何映射到统一 run state？
- replay 和 export 的基础形状是什么？

#### 上下文与记忆平面

上下文与记忆平面由 `07-context-memory-visibility-policy.md` 定义。

它回答：

- Agent 应该看到哪些上下文？
- 哪些内容用于 UI 展示，哪些内容进入模型上下文？
- Run、Project、Team、Global memory 如何区分？
- historical memory 如何作为证据返回，current projection 如何保持优先级？
- redaction 和 replay policy 如何执行？

#### Adapter 与产品平面

Workflow adapter 由 `08-workflow-durable-orchestration-adapter.md` 定义。UI 由 `09-ui-console-and-agent-management.md` 定义。

它们回答：

- Workflow 如何在 Harness 上表达 durable DAG orchestration？
- Workflow Runner agent 如何创建和决策 workflow run？
- UI 如何展示 run、task、decision、event、memory、concept、agent manager 和 session tree？
- 用户如何通过 Command 推进系统状态？

### 分层边界

分层边界用于确定责任归属、状态归属和跨层接口。子协议设计字段、状态机和 UI 行为时，应沿用这组 ownership 关系。

| Layer | 拥有内容 | 跨层接口 |
|---|---|---|
| Model Layer | 判断、计划、协议声明、用户可见解释 | `AgentProtocolOutput`、DSL declaration、answer、recovery input |
| Runtime Layer | 状态迁移、权限校验、调度、gate、event append、projection update、recovery | `Command`、`Action`、`Assignment`、`Event`、`Projection` |
| Execution Layer | tool、agent、runtime service、human approval、pipeline、external service | executor invocation、action result、artifact |
| State Layer | Event Log、Projection、Artifact、Memory、Concept、adapter state | state query、context refs、trace/export refs |
| Adapter Layer | Workflow、release gate、evaluation loop、long-running automation | adapter operation、adapter state projection |
| Product Layer | Harness Console、Session Tree、Agent Manager、Protocol Panel | UI Command、approval、observation、trace view |

## 对象关系

本节定义 Harness 协议的共享词汇。子文档可以细化字段和状态机，但应沿用这些对象语义。

### Actor

可以参与协议的主体。Actor 是最宽的身份概念，覆盖模型会话、Runtime 服务、确定性程序、工具包装器、adapter runner 和 human owner。

示例：

- `agent-session-13`
- `memory-service`
- `workflow-runner`
- `bun-test-runner`
- `human-owner`

### Agent

由模型驱动的 Actor。Agent 有模板、身份、prompt material、entry、capability、permission profile 和运行策略。

Agent 模型由 `01-agent-model-and-authoring.md` 定义。

示例：

- 负责实现任务的 coding agent
- 负责审查补丁的 review agent
- 负责准备上下文的 memory agent
- 负责 durable DAG 编排的 workflow runner agent

### Capability

Actor 技术上擅长或支持什么。Capability 是 routing、selection 和 prompt construction 的输入；权限由 Authority 表示。

示例：

- `read_code`
- `write_code`
- `run_tests`
- `code_review`
- `query_project_memory`
- `summarize_artifacts`

### Authority

Runtime 授予 Actor 在某个 scope 内能改变或批准什么。Authority 是执行边界，通常绑定到 assignment。

Authority 必须由 Runtime 强制执行。

示例：

- 读取 `repo://current`
- 写入 `packages/harness/src/workflow/**`
- 创建 review artifact
- 批准 L2 task completion
- 请求 L4 owner decision

### Contract

Assignment 的输入输出契约。Contract 定义 Actor 收到什么、提交什么、需要提供什么证据、结果如何被 Runtime 验收。

示例：

- 输入：`Context Bundle`
- 输出：`Execution Result`
- 证据：test log、diff artifact、review finding
- 验收：status、summary、artifact refs、self check

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

Scope 内的命名空间。Namespace 让不同项目、团队或运行上下文中的对象可以共享格式，同时保持身份明确。

示例：

- `project:open-agent-harness`
- `team:runtime`
- `global:user`
- `run:run_123`

### Runtime

Harness 的执行控制层。Runtime 负责解析协议、校验权限、选择 executor、调度 assignment、追加事件、更新 projection、执行 gate、管理恢复。

示例职责：

- 接受 `Command`
- 将模型输出归一化为 `Action`
- 选择合适的 `Executor`
- 创建 `Assignment`
- 写入 `Event`
- 重建 `Projection`

### Command

用户、UI 或 Actor 提交给 Runtime 的结构化意图。

Command 经过 schema、authority、gate 和 projection 校验后，才能产生 Event 或 Action。

示例：

- `run.create`
- `run.pause`
- `task.retry`
- `decision.answer`
- `verify.rerun`

### Action

Runtime 可执行的最小语义工作单元。

Action 可以映射到 tool、agent、runtime service、human approval、pipeline 或 adapter operation。Action 契约由 `04-action-executor-contract.md` 定义。

示例：

- 读取文件
- 搜索代码
- 委派 review agent
- 请求 human approval
- 启动 workflow run

### Assignment

Runtime 把 Action 绑定给 Actor 后形成的任务边界。

Assignment 包含 action refs、actor refs、authority、input contract、output contract、context refs、artifact refs 和 trace refs。

示例：

- 把 `review_changes` action 绑定给 `reviewer` agent
- 把 `run_tests` action 绑定给 deterministic test runner
- 把 `summarize_context` action 绑定给 memory actor

### Executor

执行 Action 的具体对象。Executor 可以是 tool、agent、runtime service、human、pipeline 或 external service。

示例：

- `tool:read`
- `tool:grep`
- `agent:reviewer`
- `runtime:summarize`
- `human:owner_approval`

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

由 Event 和状态文件推导出的当前操作真相。

UI、Runtime 调度、Agent context 都应该优先依赖 Projection。

示例：

- run 当前状态
- task 当前状态
- pending decision queue
- artifact index
- concept current version
- memory index

### Trigger

Runtime 根据 Event 和 Projection 执行的确定性规则。Trigger 把已接受事实转化为下一步系统动作。

示例：

- task submitted 后触发 review assignment
- review approved 后触发 verification
- verification failed 后触发 rework decision
- decision answered 后恢复 blocked run

### Gate

状态迁移或执行前必须满足的 Runtime 强制条件。

Gate 可以校验 schema、authority、scope、dependency、review、verification、human approval、privacy 和 budget。

示例：

- schema valid
- write scope allowed
- required review approved
- verification passed
- human approval granted
- sensitive output redacted

### Run

一次受 Harness 管理的工作执行。Run 聚合目标、任务、assignment、artifact、event、projection、decision 和 trace。

示例：

- 修复一个 bug 的 run
- 一次代码审查 run
- 一次 workflow DAG run
- 一次 release gate run

### Task

Run 内的可管理工作单元。Task 通常有目标、scope、依赖、状态、验收标准、artifact 和 review/verification 要求。

示例：

- `inspect_auth`
- `implement_timeout`
- `review_patch`
- `verify_sdk_build`

### Task Card

Task 的结构化说明。Task Card 让 Planner、Runtime、Executor、Reviewer 对任务目标和验收标准形成同一份记录。

示例字段：

- `id`
- `goal`
- `scope`
- `depends_on`
- `context`
- `acceptance`
- `output`
- `review`
- `verify`

### Artifact

由 Actor 或 Runtime 生成、存储、引用的产物。Artifact 用引用进入上下文，避免把完整内容反复放入模型输入。

示例：

- diff patch
- test log
- review report
- generated plan
- protocol trace export
- workflow node result

### Context Bundle

Runtime 为一次 assignment 选择的上下文包。

它包含目标、约束、当前 projection 摘要、必要 artifact refs、memory refs，以及明确排除的内容。

示例内容：

- task goal
- relevant files
- accepted decisions
- artifact refs
- current projection summary
- memory refs

### Context Capsule

可复用的上下文摘要。Context Capsule 通常由 Memory Actor 或 Runtime 生成，用于跨 assignment 传递稳定事实和引用。

示例：

- “auth timeout 相关文件和决策摘要”
- “本次 review 的主要风险摘要”
- “workflow failed node 的恢复上下文”

### Memory

跨时间保存的知识或偏好。

Memory 必须有 scope、status、source、visibility 和 evidence。Projection 提供当前操作真相，Memory 提供可检索证据。

示例：

- 项目命名约定
- 团队 review policy
- 用户偏好的输出格式
- 架构决策摘要

### Memory Service

Runtime 管理的记忆服务。Memory Service 负责存储、检索、排序、过滤、标记 visibility，并把 memory refs 交给 Context Bundle。

示例职责：

- 查询 project memory
- 区分 current 和 historical records
- 应用 redaction policy
- 返回 memory evidence refs

### Memory Actor

负责整理、压缩、归档或解释记忆的 Agent 或服务。Memory Actor 可以准备 Context Capsule，也可以提出 memory update command。

示例任务：

- 将长 run 总结成 project memory candidate
- 为 Decision Actor 准备相关历史证据
- 标记 superseded memory

### Concept

系统需要长期稳定引用的概念，例如 API 名、schema、module ownership、architecture decision。

Concept replacement 必须说明 new information，并触发 impacted reference scan。

示例：

- `user-profile-api`
- `agent-entry-model`
- `workflow-node-state`
- `runtime-permission-policy`

### Concept Graph

Concept 及其关系的结构化索引。Concept Graph 跟踪版本、替换关系、引用、受影响文件和证据。

示例：

- API concept graph
- module ownership graph
- schema dependency graph
- decision replacement chain

### New Information

替换 active Concept 时必须说明的新事实、新需求、新失败或新约束。

示例：

- 新 provider 需要额外字段
- 测试证明 previous assumption 有误
- 隐私约束改变了存储设计

### Goal Contract

Run 的目标边界。Goal Contract 记录目标、non-goal、约束和成功标准，让 Runtime 和 Decision Actor 判断目标漂移。

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

### Self Check

Execution Actor 对自己完成声明提供的证据清单。Self Check 是提交前的自证材料，供 Runtime 和 Evaluation Actor 使用。

示例：

- claim: “timeout test passes”
- evidence: `artifact://test-log`
- claim: “changed files are inside scope”
- evidence: `artifact://diff-summary`

### Known Risks

Execution Actor 主动披露的风险。Known Risks 帮助 Reviewer 聚焦，但 Reviewer 仍按自己的 evaluation contract 做独立判断。

示例：

- “browser runtime path 未覆盖”
- “large repo performance 未验证”
- “external provider behavior 依赖模拟结果”

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

## 控制流

Harness 的标准执行链路是：

```txt
User request
  -> Runtime creates or updates Run intent
  -> Model declares protocol output or answer
  -> Runtime normalizes into Action
  -> Runtime validates policy and gates
  -> Runtime routes to executor or assignment
  -> Executor returns result
  -> Runtime stores artifact and appends Event
  -> Runtime updates Projection
  -> Model receives concise observation when needed
  -> UI observes Projection and trace
```

关键点：

- 模型输出先进入 Runtime normalization。
- 工具结果通过 Runtime observation policy 进入下一轮模型上下文。
- Agent delegation 必须通过 Runtime assignment。
- UI 操作必须通过 Command。
- Adapter 状态必须投影回统一 Harness run state。

## 决策与升级模型

Harness 按风险、影响半径、可逆性和价值判断含量分级决策。

推荐分级：

| Level | 含义 | 典型处理 |
|---|---|---|
| L0 | 确定性执行 | Runtime 或 deterministic tool 直接处理。 |
| L1 | 局部可逆执行 | Execution Actor 可在授权 scope 内处理。 |
| L2 | 影响局部工程质量 | Evaluation / Decision Actor 审查后推进。 |
| L3 | 影响目标、约束、架构或长期概念 | Decision Actor 必须显式记录理由。 |
| L4 | 影响 owner 偏好、成本、风险或不可逆外部后果 | 需要 human owner 或等价授权。 |

子协议可以细化 gate，并保持升级要求一致。

## Workflow 定位

Workflow 是 Harness 上的 durable orchestration adapter。

它适合：

- 多阶段任务
- 并行子任务
- 多 Agent 执行
- 可恢复运行
- 失败后 retry、replan、decision
- 用户需要进度、暂停、恢复和审计

Workflow 继承模型与 Runtime 的通用协议。Workflow 的 DAG、node state、artifact、decision record 都遵守 Harness governance，并投影到统一 run state。

## UI 定位

UI 是 Harness 治理能力的操作面。

UI 读取 Projection、Event、Artifact、Trace、Memory 和 Concept。它提交 Command，由 Runtime 执行状态变更。

UI 必须让用户看到：

- run 当前状态
- task 和 assignment 进度
- blocker 和 pending decision
- gate 失败原因
- artifact 和 evidence
- child session trace
- memory 和 concept 的来源
- agent 配置、entry、capability 和 permission

## 总纲责任

### 总纲定义

- Harness 的治理目标
- 组件关系
- 核心对象语义
- 子协议责任划分
- Runtime 强制边界
- 协议设计原则

### 子文档定义

- Agent template 字段细节
- DSL JSON schema
- executor registry 字段
- routing scoring 算法
- event envelope 完整字段
- memory record 完整字段
- workflow DAG schema
- UI 页面组件和接口细节

## 第一版实现立场

第一版应该保守：

- 使用 runtime-owned toolCall carrier 承载模型协议入口。
- 所有承载路径进入 Runtime 后归一化成 Action。
- 在意图明确且 policy 允许时做 direct request recovery。
- 对无法判定 side effect、权限、scope 或 executor 的请求执行 fail-closed。
- 优先实现 read/search/summarize/review 类低风险 Action。
- 对写入、shell、发布、外部服务、长期 memory 修改和 concept replacement 使用 gate。
- UI 先展示 Projection 和 trace，再逐步增加图形化视图。
- Workflow 作为 adapter 实现 durable orchestration，并继承通用模型协议。

## 待细化问题

这些问题需要在子协议中继续细化：

- v1 DSL schema 的最小字段集合。
- direct request recovery 的精确判定规则。
- Agent routing 的 scoring 和 tie-breaker。
- Memory ranking 与 historical evidence 返回规则。
- Concept replacement 的 evidence 和 impact scan 规则。
- Workflow 与通用 Action Graph 的映射边界。
- UI audit/export 的 redaction policy。

总纲的约束是：所有子协议都必须保持 Runtime governance 作为执行边界。

## 文档地图

| 编号 | 文档 | 责任 |
|---|---|---|
| 00 | `00-harness-governance-protocol.md` | 总纲：目标、原则、协议架构、对象关系和边界。 |
| 01 | `01-agent-model-and-authoring.md` | Agent 模板、entry、capability、permission、authoring contract。 |
| 02 | `02-skill-format-agent-import.md` | 将 `SKILL.md` authoring format 导入为 virtual agent。 |
| 03 | `03-model-runtime-protocol.md` | 模型与 Runtime 的 DSL / protocol 交互协议，包含 v1 落地计划。 |
| 04 | `04-action-executor-contract.md` | Action、Executor、toolCall carrier、recovery normalization。 |
| 05 | `05-routing-and-delegation-policy.md` | Routing、delegation、assignment、child session trace、handoff。 |
| 06 | `06-state-event-projection-model.md` | Event source、Projection、状态映射、事务边界、replay。 |
| 07 | `07-context-memory-visibility-policy.md` | Context Bundle、Memory Scope、visibility、privacy、replay policy。 |
| 08 | `08-workflow-durable-orchestration-adapter.md` | Workflow 作为 DSL 之上的 durable orchestration adapter。 |
| 09 | `09-ui-console-and-agent-management.md` | UI 如何管理、观察和使用 Harness 系统。 |

支持性研究、评测材料和参考资料放在 `docs/harness-protocol/support/`，作为协议设计依据和评测背景。
