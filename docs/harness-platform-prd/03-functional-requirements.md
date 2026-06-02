# 功能需求

## 1. 功能模块

| 模块 | 名称 | 优先级 | 描述 |
|---|---|---|---|
| M-001 | Runtime Kernel | P0 | 接受 Command / Action，执行 normalization、validation、routing、gate、event、projection、trace。 |
| M-002 | Model Runtime Protocol | P0 | 支持模型 DSL、toolCall carrier、Action Graph、Observation 和 recovery。 |
| M-003 | Action Executor System | P0 | 支持 tool、agent、runtime、human、pipeline、service executor 和执行环境契约。 |
| M-004 | Agent System | P0 | 管理 Agent Template、Agent Session、Assignment、Capability、Permission、Relationship 和 Orchestration Policy。 |
| M-005 | State and Trace System | P0 | 管理 Event Log、Projection、Materialized State、Trace、Artifact Index、Replay 和 Export。 |
| M-006 | Context and Memory System | P0 | 构造 Context Bundle，管理 Memory scope、Visibility、Observation 和 redaction。 |
| M-007 | UI Console | P0 | 提供 Run Console、Session Workbench、Agent Manager、Protocol Panel 和 Governance View。 |
| M-008 | Workflow Adapter | P1 | 支持 durable Workflow Profile、DAG、bounded loop、verification gate 和 recovery。 |
| M-009 | API / SDK | P1 | 提供 Command API、Projection API、Trace API、Agent API、Adapter API 和 client SDK。 |
| M-010 | Evaluation and Model Policy | P2 | 支持 Evaluation Adapter、Model Policy、Regression Gate、成本策略和 fallback。 |

## 2. 功能需求清单

### M-001 Runtime Kernel

| 编号 | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-001 | 系统应创建、更新、暂停、恢复、取消和终止 Run。 | P0 | Run 状态通过 Event 记录，并能投影到 UI。 |
| FR-002 | 系统应接受 UI Command，并执行 schema、authority、gate 和 Projection 校验。 | P0 | 失败 Command 不产生部分状态；成功 Command 产生 Event。 |
| FR-003 | 系统应把模型输出、toolCall、delegation request、adapter operation 归一化为 Action。 | P0 | 所有执行路径进入统一 Action record。 |
| FR-004 | 系统应维护 Action Graph，并按依赖、budget、resource lock 和 permission 调度。 | P0 | 并行和串行 Action 都能正确进入 ready/running/completed/failed 状态。 |
| FR-005 | 系统应在每次 mutation 后更新 Projection。 | P0 | UI 默认读取 Projection，Event 可用于回放。 |
| FR-006 | 系统应为失败、阻塞和等待状态提供 blocker reason。 | P0 | UI 能展示阻塞原因、证据和可选恢复操作。 |

### M-002 Model Runtime Protocol

| 编号 | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-007 | 模型可输出 `act`、`answer`、`done` 三类协议对象。 | P0 | Runtime 可解析并执行或返回用户可见回答。 |
| FR-008 | `act.calls[]` 支持 `type/name/args/depends_on/result/criteria/failure/budget/visibility/artifacts/handoff/context/gate`。 | P0 | Runtime 能把 calls 展开为 Action Graph。 |
| FR-009 | Runtime 支持 toolCall carrier。 | P0 | 模型通过 `AgentProtocolOutput` 等入口提交协议对象后，进入同一执行路径。 |
| FR-010 | Runtime 支持安全恢复直接 tool request。 | P0 | 恢复 Action 标记 `origin.kind = "recovered"`，并记录 trace。 |
| FR-011 | Runtime 应把执行结果转成精简 Observation。 | P0 | 模型下一轮上下文收到 summary、structured result 或 artifact refs，而不是无筛选 raw output。 |

### M-003 Action Executor System

| 编号 | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-012 | 系统支持 tool executor。 | P0 | Tool schema 校验、权限检查、结果存储和 Event 记录完整。 |
| FR-013 | 系统支持 agent executor。 | P0 | Runtime 创建 Assignment 和 Agent Session，并记录 child session trace。 |
| FR-014 | 系统支持 runtime executor。 | P0 | summarize、wait、checkpoint、projection rebuild 等内部操作可作为 Action 执行。 |
| FR-015 | 系统支持 human executor。 | P0 | 人工审批或澄清进入 Decision Queue，用户回答后推进状态。 |
| FR-016 | 系统支持 Sandbox、Workspace、Manifest、Snapshot 和 Rehydration。 | P0 | 每次执行有环境记录；恢复时可重建 executor 可见环境。 |
| FR-017 | 系统支持 pipeline 和 service executor。 | P1 | 外部服务和预定义流程通过同一 Action/Event/Trace 模型接入。 |

### M-004 Agent System

| 编号 | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-018 | 系统支持 Agent Template registry。 | P0 | package、user、project 模板可加载、校验、诊断和展示。 |
| FR-019 | Agent Template 支持 entry、capability、permission、model_preference、execution_mode、relationships 和 orchestration_policy。 | P0 | Agent Manager 能展示和编辑 user/project 模板。 |
| FR-020 | Runtime 可基于 Agent Template 创建 Agent Session。 | P0 | Session 有稳定 id、source agent、Assignment、authority、session log、trace refs 和 status。 |
| FR-021 | Assignment authority 由 Runtime 推导。 | P0 | Agent 默认不继承外部权限；`inherit_permissions` 默认 false。 |
| FR-022 | Runtime 可根据 capability、entry、permission、availability 和 budget 选择 Agent。 | P0 | `target: "auto"` 能选择合适 Agent，并记录 routing decision。 |
| FR-023 | Runtime 支持 Agent relationships 和 orchestration_policy。 | P1 | Developer 完成后可自动触发 test/review 等后续 Assignment。 |

### M-005 State and Trace System

| 编号 | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-024 | 系统应持久化 Event Log。 | P0 | Event 有 seq、time、type、actor、scope、refs 和 data。 |
| FR-025 | 系统应生成和持久化 Projection。 | P0 | Projection 可从 Event 和 Materialized State 重建。 |
| FR-026 | 系统应维护 Trace。 | P0 | Trace 可连接 Action、Assignment、Executor、Artifact、Gate、Decision 和 Observation。 |
| FR-027 | 系统应维护 Artifact Index。 | P0 | Artifact 有 id、producer、type、status、uri、summary、visibility 和 evidence。 |
| FR-028 | 系统应支持 replay、export 和 recovery。 | P1 | Runtime 重启后可恢复未完成 Run，并导出审计材料。 |

### M-006 Context and Memory System

| 编号 | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-029 | Runtime 为每次模型调用构造 Context Bundle。 | P0 | Context Bundle 包含目标、Projection、Artifact refs、Memory refs、约束、依赖和语义解释。 |
| FR-030 | 系统支持 Memory scope。 | P0 | Memory 可按 run、project、team、global 检索，并带 evidence refs。 |
| FR-031 | 系统支持 Visibility Policy。 | P0 | model、user、logs、trace、future_runs、runtime_only 通道可分别控制。 |
| FR-032 | 系统支持 redaction。 | P0 | secret、credential、private key、personal data、敏感路径和 token 在回放或导出前脱敏。 |

### M-007 UI Console

| 编号 | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-033 | UI 提供 Run Console。 | P0 | 用户可查看 Run list、Run detail、Action Graph、Assignment、Decision、Artifact 和 Trace。 |
| FR-034 | UI 提供 Agent Session Workbench。 | P0 | 用户可进入 root、child、descendant session，并提交 `session.message.submit`。 |
| FR-035 | UI 提供 Agent Manager。 | P0 | 用户可创建、编辑、启用、禁用、诊断 Agent 模板。 |
| FR-036 | UI 提供 Protocol Panel。 | P0 | 用户可查看模型 declaration、recovered request、Action Graph、routing、Observation 和协议错误。 |
| FR-037 | UI 提供 Governance View。 | P1 | 用户可查看 Authority、Memory、Concept、Trace Export、Redaction 和 Audit Evidence。 |
| FR-038 | UI 状态变更通过 Command 提交。 | P0 | UI 不从自然语言 transcript 推断系统状态。 |

### M-008 Workflow Adapter

| 编号 | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-039 | 系统支持 Workflow Profile。 | P1 | Workflow 可定义 goal、nodes、depends_on、criteria、failure、budget、visibility、artifacts 和 handoff。 |
| FR-040 | Workflow Profile 展开为 Harness Action Graph。 | P1 | Workflow 节点进入统一 Action/Event/Projection/Trace 路径。 |
| FR-041 | Workflow 支持 bounded loop。 | P1 | test-fix-retest 等循环可受 max_attempts 和 until 条件控制。 |
| FR-042 | Workflow 支持 verification 和 gate。 | P1 | 测试、审查、审批和 release gate 可阻塞或推进 workflow。 |
| FR-043 | Workflow 支持 durable recovery。 | P1 | 进程重启后可从 adapter state、Event、Snapshot 和 Artifact 恢复。 |

### M-009 API / SDK

| 编号 | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-044 | 提供 Runtime Command API。 | P1 | UI、CLI 和 SDK 可提交 Command 并获得 Projection summary。 |
| FR-045 | 提供 Projection Query API。 | P1 | 客户端可按 run、action、assignment、agent、workflow 查询状态。 |
| FR-046 | 提供 Trace Export API。 | P1 | 支持 redaction 后导出。 |
| FR-047 | 提供 Agent Management API。 | P1 | 支持模板 CRUD、enable/disable、diagnostics。 |
| FR-048 | 提供 Adapter Operation API。 | P1 | Workflow、Evaluation 和 Release Gate 可通过 adapter operation 接入。 |

### M-010 Evaluation and Model Policy

| 编号 | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-049 | 系统支持 Model Policy。 | P2 | 可配置模型选择、预算、fallback、缓存和调用策略。 |
| FR-050 | 系统支持 Evaluation Adapter。 | P2 | 可定义 Trial、Grader、Outcome、Metric 和 Regression Gate。 |
| FR-051 | 系统支持运行对比。 | P2 | 同一任务可比较不同 Agent、模型或策略的 Trace 和 Outcome。 |

## 3. 用户故事

### US-001：创建受治理 Run

作为个人开发者，我想把一个自然语言目标提交给 Harness，以便系统用可观察、可恢复的方式执行任务。

验收标准：

- AC-001-01：提交目标后系统创建 Run，并显示初始 Projection。
- AC-001-02：模型输出 `act` 时，UI 可展示 Action Graph。
- AC-001-03：每个执行步骤都有 Event 和 Trace。
- AC-001-04：Run 完成后显示 final answer、Artifact 和证据链。

### US-002：查看和进入子 Agent Session

作为用户，我想进入某个 child Agent Session 查看上下文和补充信息，以便精确影响对应任务。

验收标准：

- AC-002-01：UI 展示 root、child、descendant session tree。
- AC-002-02：打开 session 后能看到 Assignment、authority、Context Bundle summary、Artifact refs 和 Trace。
- AC-002-03：用户输入通过 `session.message.submit` Command 进入 Runtime。
- AC-002-04：该输入只影响目标 session 的后续 Context Bundle。

### US-003：自动开发后测试和审查

作为技术负责人，我想让 Runtime 在开发 Agent 完成后自动触发测试和审查 Agent，以便减少遗漏。

验收标准：

- AC-003-01：Agent 模板可声明 `orchestration_policy.on_completed`。
- AC-003-02：Runtime 命中策略后创建后续 Action 或 Assignment。
- AC-003-03：后续 Assignment 有独立 authority，不继承来源 Agent 权限。
- AC-003-04：parent action 根据 required 和 failure 策略进入 completed、partial、blocked 或 failed。

### US-004：审批高风险操作

作为团队 Owner，我想在高风险工具调用前审批或拒绝，以便控制副作用。

验收标准：

- AC-004-01：高风险 Action 进入 `waiting_permission`。
- AC-004-02：Decision Queue 展示资源范围、side effects、风险和证据。
- AC-004-03：用户批准后 Runtime 写入 Event 并继续执行。
- AC-004-04：用户拒绝后 Action 进入 blocked、cancelled 或 failed，并记录原因。

### US-005：恢复失败的长任务

作为用户，我想在进程重启或 Action 失败后继续执行任务，以便不丢失已有工作。

验收标准：

- AC-005-01：Runtime 能从 Event Log 和 Materialized State 重建 Projection。
- AC-005-02：系统能通过 Manifest 和 Snapshot 重建执行环境。
- AC-005-03：恢复后写入 `rehydration.completed` 或 `rehydration.failed`。
- AC-005-04：UI 展示恢复前后的 Trace。

## 4. 业务规则

| 编号 | 规则 | 优先级 |
|---|---|---|
| BR-001 | 当 Command 未通过 schema、authority 或 gate 校验时，系统不写入状态变更 Event。 | P0 |
| BR-002 | 当 Action 委派给 Agent Session 时，系统创建 Assignment，并独立推导 authority。 | P0 |
| BR-003 | 当模型输出直接 tool request 且满足恢复条件时，系统可恢复为 Action，并记录 `origin.kind = "recovered"`。 | P0 |
| BR-004 | 当 Projection update 失败时，系统标记 Projection stale，并阻止新的 mutation 直到 rebuild 完成。 | P0 |
| BR-005 | 当 Artifact 包含敏感内容时，系统按 visibility 和 redaction policy 控制回放、展示和导出。 | P0 |
| BR-006 | 当子任务完成但必要验证、handoff、Artifact 或 gate 未完成时，系统使用 `partial`，而不是 `completed`。 | P0 |
| BR-007 | 当 Agent 不可见、不可委托、被禁用或权限不匹配时，Routing 不选择该 Agent。 | P0 |
| BR-008 | 当用户在 UI 中操作状态时，系统要求通过 Command 进入 Runtime。 | P0 |

