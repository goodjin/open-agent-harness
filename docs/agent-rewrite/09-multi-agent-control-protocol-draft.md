# 多会话 Agent 治理协议草案

相关的模型侧 DSL 协议见：`docs/agent-rewrite/10-agent-protocol-dsl.md`。本文档描述的是内部 Runtime 治理层，不是模型通常应该直接输出的格式。

## 目的

本文是一个由程序控制的多会话 Agent 治理协议初稿。

核心判断是：Agent 不应该通过直接对话来协作。协作应该由 Runtime 控制：Runtime 负责持久化状态、校验状态迁移、分派任务、执行门禁、组织审查和验证。

Agent 仍然可以推理、判断和生产产物，但它们只能通过 Runtime 定义的有界协议交互。

Workflow 只是本协议的一种应用形态，不是协议边界。协议还应该支持研究流、审查循环、记忆维护、长期监控、发布门禁，以及其他不适合单一 Workflow 表达的 Agent 集合。

本草案的四个核心对象是：

- **命令 Command**：Agent 或用户提交给 Runtime 的结构化意图。
- **事件 Event**：Runtime 校验通过后追加记录的不可变事实。
- **投影 Projection / 当前状态视图**：由事件推导出的当前可查询状态。
- **触发器 Trigger**：Runtime 根据事件和当前状态执行的确定性规则。

## 术语表

### Agent

由大模型驱动的执行者，可以接收 assignment，在有界上下文中推理，并提交命令或产物。

Agent 不应该被永久限定为 Worker 或 Reviewer。相同的 Agent 模板可以在不同 assignment 中承担不同角色，只要 Runtime 授予了对应能力和权限。

例子：

- 执行修复任务的代码 Agent 会话
- 审查补丁的 Review Agent 会话
- 为任务打包项目知识的 Memory Agent 会话

### Actor

任何可以参与协议的主体。

Actor 包括大模型 Agent 会话、确定性程序、工具包装器、Runtime 服务和人类 Owner。每个 Actor 在某个 assignment 中都有身份、能力、权限和契约。

例子：

- `agent-session-13`
- `bun-test-runner`
- `memory-service`
- `human-owner`

### Role

Actor 在某个 assignment 中承担的职责。

Role 是 assignment 级别的，不是 Agent 的永久身份。默认角色原型如 Controller、Secretary、Worker、Reviewer、Verifier 只是常用预设，不是协议的完整词汇表。

例子：

- `decision`
- `planning`
- `execution`
- `evaluation`
- `memory_packaging`
- `integration`

### Capability

Actor 技术上能做什么。

Capability 描述工具和技能表面，例如读代码、写代码、跑测试、查询记忆、检查产物、总结信息。Capability 不自动等于 Authority。

例子：

- `read_code`
- `write_code`
- `run_tests`
- `query_project_memory`
- `query_team_memory`
- `summarize_artifacts`

### Authority

Actor 被允许改变或批准什么。

Authority 必须由 Runtime 强制执行。比如写入范围、创建产物、批准审查、提出概念替换、修改目标、升级给 Owner。

例子：

- 可以写入 `packages/opencode/src/workflow/**`
- 可以创建 review artifact
- 可以批准 L2 任务完成
- 不可以替换 active concept
- 可以升级 L4 Owner 决策

### Contract

Assignment 的输入输出契约。

Contract 定义 Actor 收到什么上下文、可以提交什么命令或产物、需要提供什么证据、会触发哪些门禁。

例子：

- execution result contract
- evaluation result contract
- memory capsule contract
- recovery decision contract

### Scope

记录有效和可检索的边界。

Scope 用来防止项目记忆、团队记忆、全局记忆混成一坨。每条记录都应该声明适用范围，以及什么范围的记录可以覆盖它。

例子：

- `run`：只对一次执行有效
- `project`：对一个仓库、产品或工作区有效
- `team`：对一个团队的多个项目有效
- `global`：对一个用户或组织的所有项目有效

### Namespace

带 Scope 的存储和检索分区。

Namespace 让记忆和治理记录可以被寻址，但不意味着它们必须存放在同一个目录里。项目可以引用团队或全局命名空间，但不应该物理拥有这些记录。

例子：

- `project:opencode`
- `team:agent-platform`
- `global:user-jin`
- `run:run-auth-timeout`

### Runtime

程序控制的执行层。

Runtime 校验命令、追加事件、更新投影、评估门禁、执行触发规则、分派 Agent assignment，并持久化 run state 和 governance state。它是硬控制平面。

例子：

- 拒绝缺少 self-check evidence 的任务结果
- 追加 `review.rejected` 事件
- 更新 `task-state.json`
- 分派 evaluation assignment

### Command

提交给 Runtime 的结构化意图。

Command 表示“请求改变系统状态”，比如提交任务结果、批准草案、记录审查、查询记忆、请求替换概念。Command 还不是事实，只有通过 Runtime 校验并生成事件后才生效。

例子：

- `task.submit_result`
- `review.submit`
- `memory.query`
- `concept.replace.request`

### Event

Runtime 在 Command 通过校验后记录的不可变事实。

Event 描述系统接受了什么事情已经发生。事件是追加式的，用于审计、回放和恢复。事件是历史事实，不一定代表当前事实。

例子：

- `run.approved`
- `task.assigned`
- `task.result_submitted`
- `concept.replaced`

### Event Log

被接受事件的有序追加记录。

Event Log 是历史真相源，支持审计、回放、调试和恢复。普通 Agent 不应该直接消费完整 Event Log，因为它太长、重复，而且可能包含已经被替换的历史事实。

例子：

- `runs/<run>/events.jsonl`
- `governance/events.jsonl`
- team-level policy event log

### Projection / 当前状态视图

由 Event Log 推导出的当前状态视图。

Event Log 说明“历史上发生过什么”，Projection 说明“现在应该相信什么”。Runtime 调度和 Agent 上下文应该主要读取 Projection，而不是直接读完整历史日志。

例子：

- 当前 task state table
- active concept index
- open decision queue
- memory search index

### Trigger

Runtime 根据事件和当前 Projection 执行的确定性规则。

Trigger 可以在任务提交后调度审查，在审查通过后启动验证，在概念替换后扫描受影响引用。Trigger 不能依赖模型判断；如果需要判断，应该路由给 Decision Actor 或 Owner。

例子：

- `task.result_submitted -> spawn_evaluation`
- `verify.failed -> spawn_repair`
- `concept.replaced -> scan_impacted_references`

### Gate

状态迁移前必须通过的 Runtime 强制条件。

Gate 是协议里的物理门禁，不能被 prompt 绕过。

例子：

- `schema_valid`
- `self_check_present`
- `review_passed`
- `verify_passed`
- `decision_approved`

### Workflow

一种 run 级的编排形态，用来表达多步骤目标。

Workflow 可以包含目标契约、任务图、任务状态、上下文引用、产物、事件、决策和投影。它只是治理协议下的一种 orchestration pattern，不是整个协议。

例子：

- implement-review-verify flow
- release checklist flow
- research-summarize-review flow

### Task

可以被分派、执行、审查、验证和完成的工作单元。

Task 有目标、范围、依赖、上下文包、预期产物、验收标准和门禁。Execution Actor 执行任务，Runtime 拥有任务状态。

例子：

- inspect auth timeout behavior
- implement timeout fix
- review patch
- run focused tests

### Task Card

一个任务的结构化 assignment 记录。

Task Card 告诉被分派的 Actor：要做什么、能读写什么、使用什么上下文、输出什么、如何判断完成。

例子：

- implementation assignment card
- review assignment card
- memory capsule preparation card

### Artifact

协议引用的持久化产物。

Artifact 可以是补丁、文件、日志、测试报告、审查记录、截图、摘要或生成文档。较大的输出应该作为 artifact 存储，并通过 path 或 id 引用，而不是塞进每条记录。

例子：

- `diff.patch`
- `test-log.txt`
- `review.json`
- `context-summary.md`

### Context Bundle

Runtime 为某个 assignment 准备的上下文包。

它只包含任务需要的目标、约束、概念、产物、记忆记录和引用，避免 Agent 继承无关 transcript 或过期假设。

例子：

- 实现任务需要的文件和概念
- 审查任务需要的 artifact 和 acceptance criteria
- recovery 需要的决策历史

### Context Capsule

面向 Agent 的紧凑上下文胶囊。

Memory Actor 或 Planning Actor 可以从 Memory Service 记录和 Projection 中组装 capsule。Capsule 应该引用来源，并标记过期或不确定信息。

例子：

- 给代码 Agent 的 5 条相关 API 决策
- 某个模块当前生效的命名规则
- 给 Evaluation Actor 的当前团队审查策略

### Memory Service

程序拥有的持久知识检索层。

Memory Service 索引事件、投影、概念、决策和产物，并返回带有 freshness、status、scope、namespace、module、dimension 和 evidence 的结构化记录。

例子：

- project memory search
- team convention lookup
- global user preference lookup

### Memory Actor

帮助其他 Actor 准备记忆上下文的模型 Actor。

Memory Actor 可以总结和打包 Memory Service 返回的记录，但不能声明真相。当前真相来自 Projection 和 Concept State。

例子：

- 把 10 条设计决策压缩成 context capsule
- 解释为什么某个历史 API 名称已经过期
- 为任务挑选项目级约束

### Concept

带生命周期状态的工程概念。

Concept 不替代文档、代码、schema 或测试。文档、代码、schema、测试是概念的主要表达；Concept 记录的是这些表达背后的身份、状态、来源、替换关系和影响范围。

例子：

- `user-profile-api`
- `session-state-schema`
- `error-code-convention`
- `auth-module-boundary`

### Concept Graph

概念及其关系的结构化索引。

Concept Graph 跟踪版本、替换关系、引用、受影响文件和证据。它用于防止长期多会话工作中出现概念漂移。

例子：

- API concept graph
- module ownership graph
- schema dependency graph
- decision replacement chain

### New Information

替换 active concept 时必须说明的新信息。

替换概念必须解释：是什么新事实、新需求、新失败或新约束让旧概念不再充分。纯偏好式修改应该被拒绝或升级。

例子：

- 新 provider 需要额外字段
- 测试证明旧假设是错的
- 隐私约束让旧存储设计失效

### Goal Contract

当前 run 的目标边界。

它记录目标、非目标、约束和成功标准。Runtime 和 Decision Actor 用它检测目标漂移。

例子：

- “修复 timeout bug，不改变 public API”
- “只起草协议，不实现 Runtime”
- “只做研究，不改代码”

### Decision

影响 run 方向、任务范围、概念状态、风险姿态或 Owner 可见行为的选择。

Decision 按风险级别分类。低级决策可以由 Runtime 或 assigned Actor 处理；影响目标或 Owner 的决策必须升级。

例子：

- 重试失败验证
- 替换 active API concept
- 扩大任务范围
- 发布前询问 Owner

### Review

对 artifact 或 task result 的独立评估。

Evaluation Actor 检查验收标准、验证假设、寻找遗漏风险，并返回有限决策，如 approve、reject、needs-info、request-rework。除非明确授予 repair authority，Evaluation Actor 不应该修改被审查产物。

例子：

- code review
- design review
- security review
- documentation review

### Verification

对 claim 的确定性或工具支持检查。

验证证据应该持久化、可检查。

例子：

- `bun typecheck`
- focused test log
- schema validator output
- artifact hash comparison

### Self Check

Execution Actor 在进入 review 前提交的自检证据。

Self Check 把完成声明和具体证据连接起来。它是提交门禁，不是 Review 的替代。

例子：

- “focused test passed” 并附 log path
- “all references updated” 并附搜索结果
- “schema validates” 并附 validator output

### Known Risks

Execution Actor 对自己结果披露的已知风险。

Known Risks 是 Review 输入，不是 Review 边界。Evaluation Actor 必须独立寻找遗漏风险，并判断披露风险是否被低估。

例子：

- “browser runtime not tested”
- “migration path not verified”
- “performance impact unknown”

### Escalation

因为确定性规则不足，把决策路由给更高权限 Actor。

例子：

- 询问 Decision Actor 是否拆分返工
- 删除数据前询问 Owner
- 公开发布前询问 Owner

### Owner

人类项目负责人或用户。

Owner 不应该被询问日常工程细节，但 L4 决策必须由 Owner 决定。

例子：

- project maintainer
- product owner
- individual user

## 核心原则

本协议首先是控制协议，不是 Agent-to-Agent 聊天协议。

Agent 直接通信只能形成软约束。Execution Actor 可能忘记指令、跳过审查、误以为另一个 Actor 的结果已经最终有效，或者基于过期上下文继续推进。Runtime 拥有的状态机才是硬约束。如果 Runtime 不允许迁移，run 就不能前进。

可靠形态是：

```txt
Decision Actor -> Command -> Runtime
Runtime -> Event Log
Event Log -> Projection
Projection -> Trigger Engine
Trigger Engine -> Runtime
Runtime -> Assigned Actors
Assigned Actors -> Command -> Runtime
Runtime -> Decision Actor only when rules cannot decide
```

Execution Actor 不通过直接对话寻求批准；Evaluation Actor 不直接修改被提交产物，除非明确授予 repair authority。所有可见协作都通过持久状态和 Runtime 控制的状态迁移发生。

事件触发不能把调度权交回大模型。Agent 只产生 Command。Runtime 校验 Command、追加 Event、更新 Projection，并执行确定性 Trigger。只有当规则判断当前情况是非确定性、影响目标或影响 Owner 时，才请求模型或人类决策。

## 协议分层

### 治理层 Governance Layer

治理层不绑定 Workflow。

它定义：

- Command 校验
- Event 追加
- Projection 更新
- Gate
- Authority 检查
- Decision Level
- Memory Service
- Concept Graph
- Owner Escalation

### 编排层 Orchestration Layer

编排层描述一次 run 中工作如何组织。

它定义：

- Workflow
- Task Graph
- Assignment
- Review Loop
- Verification Step
- Recovery Policy
- Integration Policy

Workflow 属于这一层。以后可以加入其他编排形态，而不改变治理层。

### 会话层 Session Layer

会话层描述每个 Agent session 收到什么、返回什么。

它定义：

- Context Bundle
- Context Capsule
- Tool Scope
- Assignment Contract
- Result Contract
- Self Check Evidence

## Actor、Role、Capability、Authority

### Runtime

Runtime 是硬执行层。

它负责：

- durable run records
- Command validation
- append-only Event Log
- Projection update
- task lifecycle state
- transition validation
- Trigger rule evaluation
- dependency scheduling
- ownership check
- artifact reference
- permission gate
- memory retrieval policy
- review routing
- verifier execution
- recovery prompt to Decision Actor

Runtime 不做语义产品决策。它可以判断任务是否可运行、是否 blocked、是否 invalid、是否 awaiting review；但除非某个判断已经编码成确定性 gate，否则 Runtime 不应该决定 feature design 是否“好”。

### 抽象角色类别

角色类别是抽象的。一个具体 Agent 模板可以实现一个或多个类别，只要 Runtime 在 assignment 中授予了匹配的 Capability 和 Authority。

#### Decision Actor

解决确定性规则无法安全决定的选择。

职责：

- 判断是否需要 durable run
- 定义高层目标
- 批准 run outline
- 解决模糊失败
- 批准 replan
- 做取舍决策
- 判断最终结果是否可交付

默认原型：Controller。

#### Planning Actor

把目标转换成可执行结构。

职责：

- 把 Decision Actor 意图转换成 runtime-ready run draft
- 写 task description
- 准备最小上下文包
- 生成 evaluation brief
- 总结 execution output
- 维护 decision log
- 检查 task card 缺失字段
- 为 Decision Actor 压缩长历史
- 向 Memory Service 请求相关记忆
- 从检索状态和产物中组装 context capsule

默认原型：Secretary。

Planning Actor 不自动拥有决策权。它只能向 Runtime 或 Decision Actor 提交结构化 proposal。没有 Authority 时，它不能批准任务、覆盖 review failure 或修改 acceptance criteria。

#### Execution Actor

执行被分派的工作。

职责：

- 读取 task 和 context bundle
- 完成请求的工作
- 只在允许范围内写入或产生产物
- 提交结构化结果
- 声明 assumptions、changes、known risks、blockers

默认原型：Worker。

Execution Actor 默认不知道完整 run，除非 Runtime 特意放入必要全局上下文。它不能把自己标记为 approved。

#### Evaluation Actor

评估另一个 Actor 的输出。

职责：

- 根据 acceptance criteria 检查 artifact
- 独立寻找 execution result 自报风险之外的风险
- 验证或挑战 execution assumptions
- 返回 approve、reject、needs-info 等有限结果
- 写出带证据的 findings

默认原型：Reviewer、Verifier。

除非 assignment 明确授予 repair authority，Evaluation Actor 不应该修改被审查产物。返工通常是一个新的 Execution Assignment 或同一任务的 retry。

#### Integration Actor

把已批准输出合并成最终交付或合并状态。

职责：

- 合并兼容 artifact
- 检测 integration conflict
- 准备 final summary
- 检查必要批准是否存在
- 把最终状态交还 Runtime 或 Decision Actor

#### Memory Actor

为其他 Actor 准备检索后的记忆。

职责：

- 理解任务的 memory need
- 选择哪些检索记录有用
- 为目标 Actor 压缩记录
- 标记不确定和过期信息
- 解释为什么包含某条记忆

默认原型：Memory Agent。

Memory Actor 不能声明真相。它只能打包和解释 Memory Service 返回的记录。当前真相来自 Projection 和 Concept State。

#### Owner Actor

人类项目负责人或用户。

Owner 拥有 L4 决策：不可逆操作、产品方向、外部发布、策略变更、高成本动作和价值取舍。

### Runtime Service

#### Memory Service

Memory Service 是程序拥有的检索和索引层，不是 Agent。

职责：

- event indexing
- projection query
- concept graph query
- freshness / supersession check
- module / dimension filter
- evidence reference
- memory permission

Memory Service 应该返回结构化、带来源的记录，而不是只有自然语言总结。

### 默认角色原型

这些名称只是有用的默认原型，协议不应该硬编码为只有这些 Agent 类型：

- **Controller**：Decision Actor，处理目标、恢复和语义选择。
- **Secretary**：Planning Actor，起草任务记录和上下文胶囊。
- **Worker**：Execution Actor，执行 assignment 并产生产物。
- **Reviewer**：Evaluation Actor，只读审查 artifact。
- **Verifier**：确定性或工具支持的 Evaluation Actor。
- **Memory Agent**：Memory Actor，把检索结果打包成上下文胶囊。
- **Integrator**：Integration Actor，合并已批准输出。

Verifier 应尽量是确定性程序或工具包装器，例如：

- run tests
- run typecheck
- run lint
- check schema validity
- confirm file existence
- compare artifact hashes

## 交互边界

Actor 不通过直接对话作为控制机制。它们向 Runtime 提交 Command，并从 Runtime 接收 Assignment。

### Decision Actor -> Runtime

Decision Actor 直接和 Runtime 交互，处理高层生命周期操作：

- create durable run
- approve run draft
- start execution
- answer recovery request
- approve replan
- abort or pause run
- accept final completion

Decision Actor 不应该私下通知 Planning Actor。它应该请求 Runtime 创建 planning assignment。

```txt
Decision Actor -> runtime.create_draft_request
Runtime -> Planning Actor assignment
Planning Actor -> runtime.submit_draft
Runtime -> Decision Actor approval request
Decision Actor -> runtime.approve_draft
```

### Planning Actor -> Runtime

Planning Actor 向 Runtime 提交 proposal：

- run draft
- task cards
- context bundles
- evaluation briefs
- summary digests
- decision log entries

这些记录在 Runtime 校验并由 Decision Actor 批准之前，都只是 proposal。

### Runtime -> Execution Actor

Runtime 给 Execution Actor 分派一个 task assignment。Assignment 必须包含：

- task id
- goal
- scope
- allowed tools / capabilities
- context bundle references
- expected output
- acceptance criteria
- reporting schema

Execution Actor 只向 Runtime 返回结构化结果，不向其他 Agent 直接传话。

### Runtime -> Evaluation Actor

Runtime 只在提交产物通过基础结构门禁后分派 evaluation。

Evaluation Actor 接收：

- task card
- submitted result
- artifact references
- execution assumptions
- known risks
- acceptance criteria
- review rubric

Evaluation Actor 必须把 known risks 当作线索，而不是审查边界。

## Command、Event、Projection

Agent 不直接修改 governance、run 或 orchestration state。Agent 只提交 Command。

示例 Command：

- `run.draft.request`
- `run.draft.submit`
- `task.submit_result`
- `review.submit`
- `verify.submit`
- `decision.submit`
- `memory.query`
- `concept.replace.request`

Runtime 校验每个 Command。校验内容包括 schema、role authority、task ownership、write scope、dependency state、gate requirements。合法 Command 会变成一个或多个不可变 Event。

示例 Event：

- `run.draft_requested`
- `run.draft_submitted`
- `run.approved`
- `task.assigned`
- `task.result_submitted`
- `review.rejected`
- `verify.failed`
- `concept.replaced`
- `decision.recorded`

正常执行时，当前状态应该从 Projection 读取，而不是每次从原始 Event Log 重放。

Projection 示例：

- current run status
- task status table
- active concept graph
- artifact index
- evaluation findings summary
- open decision queue
- memory index

Event Log 是历史真相源。Projection 是当前操作真相。Agent 应该收到带 event reference 的 projection-backed context，而不是完整事件日志。

## Runtime 决策模型

Runtime 通过 Command、Projection、Gate 和 Trigger Rule 判断下一步，而不是读取 Agent 的自然语言总结。

优先级：

1. 校验 Command schema 和 authority。
2. 拒绝非法 Command，不改变状态。
3. 原子追加 accepted events。
4. 根据 accepted events 更新 Projection。
5. 评估 Gate 和 Trigger Rules。
6. 在需要时调度确定性 Verifier。
7. 分派下一个 eligible assignment。
8. 如果没有确定性迁移路径，请求 Decision Actor 做 bounded decision。

Runtime 不应从自然语言总结中推断状态迁移。Agent 可以解释，但只有结构化字段能改变状态。

## Trigger Rules

事件触发执行只能通过 Runtime 拥有的规则完成。Rule Engine 根据 event type 和当前 projection state 反应。

示例：

```json
[
  {
    "on": "task.result_submitted",
    "if": ["artifact_submitted", "self_check_passed", "review_required"],
    "then": "spawn_review"
  },
  {
    "on": "review.rejected",
    "then": "request_decision_actor_decision",
    "options": ["retry_same_actor", "assign_new_actor", "ask_planning_actor_to_split_rework", "abort_task"]
  },
  {
    "on": "verify.failed",
    "if": ["attempts_remaining"],
    "then": "spawn_repair"
  },
  {
    "on": "concept.replaced",
    "then": "scan_impacted_references"
  }
]
```

Trigger Rule 必须是确定性的。如果需要模型判断事件含义，规则应该路由给 Decision Actor，而不是静默生成更多工作。

## Run 和 Task 生命周期

推荐 run-level states：

```txt
drafting
ready
running
paused
blocked
reviewing
verifying
reworking
completed
failed
aborted
```

推荐 task states：

```txt
draft
ready
assigned
running
submitted
reviewing
review_rejected
review_approved
verifying
verify_failed
approved
merged
blocked
failed
cancelled
```

Runtime 拥有所有状态迁移。

## Task Card 契约

Task Card 是 assignment 的基本单位。

```json
{
  "id": "implement-timeout",
  "type": "implementation",
  "title": "Fix auth timeout behavior",
  "goal": "Ensure auth refresh returns a typed timeout failure instead of hanging.",
  "scope": {
    "read": ["packages/opencode/src/auth/**"],
    "write": ["packages/opencode/src/auth/**", "packages/opencode/test/auth/**"]
  },
  "depends_on": ["inspect-auth"],
  "context": {
    "bundle": "ctx-implement-timeout",
    "artifacts": ["artifacts/inspect-auth.md"]
  },
  "acceptance": [
    "Timeout path returns a typed error.",
    "Existing auth behavior remains compatible.",
    "Focused tests cover timeout behavior."
  ],
  "output": {
    "kind": "patch",
    "required": ["summary", "changes", "assumptions", "known_risks", "self_check", "artifacts"]
  },
  "review": {
    "required": true,
    "evaluator": "code-reviewer",
    "brief": "review-implement-timeout"
  },
  "verify": {
    "required": true,
    "commands": ["bun test test/auth/timeout.test.ts", "bun typecheck"]
  }
}
```

Task Card 可以由 Planning Actor 生成，由 Decision Actor 或策略批准。对低风险任务，Decision Actor 可以批准 run outline，然后允许 Runtime 接受符合 outline 的 Planning Actor 展开结果。

## Execution Result 契约

```json
{
  "task": "implement-timeout",
  "status": "submitted",
  "summary": "Auth refresh now returns AuthTimeoutError when the provider call exceeds the configured timeout.",
  "changes": [
    {
      "path": "packages/opencode/src/auth/session.ts",
      "kind": "modified",
      "summary": "Wrapped refresh call with timeout guard."
    }
  ],
  "artifacts": [
    "artifacts/implement-timeout/diff.patch",
    "artifacts/implement-timeout/test-log.txt"
  ],
  "assumptions": [
    "The existing timeout config should remain the source of truth.",
    "Callers already handle typed auth errors."
  ],
  "known_risks": [
    "Browser runtime was not tested."
  ],
  "self_check": [
    {
      "claim": "Focused timeout test passes.",
      "evidence": "artifacts/implement-timeout/test-log.txt"
    }
  ],
  "open_questions": [],
  "next": "review"
}
```

`known_risks` 不是 review scope，而是披露信息。Evaluation Actor 必须独立检查遗漏风险。

`self_check` 是提交门禁。非平凡任务必须提供完成声明对应的具体证据，例如命令输出、测试报告、grep 结果、artifact reference。`I checked` 不是证据。

## Evaluation 契约

```json
{
  "task": "implement-timeout",
  "status": "rejected",
  "summary": "The implementation handles the main timeout path but misses retry cancellation.",
  "findings": [
    {
      "severity": "high",
      "path": "packages/opencode/src/auth/session.ts",
      "evidence": "The timeout guard rejects but does not cancel the retry timer.",
      "recommendation": "Cancel pending retry timers when timeout wins."
    }
  ],
  "assumption_review": [
    {
      "assumption": "Callers already handle typed auth errors.",
      "status": "unverified",
      "risk": "Some callers may treat all refresh failures as generic provider errors."
    }
  ],
  "risk_review": {
    "execution_risks_valid": true,
    "omitted_risks": [
      "Retry timer can continue after timeout."
    ]
  },
  "decision": "request_rework"
}
```

Evaluation decision 应该是有限集合：

- `approve`
- `reject`
- `needs_info`
- `request_rework`

只有 Runtime 能把 evaluation decision 转换成 task state transition。

## Planning Draft Flow

当 Decision Actor 不应该消耗大量上下文来写详细任务记录时，应使用 Planning Actor。

推荐流程：

```txt
User request
  -> Decision Actor classifies durable run need
  -> Decision Actor submits high-level intent to runtime
  -> Runtime creates planning assignment
  -> Planning Actor drafts run structure and task cards
  -> Runtime validates draft shape
  -> Decision Actor approves or requests revision
  -> Runtime persists approved run
  -> Runtime starts scheduling
```

对于一两个明显任务的小 run，Decision Actor 可以跳过 Planning Actor。多 Agent 工作默认应使用 Planning Actor。

## Context Bundle

Runtime 应尽量通过引用传递上下文。Agent 默认不应该收到完整全局对话。

```json
{
  "id": "ctx-implement-timeout",
  "task": "implement-timeout",
  "goal": "Implement the approved timeout behavior.",
  "included": [
    "docs/agent-rewrite/decision-log.md",
    "artifacts/inspect-auth.md",
    "packages/opencode/src/auth/session.ts"
  ],
  "excluded": [
    "unrelated workflow branches",
    "raw transcripts from other actors"
  ],
  "summary": "Auth refresh currently waits on provider refresh without a hard timeout guard."
}
```

Context Bundle 主要由 Planning Actor 和 Memory Actor 准备。它的作用是降低上下文污染。

## 记忆模型

记忆不能是一坨全局 blob。协议必须区分历史、当前状态、检索和 Scope。

推荐记忆 Scope：

- **Run Memory**：一次执行里的临时事实和产物。
- **Project Memory**：一个仓库、产品或工作区的长期知识。
- **Team Memory**：团队跨项目共享的约定、策略和决策。
- **Global Memory**：用户级或组织级偏好和持久规则。

Scope 优先级必须显式。项目记录可以覆盖该项目里的团队约定；团队约定可以覆盖该团队里的全局偏好；历史记录不能覆盖当前 Projection。

```txt
Scoped Event Logs -> Projections -> Scoped Memory Indexes -> Memory Service -> Memory Actor -> Context Capsule
```

### Event Log

Event Log 记录历史事实。它是追加式、审计导向的，可以回答发生了什么、什么时候、谁提交了命令、Runtime 为什么接受。

普通 Agent 不应该直接读取完整 Event Log。长历史噪音大、重复多，而且包含过期事实。

每个 Scope 都可以有自己的 Event Log。Run Event Log 不应该成为 Project、Team 或 Global Memory 的唯一存放处。

### Projection

Projection 表示由事件推导出的当前操作真相。比如旧 API 名已经是 historical，新 API 名才是 active。

```json
{
  "concept": "user-profile-api",
  "current": "fetchUserProfile",
  "status": "active",
  "replaces": "getUserProfile",
  "historical": ["getUserProfile"]
}
```

### Memory Index

Memory Index 支持按 scope、namespace、module、dimension、concept、task、artifact、decision 快速检索。

推荐 dimension：

- `architecture`
- `api`
- `schema`
- `naming`
- `constraint`
- `test`
- `bug`
- `decision`
- `preference`
- `risk`

### Memory Service

Memory Service 应返回带 freshness metadata 的记录。

```json
{
  "id": "mem-user-profile-api-v2",
  "kind": "api",
  "module": "auth",
  "status": "current",
  "summary": "The active user profile API is fetchUserProfile.",
  "evidence": ["events.jsonl#event-1842", "concepts/user-profile-api.json"],
  "supersedes": ["mem-user-profile-api-v1"]
}
```

历史记录只有在查询历史或解释当前决策时才应返回，并且必须标记为 historical 或 superseded。

Memory query result 应包含 scope 和 namespace。

```json
{
  "query": "profile api naming",
  "results": [
    {
      "scope": "project",
      "namespace": "project:opencode",
      "status": "current",
      "summary": "Use fetchUserProfile in this project."
    },
    {
      "scope": "team",
      "namespace": "team:agent-platform",
      "status": "current",
      "summary": "Prefer verb-object API names for service calls."
    },
    {
      "scope": "global",
      "namespace": "global:user-jin",
      "status": "current",
      "summary": "Prefer short, direct names unless ambiguity increases."
    }
  ]
}
```

### Memory Actor

Memory Actor 可以准备 Context Capsule，但必须引用 Memory Service 记录。它不能自己搜索原始 transcript，也不能决定哪个历史事实是当前事实。

## Concept Graph 与概念稳定性

长期 Agent 工作不仅需要任务，还需要稳定的工程概念。

概念稳定性是指：重要工程概念在多次 run 和多个 session 之间保持明确身份和生命周期，即使实现细节发生变化。

如果没有概念稳定性，不同 Agent session 可能对同一个底层对象使用不同名称、假设、schema 或模块边界。每次局部修改看起来都合理，但项目会逐渐累积互相冲突的小设计。

概念治理不替代项目文档。文档、代码、schema、测试是概念的主要表达；Harness 只跟踪概念身份、生命周期、Scope、来源引用、替换关系和影响范围，让 Agent 能在多会话中安全使用和修改概念。

概念例子：

- API contract
- data schema
- naming convention
- module ownership
- architecture decision
- quality constraint
- user preference

```json
{
  "id": "user-profile-api",
  "kind": "api",
  "status": "active",
  "version": 2,
  "summary": "Use fetchUserProfile for the user profile API.",
  "source": "docs/api.md#user-profile",
  "refs": ["packages/opencode/src/auth/profile.ts"],
  "replaces": "user-profile-api@1",
  "new_information": "The API now needs provider metadata that the old profile call did not expose.",
  "evidence": ["events.jsonl#event-1842"]
}
```

Concept replacement 必须包含 `new_information`。如果没有新信息，Runtime 应拒绝替换或升级给 Decision Actor。这可以防止 Agent 基于局部偏好反复重命名或改形状。

当 Concept 被替换后，Runtime 应触发 impacted reference scanning，并在代码、文档或测试仍引用旧概念时创建后续任务。

## Gate Engine

Gate Engine 是防止绕过协议的 Runtime 组件。

示例 Gate：

- `schema_valid`
- `scope_valid`
- `dependencies_done`
- `artifact_submitted`
- `review_required`
- `review_passed`
- `verify_required`
- `verify_passed`
- `decision_approved`

规则：

- Execution Actor 不能满足 review gate。
- Evaluation Actor 不能满足 verification gate，除非 assignment 明确授予 verifier authority。
- Planning Actor proposal 不能满足 approval gate。
- Decision Actor decision 不能绕过 schema validation。
- Runtime 可以阻止任何违反 ownership 或 scope 的迁移。
- Event Trigger 不能绕过 Gate。
- Raw Memory 不能绕过当前 Projection。

## Recovery Protocol

当 Runtime 无法确定下一步迁移时，应该向 Decision Actor 请求有限决策。

```json
{
  "kind": "recovery_request",
  "run": "run-auth-timeout",
  "task": "implement-timeout",
  "reason": "review_rejected",
  "summary": "Evaluation found retry timer cancellation bug.",
  "options": [
    "retry_same_actor",
    "assign_new_actor",
    "ask_planning_actor_to_split_rework",
    "abort_task"
  ],
  "recommended": "ask_planning_actor_to_split_rework"
}
```

Decision Actor 必须从允许选项中选择一个。如果动作需要新 Task Card，Runtime 再分派 Planning Actor 起草。

## Decision Levels

决策分级应该按风险，而不是按“工程/产品”粗分。看起来技术性的选择也可能影响产品行为、兼容性、成本或安全。

分类维度：

- 可逆性
- 影响半径
- 目标偏移风险
- 价值判断含量

### L0 Deterministic

Runtime 直接决定。

例子：

- schema invalid
- dependency incomplete
- required artifact missing
- review gate not passed
- verifier command failed

### L1 Local Execution

被分派 Actor 可以自行决定并记录。

例子：

- 选择阅读顺序
- 改局部变量名
- 增加局部 helper
- 增加 scope 内 focused test

### L2 Scoped Engineering

被分派 Actor 可以执行或提案，但必须由 Evaluation Actor 确认。

例子：

- 修改 approved scope 内多个文件
- 引入内部 helper
- 调整内部错误处理
- 增加内部测试

### L3 Goal-Affecting

必须由 Decision Actor 决定。

例子：

- 改 acceptance criteria
- 改 API contract
- 扩大 task scope
- 跳过必需 verification path
- 替换 active engineering concept
- 用兼容性换实现简化

### L4 Owner-Affecting

必须由人类 Owner 决定。

例子：

- 删除用户数据
- 对外发布
- 改隐私、安全、许可策略
- 产生显著外部成本
- 做不可逆基础设施变更
- 改产品方向或价值取舍

Runtime 应维护 `goal_contract` 做 drift check。

```json
{
  "goal": "Design a multi-agent control protocol.",
  "non_goals": ["Implement runtime code in this draft."],
  "constraints": [
    "Agents do not communicate directly.",
    "Runtime owns state transitions.",
    "Evaluation Actors have no write authority over reviewed artifacts."
  ],
  "success": [
    "Define Decision, Planning, Execution, Evaluation, Memory, and Runtime interaction.",
    "Define how the runtime decides the next step."
  ]
}
```

任何 L2 以上决策，只要改变目标、违反 non-goal、放松 constraint 或改变 success criteria，就至少要升级到 L3。

## 状态和事件存储

每个重要迁移都应在下一步动作开始前持久化。

状态应拆成 run-scoped execution records 和 scoped governance records。Run 会结束，但 project、team、global governance state 要继续指导未来 run。

建议布局：

```txt
.opencode/harness/
  runs/
    <run>/
      run.json
      tasks/
        implement-timeout.json
      context/
        ctx-implement-timeout.json
      reviews/
        implement-timeout.review.json
      artifacts/
        implement-timeout/
          diff.patch
          test-log.txt
      projections/
        run-state.json
        task-state.json
      decisions.jsonl
      events.jsonl
  governance/
    concepts/
      user-profile-api.json
    constraints/
      api-compatibility.json
    decisions/
      architecture.jsonl
    memory/
      index.json
      records/
    projections/
      concept-state.json
      memory-index.json

<team-config-or-service>/
  harness/
    governance/
      concepts/
      constraints/
      decisions/
      memory/
      projections/

<global-config-or-service>/
  harness/
    governance/
      preferences/
      constraints/
      memory/
      projections/
```

`.opencode/harness/` 是 project-local harness store，不应该拥有 team 或 global memory。Team 和 global memory 可以存在更高层配置目录、共享服务或 Runtime 管理的其他 store。Project store 可以通过 Memory Service 查询这些 namespace。

Run-scoped records：

- assignments
- task states
- run artifacts
- reviews
- verification results
- run events
- run projections

Project-scoped governance records：

- active concepts
- retired concepts
- constraints
- durable decisions
- preferences
- memory indexes
- cross-run projections

Team-scoped governance records：

- shared conventions
- reusable constraints
- team-wide architecture decisions
- review policy
- shared memory indexes

Global-scoped governance records：

- user preferences
- organization policies
- global safety constraints
- reusable agent behavior preferences

Workflow-specific storage 可以作为 orchestration adapter：

```txt
.opencode/harness/runs/<run>/
  workflow/
    workflow.json
```

但长期 governance state 不应放在 workflow 目录下。Project memory 也不应在没有 scope metadata 的情况下和 team/global memory 混在一起。

Event Log 是历史真相源。Run、Task、Concept、Memory 文件是由 Event Log 和 accepted Command 推导出的 projection 或 index。Decision Log 可以是语义决策的紧凑记录，但对应的 decision event 仍然应该存在于 `events.jsonl`。

## 未决问题

- Decision Actor 是否需要批准每个 Planning Actor 生成的 Task Card？还是可以用策略批准低风险展开？
- Evaluation Actor assignment 应由 Runtime 根据 capability metadata 选择，还是由 Planning Actor 在 Task Card 中指定？
- Verification commands 应由 Planning Actor 生成、Runtime 根据 package metadata 推断，还是两者结合？
- 当正确修复需要触碰意外文件时，write scope 应该有多严格？
- `known_risks` 是否应该对所有 execution result 强制，还是只对非平凡任务强制？
- Runtime 是否应该支持直接 human approval gate？
- 哪些 Trigger Rules 应该内置，哪些应该由 run 定义？
- Memory Service 如何排序 current projection records 和 historical evidence？
- 哪些 concept kinds 在第一版必须支持 `new_information`？
- L3 Decision Actor decision 是否应该根据策略自动升级到 L4？
- 哪些 role categories 应该内置，哪些应该项目定义？
- 第一版哪些 governance records 应 project-scoped，哪些应 run-scoped？

## 初始建议

先采用保守协议：

- Decision Actor 负责决策。
- Planning Actor 起草详细记录。
- Runtime 拥有 Command 校验、Event 追加、Projection 更新、调度、Trigger Rule 和 Gate。
- Event Trigger 是确定性 Runtime 规则，不是模型拥有的调度。
- Memory 拆成 Event Log、Projection、Index、Memory Service 和可选 Memory Actor。
- 当前真相来自 Projection 和 Concept State，不来自 raw history。
- Execution Actor 只执行 assigned task。
- Evaluation Actor 审查或验证 submitted artifact。
- Deterministic Verifier 尽量用工具执行检查。
- Agent 之间不直接通信。
- 每次状态迁移都必须来自结构化记录，而不是自然语言。
- Decision Escalation 按可逆性、影响半径、目标偏移风险和价值判断含量分级。

这会让系统没那么自由，但更可靠。目标不是模拟团队聊天，而是让多 Agent 工作变成可审计的执行系统。
