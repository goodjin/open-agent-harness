# 任务持久化与断点恢复体系设计

- 日期：2026-07-23
- 状态：设计完成，待实施评审
- 适用范围：单机 SQLite、进程重启、进程崩溃、模型或工具调用中断
- 暂不覆盖：多节点调度、跨机器自动接管、异地容灾
- 需求基线：
  - `docs/harness-platform-prd-v2/`
  - `docs/features/2026-07-17-session-single-task-and-handoff-design.md`
  - 当前 `SessionTask`、`TaskRevision`、`Assignment`、`SessionResult` 与 Session 恢复实现

## 1. 目标

多 Agent 任务不能只靠 transcript 和若干状态字段维持生命。系统需要持久保存：

1. 用户最初提出了什么；
2. 后续澄清、约束和验收标准如何改变任务定义；
3. Agent 提出了什么设计与执行方案；
4. Runtime 接受了哪一版执行图；
5. 每个节点执行到了哪里；
6. 哪些外部副作用已经发生；
7. 哪些结果已提交，哪些结果仍待验收；
8. 进程中断后应继续、重试、等待用户还是停止。

本设计建立统一的任务持久化体系。系统重启后应从持久化事实重建 Task、Revision、Graph、Attempt、Interaction、Result 和 Projection，并从最后一个可证明安全的边界继续。

“完全恢复”不等于盲目重放。对于已经发起、但无法确认是否完成的非幂等外部操作，系统应恢复为 `uncertain`，要求查询外部状态或等待用户决定。重复执行一次付款、发布或删除操作，不能被包装成自动恢复。

## 2. 已确认范围

### 2.1 本轮设计范围

- SQLite 是本地运行状态的权威源。
- 不可变内容采用 content-addressed resource 保存。
- `.harness/` 下的 Markdown 是可读、可版本管理、可重建的文档投影。
- 执行图、节点状态、Attempt、事件和 Checkpoint 可查询、可审计。
- 进程启动时按任务级恢复流程完成对账和续跑。
- 兼容现有 Session、Task、Run、Assignment、SessionResult 和 Handoff。
- 设计迁移路径，不要求一次删除旧 Run 存储。

### 2.2 非目标

- 不在本阶段引入 PostgreSQL、对象存储或分布式共识。
- 不承诺任意外部副作用都能 exactly-once。
- 不把完整 transcript 复制进 Task 或 Checkpoint。
- 不用 Markdown 文件决定 Runtime 状态。
- 不要求每条模型消息生成独立 Task Revision。
- 不恢复已归档的历史 Revision。
- 不在本设计阶段修改运行时代码。

### 2.3 需求提取

| 编号 | 功能需求 | 优先级 | 对应设计 |
|---|---|---|---|
| FR-01 | 保存原始需求、澄清、约束和验收标准 | P0 | Requirement、Resource、Task Revision |
| FR-02 | 分开保存任务定义、设计方案和执行计划 | P0 | Revision、Resource、文档 Projection |
| FR-03 | 持久化执行图、节点、依赖和图版本 | P0 | Graph、Action、Edge |
| FR-04 | 持久化节点执行进度和每次执行尝试 | P0 | Action Attempt、Result、Event |
| FR-05 | 保存用户确认、输入、权限和人工决策 | P0 | Interaction |
| FR-06 | 进程重启后从安全断点恢复 | P0 | Checkpoint、Recovery Coordinator |
| FR-07 | 防止重复任务、重复节点和重复外部副作用 | P0 | Command、幂等键、lease、fencing |
| FR-08 | 文档缺失或漂移后可重建和修复 | P0 | Projection Job、Resource hash |
| FR-09 | 兼容现有 Task、Run、Assignment 和 Result | P0 | 迁移与兼容层 |
| FR-10 | 提供查询、恢复、审计和人工处置接口 | P1 | API、Audit、Recovery UI |
| FR-11 | 支持有界扫描、分页、索引和可观测指标 | P1 | 性能与可观测性设计 |
| FR-12 | 保留历史版本、事件和证据用于审计 | P1 | Event、Resource、历史 Revision |

### 2.4 用户故事

| 编号 | 用户故事 | 对应功能 |
|---|---|---|
| US-01 | 作为用户，我希望重启系统后任务从中断处继续，不必重新描述需求。 | FR-01、FR-06 |
| US-02 | 作为用户，我希望看到原始需求、当前方案、执行图和实时进度。 | FR-01、FR-02、FR-03、FR-04 |
| US-03 | 作为用户，我希望高风险操作状态不明时系统停下来询问，而不是重复执行。 | FR-05、FR-06、FR-07 |
| US-04 | 作为 Agent，我希望拿到当前 Revision、待执行节点和必要 refs，而不是重读全部 transcript。 | FR-01、FR-02、FR-03 |
| US-05 | 作为 Runtime，我希望每次恢复都有可验证的 Checkpoint、Event 和幂等边界。 | FR-04、FR-06、FR-07 |
| US-06 | 作为维护者，我希望数据库、资源、文档和 UI 不一致时能够定位并修复。 | FR-08、FR-10、FR-12 |
| US-07 | 作为项目维护者，我希望现有会话可以渐进迁移，不在一次升级中丢失历史或重复运行。 | FR-09 |
| US-08 | 作为运维人员，我希望恢复扫描有范围、有指标，不因历史任务增加而无限变慢。 | FR-10、FR-11 |

### 2.5 业务流程

| 编号 | 流程 | 对应状态机与章节 |
|---|---|---|
| FLOW-01 | 创建任务并固化需求 | Task、Revision；第 10.2 节 |
| FLOW-02 | 接受执行图并开始调度 | Graph、Action；第 10.3—10.4 节 |
| FLOW-03 | 执行节点并提交结果 | Attempt、Action；第 10.5—10.6 节 |
| FLOW-04 | 等待并恢复用户交互 | Interaction；第 9.6、13.3 节 |
| FLOW-05 | 进程启动恢复 | Recovery；第 13 节 |
| FLOW-06 | 发布和修复文档投影 | Projection；第 8 节 |
| FLOW-07 | 修订任务并切换 Revision | Task、Revision；第 9.1—9.2、17—19 节 |
| FLOW-08 | 审计、隔离和人工处置 | Audit、Recovery；第 20—21 节 |

## 3. 现状分析

### 3.1 当前持久化分布

| 数据 | 当前载体 | 当前用途 | 局限 |
|---|---|---|---|
| 用户消息 | `message`、`part` | 保存原始对话和 Turn | 没有独立、不可变的任务需求快照 |
| Session 状态 | `session.status_*` | Runtime 状态权威源 | 状态粒度是 Session，不是任务节点 |
| Task | `session_task` | Task 身份、当前 Revision、顶层状态 | 不能表达需求、执行、验收的分层关系 |
| Task Revision | `task_revision` | 任务正文、workflow JSON、结果 | `body` 和 `workflow` 承担过多职责 |
| Task 文档 | `.harness/.../task.md` | 面向用户和 Agent 阅读 | 事务后异步发布，可能缺失或漂移 |
| Run | `storage/session_protocol_run/*.json` | 旧协议执行快照 | 与 Task Revision、Assignment 存在重叠 |
| Assignment | `assignment` + content JSON | Agent 工作分配 | 状态与 Graph 节点没有独立、稳定的 Attempt 关系 |
| Result | `session_result` | canonical child result | 是结果事实，但不是完整执行进度 |
| Revision Stop | `task_revision_stop` | 修订时停止旧 child | 只覆盖 Revision 切换子流程 |
| Outbox | `session_event_outbox` | 跨事务启动和 handoff | kind 较少，尚未覆盖文档投影和通用调度命令 |
| Session Log | `session_log` | 诊断与可观测性 | 不能作为恢复权威源 |
| `dsl_context` | `session.dsl_context` | 协议运行上下文 | 兼容字段较多，不适合继续扩展为任务数据库 |

### 3.2 已有能力应保留

当前实现已经具备一批可复用机制：

- `session_task` 限制一个 Session 只有一个当前 Task。
- `task_revision` 支持 active、draft、archived 和历史版本。
- `assignment` 使用 source Run/Action 做去重。
- `session_result` 保存 canonical result，并通过 ref 关联原始证据。
- `session_event_outbox` 支持事务内登记、事务外投递。
- `task_revision_stop` 支持修订过程的 planned/applied 恢复。
- `SessionStatus.restore()` 从 SQLite 恢复 Session 状态。
- `SessionTaskRecovery` 可以继续未完成的 Revision 切换和 bootstrap。
- Run JSON 使用原子写、generation、manifest 和损坏隔离。
- Task Markdown 支持 hash 漂移检测和安全文件发布。

这些机制不需要推倒重来。新体系应把它们收进同一个任务运行模型。

### 3.3 缺口

#### 原始需求没有独立身份

`source_message_id` 能找到来源消息，却不能表达：

- 哪些消息组成任务原始需求；
- 哪些内容是用户确认过的澄清；
- 哪些约束不可被后续 Agent 修改；
- 哪些验收标准属于当前 Revision；
- 当前任务定义相对原始需求发生了什么变化。

#### 任务定义和执行状态混在一起

`task_revision.body` 保存完整 Markdown，`task_revision.workflow` 保存 action 数组和 Run 引用。它们能支持当前页面和部分恢复，但不能清楚回答：

- 这是用户目标、设计决策还是执行计划？
- Action 是否已经被 Runtime 接受？
- 哪一版图正在执行？
- 节点是等待依赖、等待资源、运行中还是等待验收？
- 同一节点重试了几次？

#### 进度依赖跨表推断

当前进度需要联合 workflow、Assignment、child Session、SessionResult 和 SessionStatus 才能重建。任何一处缺失或延迟，UI 和恢复器都可能得到不同结论。

#### 没有明确的副作用提交边界

模型推理失败可以安全重试，文件读取通常也可以。外部发布、付款、发送消息、删除数据则不同。当前恢复逻辑主要根据 tool part 是否 stale 判断，缺少节点级执行语义。

#### 数据库和文档缺少收敛账本

数据库提交后发布 Markdown 是合理方向，但目前没有持久化 projection job。文件发布失败后，只能在读取时发现缺失或 drift，不能保证自动补发。

## 4. 设计原则

### 4.1 权威源只有一个

SQLite 保存任务和执行状态事实。JSON/Markdown 不能反向覆盖数据库状态。

### 4.2 大内容与状态分离

状态进入规范化表；需求正文、设计文档、计划、报告和大结果进入 Resource Store。数据库只保存摘要、hash、ref 和结构化索引。

### 4.3 写入先提交事实，再发布投影

任务状态变更、事件和 outbox 在一个数据库事务中提交。Markdown、UI 推送、Session 唤醒等派生动作由 outbox 投递，可重试、可去重。

### 4.4 恢复依赖事实和证据

日志用于诊断，不参与状态裁决。恢复判断来自：

- 当前 Task/Revision/Graph；
- Action 和 Attempt 状态；
- Event 序列；
- Interaction；
- Result 和 Evidence ref；
- Checkpoint；
- Outbox 投递状态；
- 外部系统回查结果。

### 4.5 执行保证按副作用分类

系统不对所有节点宣称 exactly-once，而是显式选择：

- `replayable`：可安全重放；
- `idempotent`：允许至少一次执行，使用幂等键；
- `at_most_once`：提交 start checkpoint 后才执行，中断后不自动重放；
- `manual_reconcile`：中断后先回查外部状态，无法确认则等待用户。

### 4.6 所有恢复动作都可重复

恢复扫描、领取 Attempt、投递 outbox、发布文档和生成 Projection 都要幂等。进程再次崩溃时，同一流程可以从持久状态继续。

### 4.7 历史可读，只有当前版本可执行

历史 Revision、Graph 和文档保留审计能力，但 Runtime 只调度当前 active Revision 的 current Graph generation。

## 5. 总体架构

```text
User / Agent / API
        |
        v
Command Boundary
        |
        v
SQLite Transaction
  - Task / Revision / Graph / Action / Attempt
  - Interaction / Result / Event / Checkpoint
  - Outbox / Projection Job
        |
        +--------------------+
        |                    |
        v                    v
Scheduler / Recovery     Resource Store
        |                immutable bodies
        v                    |
Executor / Agent             v
        |               Markdown Projection
        v                    |
Result + Evidence            v
        +--------------> UI / SDK / Agent reads
```

### 5.1 分层

| 层 | 职责 |
|---|---|
| Command | 接收创建、修订、确认、暂停、恢复、取消等命令 |
| Domain | 维护 Task、Revision、Graph、Action、Attempt 状态机 |
| Journal | 写入追加式 Task Event |
| Resource | 保存不可变正文和证据 |
| Scheduler | 计算 ready Action、分配 Attempt、处理 lease |
| Executor | 运行模型、tool、Agent、human 或 service 节点 |
| Recovery | 启动对账、Attempt 重分类、outbox 重投和安全续跑 |
| Projection | 构建任务页、Graph、进度、文档和轻量摘要 |
| Audit | 检查事实、资源、投影和状态机不变量 |

## 6. 领域对象

### 6.1 Task

Task 表示一个稳定的用户目标。沿用 `session_task`，增加：

| 字段 | 说明 |
|---|---|
| `requirement_id` | 当前任务绑定的原始需求快照 |
| `status_reason` | 顶层状态原因码 |
| `last_event_seq` | 最近提交的任务事件序号 |
| `checkpoint_id` | 最近有效 Checkpoint |
| `schema_version` | 任务模型版本 |

一个 Session 仍然只绑定一个当前 Task。Handoff 创建平级 Session 和新 Task，不把两个顶层目标塞进同一 Task。

### 6.2 Requirement Snapshot

新增 `task_requirement`，保存不可变需求版本：

| 字段 | 说明 |
|---|---|
| `id` | `requirement_<uuid>` |
| `task_id` | 所属 Task |
| `version` | 需求版本 |
| `source_refs` | 用户消息、附件、外部文档 refs |
| `body_ref` | 规范化需求文档 |
| `body_hash` | 内容 hash |
| `constraints` | 结构化硬约束 |
| `acceptance` | 顶层验收标准 |
| `created_by` | user、agent 或 migration |
| `confirmed_at` | 用户确认时间，可空 |
| `supersedes_id` | 被替代需求版本 |

`source_refs` 保留原始证据，`body_ref` 保存整理后的可执行需求。两者不能互相替代。

### 6.3 Task Revision

沿用 `task_revision`，调整职责：

- Revision 表示已确认的任务定义版本。
- `body` 在兼容期保留，新增 `spec_ref` 后逐步转为投影缓存。
- `workflow` 在兼容期保留，新增 `graph_id` 后只保存轻量兼容摘要。
- Revision 绑定 Requirement、Design、Plan 和 Graph。

建议新增：

| 字段 | 说明 |
|---|---|
| `requirement_id` | 本 Revision 采用的需求版本 |
| `spec_ref` | 完整任务规格文档 |
| `design_ref` | 设计方案文档，可空 |
| `plan_ref` | 执行计划文档 |
| `graph_id` | 当前执行图 |
| `schema_version` | Revision schema 版本 |

### 6.4 Resource

新增统一 `task_resource` 索引：

| 字段 | 说明 |
|---|---|
| `id` | 稳定 resource id |
| `task_id`、`revision_id` | 归属 |
| `kind` | requirement、design、plan、artifact、evidence、result、log、snapshot |
| `uri` | 内容地址 |
| `hash` | 内容 hash |
| `size` | 字节数 |
| `summary` | 紧凑摘要 |
| `producer_type`、`producer_id` | 产生者 |
| `visibility` | private、task、project、exportable |
| `lifecycle` | active、archived、tombstoned |
| `time_created` | 创建时间 |

本地第一阶段可继续使用 `Global.Path.data/storage` 保存正文，但统一采用 content-addressed key。项目内 Markdown 只引用 Resource。

### 6.5 Execution Graph

新增 `task_graph`：

| 字段 | 说明 |
|---|---|
| `id` | Graph id |
| `task_id`、`revision_id` | 归属 |
| `generation` | 图版本，每次确认性重规划递增 |
| `status` | draft、active、completed、blocked、failed、cancelled、archived |
| `source_run_id` | 来源协议 Run，可空 |
| `definition_hash` | 节点与边的 canonical hash |
| `accepted_at` | Runtime 接受时间 |
| `completed_at` | 图终态时间 |
| `schema_version` | Graph schema |

### 6.6 Action

新增 `task_action`，一行对应一个已接受节点：

| 字段 | 说明 |
|---|---|
| `id` | Runtime 稳定 Action id |
| `graph_id` | 所属 Graph |
| `protocol_action_id` | 模型输出的 action id |
| `kind` | agent、tool、runtime、human、service |
| `title` | 标题 |
| `input_ref` | 规范化输入 |
| `input_hash` | 输入 hash |
| `executor` | executor 类型和目标 |
| `status` | 节点状态 |
| `priority` | 调度优先级 |
| `idempotency_key` | 幂等键 |
| `execution_mode` | replayable、idempotent、at_most_once、manual_reconcile |
| `retry_policy` | 最大次数、退避、可重试错误 |
| `timeout_ms` | 超时 |
| `criteria_ref` | 节点验收标准 |
| `result_id` | canonical result，可空 |
| `blocked_reason` | 机器可读原因 |
| `time_*` | ready、started、completed 等时间 |

### 6.7 Action Edge

新增 `task_action_edge`：

| 字段 | 说明 |
|---|---|
| `graph_id` | Graph |
| `from_action_id` | 前置 Action |
| `to_action_id` | 后置 Action |
| `kind` | requires、data、verification、conditional |
| `condition_ref` | 条件表达式，可空 |

主键为 `(graph_id, from_action_id, to_action_id, kind)`。

### 6.8 Action Attempt

新增 `task_action_attempt`。Action 是逻辑节点，Attempt 是一次实际执行：

| 字段 | 说明 |
|---|---|
| `id` | Attempt id |
| `action_id` | Action |
| `number` | 第几次执行 |
| `status` | claimed、starting、running、waiting、succeeded、failed、interrupted、uncertain、cancelled |
| `executor_id` | 本地进程/执行器标识 |
| `lease_token` | 领取令牌 |
| `lease_until` | lease 到期时间 |
| `start_committed_at` | start checkpoint 已提交时间 |
| `heartbeat_at` | 最近心跳 |
| `effect_ref` | 外部操作标识或幂等 token |
| `result_id` | 本次结果 |
| `error_ref` | 错误资源 |
| `time_started`、`time_finished` | 时间 |

同一 Action 同时只能有一个 live Attempt。使用部分唯一索引约束：

```sql
UNIQUE(action_id) WHERE status IN ('claimed', 'starting', 'running', 'waiting')
```

### 6.9 Interaction

新增 `task_interaction`，统一表示：

- 用户 input；
- confirm；
- permission；
- human acceptance；
- uncertain side effect 的人工决策。

字段包括：

| 字段 | 说明 |
|---|---|
| `id` | Interaction id |
| `task_id`、`revision_id` | 归属 |
| `action_id`、`attempt_id` | 可选执行上下文 |
| `kind` | input、confirm、permission、acceptance、reconcile |
| `status` | pending、answered、rejected、expired、cancelled |
| `request_ref` | 问题正文 |
| `response_ref` | 回答正文 |
| `source_message_id` | 对应用户消息 |
| `dedupe_key` | 防止重复创建 |
| `time_*` | 创建、回答、过期 |

现有 Question、protocol confirmation/input 和 Permission 保持对外接口，逐步投影到该表。

### 6.10 Result 与 Evidence

沿用 `session_result` 作为 Agent Session 结果事实，新增 Task 层关联：

- Action 可以引用 `session_result`；
- tool/runtime 节点结果也进入统一 Resource/Result 索引；
- Result 不复制大正文，只保存 status、summary、raw/evidence refs；
- `satisfying` 只表示是否满足依赖，不直接等同于 Task 完成。

可增加 `task_action_result` 作为统一映射：

| 字段 | 说明 |
|---|---|
| `id` | Result id |
| `action_id`、`attempt_id` | 来源 |
| `status` | completed、partial、blocked、failed、waiting_user |
| `satisfying` | 是否推进依赖 |
| `summary` | 紧凑摘要 |
| `value_ref` | 结果正文 |
| `evidence_refs` | 证据 refs |
| `session_result_id` | Agent 结果映射，可空 |
| `time_created` | 创建时间 |

### 6.11 Task Event

新增 append-only `task_event`：

| 字段 | 说明 |
|---|---|
| `task_id` | Task |
| `seq` | Task 内严格递增序号 |
| `id` | Event id |
| `type` | 事件类型 |
| `revision_id`、`graph_id`、`action_id`、`attempt_id` | 关联对象 |
| `command_id` | 触发命令 |
| `data` | 小型结构化 payload |
| `resource_refs` | 大内容引用 |
| `time_created` | 创建时间 |

主键为 `(task_id, seq)`，`id` 全局唯一。Event 与当前状态在同一事务中写入。

核心事件：

```text
task.created
requirement.recorded
revision.drafted
revision.activated
revision.archived
graph.accepted
action.ready
action.claimed
attempt.started
attempt.heartbeat
attempt.interrupted
attempt.uncertain
attempt.completed
action.completed
action.failed
interaction.requested
interaction.answered
result.recorded
checkpoint.created
projection.requested
task.completed
task.blocked
task.failed
recovery.started
recovery.decision
recovery.completed
```

Event 用于审计、增量订阅和 Projection 重建。当前状态表仍用于高效读取，不要求每次查询重放全部 Event。

### 6.12 Checkpoint

新增 `task_checkpoint`：

| 字段 | 说明 |
|---|---|
| `id` | Checkpoint id |
| `task_id`、`revision_id`、`graph_id` | 对应运行 |
| `event_seq` | 已纳入的最后 Event |
| `graph_hash` | Graph 定义 hash |
| `state_hash` | 规范化状态 hash |
| `snapshot` | 小型结构化快照 |
| `resource_refs` | 结果和证据 refs |
| `reason` | periodic、before_effect、after_effect、interaction、shutdown、migration |
| `valid` | 审计后是否有效 |
| `time_created` | 创建时间 |

Checkpoint 不是完整数据库备份。它保存恢复所需的稳定游标和摘要，具体事实仍从规范化表读取。

建议在以下边界创建：

- Graph 被接受后；
- Action Attempt 领取后、产生外部副作用前；
- 非幂等操作提交 start checkpoint 后；
- Result 与 Evidence 提交后；
- 进入 pending Interaction 前；
- Revision 激活或归档后；
- Task 进入终态前；
- 正常停机时。

## 7. 数据权威与投影规则

### 7.1 权威矩阵

| 问题 | 权威源 |
|---|---|
| 当前 Task 是谁 | `session_task` |
| 当前任务需求 | `task_requirement` + `body_ref` |
| 当前 Revision | `session_task.current_revision_id` |
| 当前 Graph | `task_revision.graph_id` |
| Action 当前状态 | `task_action.status` |
| 当前执行 Attempt | `task_action_attempt` |
| 用户是否已回答 | `task_interaction` |
| Agent child 结果 | `session_result` |
| Action 结果 | `task_action_result` |
| 恢复游标 | `task_checkpoint.event_seq` |
| 状态变化证据 | `task_event` |
| Markdown 内容 | `task_resource` 指向的正文 |
| 页面进度 | 可重建 Projection |

### 7.2 禁止作为权威源

- Session Log；
- Markdown 文件；
- 前端缓存；
- `dsl_context` 中的兼容投影；
- 模型自然语言总结；
- 仅存在于进程内的 Promise、deferred、timer 或队列。

## 8. 文档持久化

### 8.1 目录

```text
.harness/
  sessions/<session_id>/
    tasks/<task_id>/
      README.md
      requirements/
        v1.md
        v2.md
      revisions/
        v1/
          task.md
          design.md
          plan.md
          graph.md
          result.md
        v2/
          ...
      checkpoints/
        latest.md
      history/
        events.md
```

这些文件全部是 Projection。删除后可以从 SQLite 和 Resource Store 重建。

### 8.2 文档来源

| 文档 | 来源 |
|---|---|
| `requirements/vN.md` | Requirement Resource |
| `task.md` | Revision spec |
| `design.md` | Design Resource |
| `plan.md` | Plan Resource |
| `graph.md` | Graph/Action Projection |
| `result.md` | Result + Evidence Projection |
| `latest.md` | Checkpoint 摘要 |
| `events.md` | 有界 Event 摘要，不包含全部 raw log |

### 8.3 Projection Job

新增 `task_projection` 或复用扩展后的 outbox：

| 字段 | 说明 |
|---|---|
| `id` | job id |
| `task_id`、`revision_id` | 目标 |
| `kind` | task_docs、task_view、graph_view、history |
| `source_seq` | 对应 Event 序号 |
| `status` | pending、rendering、published、failed |
| `content_hash` | 期望输出 hash |
| `attempts` | 发布次数 |
| `error` | 最后错误 |

数据库事务只登记 projection job。worker 完成以下流程：

1. 读取 source facts；
2. 生成确定性内容；
3. 写临时文件并 fsync；
4. 原子 rename；
5. fsync 父目录；
6. 回写 `published` 和 hash。

如果数据库已提交而文件未发布，job 保持 pending/failed，启动恢复会继续发布。

### 8.4 漂移规则

- 文件缺失：自动重建。
- 文件 hash 与 Projection 不同：
  - 默认保留用户文件为 `.drifted.<time>.md`；
  - 重建 canonical 文件；
  - 记录 `projection.drift_detected` Event。
- 用户要修改任务：通过 Task Update 命令创建 Revision，不直接编辑投影文件改变 Runtime 状态。
- 后续如需支持“编辑 Markdown 驱动修订”，应显式提供 import/confirm 流程。

## 9. 状态机

### 9.1 Task 状态

```text
running
  -> waiting_user
  -> revising
  -> blocked
  -> completed
  -> failed

waiting_user -> running | revising | blocked | failed
revising     -> running | blocked | failed
blocked      -> running | revising | failed
```

Task 状态是当前 Revision/Graph 的汇总，不取代 Action 状态。

### 9.2 Revision 状态

```text
draft -> active -> completed
                -> failed
                -> archived
draft -> archived
```

同一 Task 只允许一个 active Revision。历史 Revision 不恢复执行。

### 9.3 Graph 状态

```text
draft -> active -> completed
                -> blocked
                -> failed
                -> cancelled
                -> archived
blocked -> active | failed | cancelled
```

### 9.4 Action 状态

```text
pending
  -> waiting_dependency
  -> ready
  -> claimed
  -> running
  -> waiting_user
  -> waiting_retry
  -> completed
  -> blocked
  -> failed
  -> cancelled
  -> uncertain
```

关键约束：

- 依赖未满足时不能进入 ready；
- 同一 Action 不能同时有两个 live Attempt；
- completed 需要 canonical satisfying result 或符合节点类型的成功事实；
- uncertain 不能自动推进依赖；
- required acceptance 未通过时不能 completed。

### 9.5 Attempt 状态

```text
claimed -> starting -> running -> succeeded
                            \-> failed
                            \-> waiting
                            \-> interrupted
                            \-> uncertain
                            \-> cancelled
```

`interrupted` 表示 Runtime 确认执行未完成且可按策略处理；`uncertain` 表示外部副作用可能已经发生，不能自动猜测。

### 9.6 Interaction 状态

```text
pending -> answered
        -> rejected
        -> expired
        -> cancelled
```

重启后 pending Interaction 仍然 pending。原进程内 deferred 丢失不影响用户继续回答。

## 10. 写入与事务协议

### 10.1 Command

每个有副作用的入口生成 `command_id` 和 `idempotency_key`。新增 `task_command`：

| 字段 | 说明 |
|---|---|
| `id` | command id |
| `task_id` | 可空，创建时后补 |
| `kind` | create、revise、accept_graph、resume、cancel 等 |
| `idempotency_key` | 调用方稳定键 |
| `status` | accepted、applied、rejected |
| `result_ref` | 幂等响应 |
| `time_created`、`time_applied` | 时间 |

同一个 idempotency key 重试时返回原结果，不重复创建 Task、Revision、Graph 或 Attempt。

### 10.2 创建任务事务

一个事务中：

1. 写 `task_command`；
2. 创建 `session_task`；
3. 创建 `task_requirement`；
4. 创建 active `task_revision`；
5. 创建 Resource metadata；
6. 创建 `task.created`、`requirement.recorded`、`revision.activated` Event；
7. 登记 Resource/Projection outbox；
8. 更新 Task `last_event_seq`。

正文写入失败时如何处理？

- 首阶段可先写 content-addressed Resource，再提交引用；
- 未被数据库引用的 Resource 由 GC 清理；
- 数据库不能引用一个尚未成功落盘的 Resource。

### 10.3 接受执行图事务

一个事务中：

1. 校验 Graph schema、依赖、环、executor、criteria；
2. 校验 Revision 仍为 active；
3. 创建 `task_graph`；
4. 批量写 `task_action` 和 edge；
5. 更新 `task_revision.graph_id` 和兼容 workflow 摘要；
6. 写 `graph.accepted` Event；
7. 为无依赖节点写 `action.ready` Event；
8. 创建 Checkpoint；
9. 登记调度 outbox 和 Projection job。

图写入完成前，任何节点都不能执行。

### 10.4 领取 Attempt 事务

Scheduler 在一个 immediate transaction 中：

1. 校验 Task、Revision、Graph 仍 active；
2. 校验 Action 为 ready；
3. 校验依赖结果仍满足；
4. 插入 claimed Attempt；
5. 把 Action 更新为 claimed；
6. 写 `action.claimed` Event；
7. 登记 executor outbox。

多个调度器竞争时，唯一索引和 compare-and-set 只允许一个成功。

### 10.5 外部副作用前

根据 `execution_mode`：

- `replayable`：可直接执行，仍记录 Attempt started。
- `idempotent`：先持久化稳定 `idempotency_key/effect_ref`，再调用外部系统。
- `at_most_once`：先提交 `start_committed_at` Checkpoint，确认落盘后才调用。
- `manual_reconcile`：除 start checkpoint 外，还要保存外部查询键。

### 10.6 完成 Attempt 事务

1. 校验 lease token；
2. 写 Result 和 Evidence metadata；
3. Attempt 更新为 succeeded/failed；
4. Action 更新为 completed、waiting_retry、blocked 或 failed；
5. 写 Event；
6. 重新计算受影响下游节点；
7. 创建 Checkpoint；
8. 登记 parent fan-in、Projection 和 scheduler outbox。

Result 正文写入应先完成，数据库事务再引用它。

## 11. Outbox

现有 `session_event_outbox` 可以扩展，也可以新增通用 `task_outbox`。建议新增 Task 级 outbox，避免 Session 语义继续膨胀。

支持 kind：

```text
executor_start
executor_cancel
scheduler_wakeup
parent_handoff
session_resume
projection_publish
resource_finalize
acceptance_start
reconcile_external_effect
```

每条 outbox 包含：

- `dedupe_key`；
- `task_id/revision_id/graph_id/action_id/attempt_id`；
- `payload`；
- `status`；
- `lease_token/lease_until`；
- `attempts/next_retry_at`；
- `delivered_at/acked_at/error`。

投递保证采用 at-least-once，consumer 必须按 dedupe key 幂等。

## 12. Checkpoint 与 Event 的关系

Event 记录“发生了什么”，Checkpoint 记录“已确认到哪里”。

恢复时：

1. 读取 Task 最近有效 Checkpoint；
2. 校验 Revision、Graph hash；
3. 校验 Checkpoint 后的 Event 序列连续；
4. 从规范化表读取当前状态；
5. 用 Event 补充或验证关键变更；
6. 如果 state hash 不一致，进入审计修复，不直接调度；
7. 如果一致，恢复 pending outbox、Interaction 和 Action。

不要求从 Event 零开始重放全部状态。Event replay 是修复和审计能力，不是正常读取路径。

## 13. 重启恢复流程

### 13.1 启动顺序

```text
open SQLite
  -> apply migrations
  -> restore Session status
  -> scan Task candidates
  -> validate Task invariants
  -> repair stale leases
  -> reconcile Attempt side effects
  -> restore pending Interaction
  -> replay/retry outbox
  -> rebuild missing Projection
  -> schedule ready Actions
  -> resume required Session loops
```

Task 恢复应早于普通 Session 自动 continue。否则 Session prompt loop 可能先于 Graph/Attempt 对账启动，重复派发旧工作。

### 13.2 候选任务

扫描范围：

- Task 状态为 running、waiting_user、revising、blocked；
- active Revision 存在；
- active Graph 未终止；
- 存在 live/stale Attempt；
- 存在 pending/delivering outbox；
- 存在 pending Interaction；
- Projection job 未发布；
- Checkpoint 落后于 `last_event_seq`。

终态 Task 只做轻量一致性检查，不进入调度恢复。

### 13.3 Attempt 恢复决策

| 条件 | 恢复结果 |
|---|---|
| claimed，executor 未开始 | lease 过期后重新入队 |
| starting/running，`replayable` | 标记 interrupted，创建新 Attempt |
| starting/running，`idempotent` | 使用原幂等键查询或重试 |
| start 未提交，`at_most_once` | 可重新执行 |
| start 已提交，`at_most_once` | 标记 uncertain，不自动重放 |
| `manual_reconcile` 且可查询外部状态 | 先查询，按结果完成或重试 |
| 无法查询外部状态 | waiting_user/blocked |
| Result 已存在但 Attempt 未结束 | 用 Result 收敛 Attempt 和 Action |
| child Session 已终态但 Result 缺失 | 走现有 fallback/synthetic result 收口 |
| pending Interaction | 保持等待，不启动重复问题 |

### 13.4 恢复锁

单机仍需要防止多个进程同时打开同一数据目录。建议：

- 进程级 `runtime_instance` 记录；
- Task recovery lease；
- Attempt lease fencing token；
- 所有状态推进校验 generation/token；
- 旧进程晚到结果若 fencing token 不匹配，只能记录 orphan evidence，不能覆盖新 Attempt。

### 13.5 恢复结果

每个任务恢复后写：

```text
recovery.started
recovery.decision
recovery.completed
```

`recovery.decision` 至少包含：

- prior state；
- evidence refs；
- selected policy；
- resumed/retried/blocked/uncertain 数量；
- 是否需要用户动作。

## 14. 正常停机

收到可处理的终止信号时：

1. 停止领取新 Action；
2. 等待短时可完成事务；
3. 标记本进程 live Attempt 为 draining；
4. flush 状态和 Event；
5. 创建 shutdown Checkpoint；
6. 释放 lease；
7. 关闭数据库。

强制退出仍由启动恢复处理。正常停机只是减少 uncertain Attempt，不替代崩溃恢复。

## 15. 任务进度 Projection

进度不再从 UI 临时拼接。新增 `task_projection_current` 或查询层 materialized view：

```json
{
  "task_id": "task_x",
  "revision_id": "revision_x",
  "graph_id": "graph_x",
  "status": "running",
  "counts": {
    "total": 12,
    "ready": 2,
    "running": 3,
    "waiting": 1,
    "completed": 5,
    "blocked": 1,
    "failed": 0,
    "uncertain": 0
  },
  "critical_path": ["action_a", "action_c"],
  "pending_interactions": [],
  "last_event_seq": 84,
  "checkpoint_seq": 82
}
```

Projection 可以重建，不参与状态写入。

## 16. API 规约

### 16.1 读取

```text
GET /session/:sessionID/task
GET /tasks/:taskID
GET /tasks/:taskID/requirements
GET /tasks/:taskID/revisions
GET /tasks/:taskID/graphs/current
GET /tasks/:taskID/actions
GET /tasks/:taskID/actions/:actionID/attempts
GET /tasks/:taskID/events?after=<seq>&limit=<n>
GET /tasks/:taskID/checkpoints/latest
GET /tasks/:taskID/resources
GET /tasks/:taskID/recovery
```

默认返回 Projection 和摘要，大正文按 ref 读取。

### 16.2 命令

```text
POST /tasks
POST /tasks/:taskID/revisions
POST /tasks/:taskID/revisions/:revisionID/activate
POST /tasks/:taskID/graphs
POST /tasks/:taskID/pause
POST /tasks/:taskID/resume
POST /tasks/:taskID/cancel
POST /tasks/:taskID/interactions/:interactionID/respond
POST /tasks/:taskID/actions/:actionID/reconcile
POST /tasks/:taskID/projections/rebuild
POST /tasks/:taskID/audit
```

所有命令接受：

```http
Idempotency-Key: <stable-key>
```

### 16.3 恢复命令结果

```json
{
  "task_id": "task_x",
  "command_id": "command_x",
  "status": "applied",
  "resumed_actions": 2,
  "retried_actions": 1,
  "blocked_actions": 0,
  "uncertain_actions": 1,
  "interaction_ids": ["interaction_x"]
}
```

## 17. 与现有对象的映射

| 现有对象 | 新体系位置 |
|---|---|
| `session_task` | 保留并增强 |
| `task_revision` | 保留，正文和 Graph 逐步 ref 化 |
| `task_revision.workflow.actions` | 迁移为 Graph/Action，保留兼容摘要 |
| `session_protocol_run` | 作为 legacy execution snapshot 和迁移来源 |
| `assignment` | 保留，绑定到 Action/Attempt |
| `session_result` | 保留，映射到 ActionResult |
| `task_revision_stop` | 保留为 Revision 切换子流程，后续可映射 Event |
| `session_event_outbox` | 保留 Session 投递，新增 Task outbox |
| `session.status_*` | 保留 Session Runtime 状态 |
| `dsl_context` | 只保留兼容投影，不新增任务权威字段 |
| Task Markdown | 改为有账本、可重建的 Projection |

## 18. 迁移方案

### 18.1 阶段 A：只建新事实，不切读取

- 增加新表和索引；
- Task/Revision 仍按当前路径读取；
- 新创建任务双写 Requirement、Event、Graph；
- 后台比较新旧进度结果；
- 不影响旧会话。

### 18.2 阶段 B：Graph 与 Attempt 成为执行权威

- 新 Task 由 Scheduler 读取 `task_action`；
- Assignment 与 child Session 创建绑定 Action/Attempt；
- `workflow.actions` 变成兼容摘要；
- SessionResult 收口同时写 ActionResult。

### 18.3 阶段 C：启用 Checkpoint 恢复

- 启动顺序调整为 Task recovery 优先；
- stale tool 恢复结合 Attempt execution mode；
- uncertain 副作用进入 reconcile；
- 旧 Session 恢复继续保留兜底。

### 18.4 阶段 D：文档投影账本

- TaskDocuments 改为 projection worker；
- 缺失、失败和 drift 自动修复；
- `.harness` 文件不再依赖事务后无账本 effect。

### 18.5 阶段 E：旧 Run 收敛

- 单 Run 可迁移为一个 Graph；
- 多 Run 维持当前人工确认边界；
- 已终态旧 Run 只读；
- 无法唯一确定 Action identity 的记录不自动标记 completed；
- 完成迁移后再评估旧 API 的退役时间。

## 19. 数据迁移规则

### 19.1 现有 Task

- `task_revision.body` 生成 spec Resource；
- `source_message_id` 及 Task source 生成 Requirement source refs；
- 缺少明确用户确认时，Requirement 标记 `migration_unconfirmed`；
- 不从模型总结反推硬约束。

### 19.2 现有 workflow

- 每个 `workflow.actions` 生成 Action；
- `run_id + action.id` 形成 legacy identity；
- `depends_on` 生成 edge；
- Assignment 和 SessionResult 能唯一匹配时关联；
- 匹配歧义时 Action 标记 blocked/migration_ambiguous。

### 19.3 当前运行中的任务

上线迁移时：

1. 暂停新任务 admission；
2. 生成 migration Checkpoint；
3. 迁移 Task/Revision/Graph；
4. 对 live Session 和 Assignment 做关联；
5. 无法确认的 running Action 标记 interrupted 或 uncertain；
6. 审计通过后恢复 admission。

不在迁移脚本中直接重放工具。

## 20. 一致性审计

新增 `TaskAudit`，检查：

- 每个 Task 有且只有一个 current Revision；
- 每个 Task 至多一个 active Revision；
- active Revision 的 Graph 存在且属于同一 Task；
- Graph definition hash 正确；
- Edge 两端 Action 都属于同一 Graph；
- completed Action 有合规 Result；
- live Action 至多一个 live Attempt；
- Attempt lease 与 executor fencing token 合法；
- pending Interaction 与 Task/Action 状态一致；
- `last_event_seq` 连续；
- Checkpoint event seq 不超过 Task last seq；
- Resource ref 可读且 hash 正确；
- Projection source seq 不超过 Task last seq；
- 终态 Task 不存在可调度 Action；
- 历史 Revision 不存在 live Attempt。

审计等级：

- `ok`：可以调度；
- `repairable`：可自动补 Projection、状态摘要或 outbox；
- `blocked`：事实存在冲突，停止调度；
- `corrupt`：关键 Resource/Event 缺失，隔离并等待人工处理。

## 21. 故障矩阵

| 中断点 | 可观察事实 | 恢复 |
|---|---|---|
| Resource 写完、DB 未提交 | 孤立 Resource | GC 清理 |
| DB 提交、Markdown 未发布 | pending projection | 自动补发 |
| Graph 写一半 | 单事务回滚 | 不可见 |
| Attempt claimed、outbox 未投递 | claimed + pending outbox | 重投 |
| outbox delivered、executor 未启动 | 无 start Event | lease 到期重投 |
| executor 启动、start 未提交 | execution mode 决定重试 |
| 非幂等操作 start 已提交、结果未知 | start checkpoint，无 Result | uncertain/reconcile |
| Result 已写、Action 未完成 | Result 与 Event 可见 | 收敛 Action |
| child 终态、SessionResult 缺失 | child terminal evidence | fallback/synthetic 收口 |
| Interaction 已创建、进程退出 | pending Interaction | 页面恢复，等待回答 |
| 用户已回答、Session 未唤醒 | answered + pending outbox | 重投唤醒 |
| Revision 已激活、Graph 未启动 | active Revision + pending bootstrap | 幂等启动 |
| 旧 Revision 停止一半 | `task_revision_stop` planned/applied | 继续停止与收集结果 |
| Event 写入失败 | 同事务状态回滚 | 重试命令 |
| Checkpoint 损坏 | hash 不匹配 | 使用前一有效 Checkpoint + Event |
| Markdown 被手工修改 | drift hash | 保存 drift 副本并重建 |

## 22. 可观测性

### 22.1 指标

```text
task_active_total
task_recovery_candidates
task_recovery_duration_ms
task_recovery_blocked_total
task_action_ready_total
task_action_running_total
task_action_uncertain_total
task_attempt_lease_expired_total
task_outbox_pending_total
task_outbox_retry_total
task_checkpoint_lag_events
task_projection_lag_events
task_projection_drift_total
task_audit_failure_total
```

### 22.2 日志

日志只记录摘要和 identity：

- task/revision/graph/action/attempt id；
- command id；
- event seq；
- from/to 状态；
- recovery decision；
- resource ref；
- error code。

正文、密钥、用户敏感数据和完整 provider payload 不进入普通日志。

### 22.3 UI

Task 页面增加：

- 当前 Requirement、Revision 和 Graph generation；
- Action 状态与依赖；
- 当前 Attempt 和重试次数；
- pending Interaction；
- last Event 与 Checkpoint lag；
- 恢复结论；
- uncertain 副作用及处理入口；
- 文档投影状态和 drift 警告。

## 23. 安全与权限

- Resource 继承 Task/Project visibility。
- Interaction response 只有授权用户可写。
- Permission 不因重启自动提升。
- 高风险 Action 默认 `manual_reconcile` 或 `at_most_once`。
- 外部幂等 token 不包含 secret。
- Result、Event 和 Checkpoint 只保存 secret ref，不保存 secret value。
- 导出任务文档时按 visibility 和 redaction policy 过滤。

## 24. 性能边界

- Task 当前页读取 Projection，不扫描全部 Event。
- Event API 使用 `(task_id, seq)` 游标分页。
- Action 按 Graph 和 status 建索引。
- Attempt 按 action/status/lease 建索引。
- Recovery 扫描使用 Task 状态、outbox 状态和 lease 索引。
- Checkpoint 按 Task 保留最近若干热记录，旧记录归档。
- Markdown history 使用有界摘要，不把全部日志渲染进一个文件。
- Resource 正文按需读取。

本地第一阶段目标：

- 100 Action；
- 500 Event；
- 50 Resource；
- 10 child Session；
- 20 Acceptance/Interaction；
- 启动恢复不做无界全文扫描。

## 25. 验收标准

### 25.1 文档与需求

- AC-01：原始用户消息和规范化 Requirement 都有稳定 ref。
- AC-02：Task Revision 能分别引用 requirement、spec、design、plan 和 graph。
- AC-03：删除 `.harness` Task 文档后可以自动重建。
- AC-04：手工修改投影文件不会改变 Runtime 状态。
- AC-05：投影漂移可检测、保留和修复。

### 25.2 执行图

- AC-06：已接受 Graph 的节点和边可查询。
- AC-07：Graph 写入失败不会留下半张可执行图。
- AC-08：同一 Action 同时只有一个 live Attempt。
- AC-09：依赖未满足的节点不能执行。
- AC-10：历史 Revision 的 Action 不能被恢复。

### 25.3 状态与进度

- AC-11：当前进度可从 Task Projection 直接读取。
- AC-12：删除 Projection 后可从事实表和 Event 重建。
- AC-13：completed Action 有 canonical Result 和 Evidence。
- AC-14：Session 状态与 Task/Action 状态不一致时能被审计发现。

### 25.4 恢复

- AC-15：Graph 接受后进程退出，重启能启动 ready Action。
- AC-16：Attempt claimed 但未启动，lease 到期后能重新领取。
- AC-17：幂等 Action 中断后复用同一个 idempotency key。
- AC-18：非幂等 Action 的 start checkpoint 已提交时不会自动重放。
- AC-19：无法确认的外部副作用进入 uncertain 并生成 Interaction。
- AC-20：Result 已提交但状态未推进时，重启能自动收敛。
- AC-21：pending input/confirm/permission 重启后仍可回答。
- AC-22：Revision 切换中断后不会出现两个 active Revision。
- AC-23：Handoff 重试不会创建两个目标 Task。
- AC-24：恢复流程重复运行不会重复创建 Attempt、Result、Interaction 或文档。

### 25.5 一致性与故障

- AC-25：每个状态变更和 Event 在同一事务提交。
- AC-26：每个外部派发都有持久化 outbox。
- AC-27：数据库提交、文档发布失败后能自动补发。
- AC-28：Event seq 缺口或 Checkpoint hash 错误会阻止调度。
- AC-29：旧 executor 的晚到结果不能覆盖新 Attempt。
- AC-30：损坏 Resource 被隔离，Task 明确进入 blocked/corrupt。

### 25.6 兼容

- AC-31：无历史 Run、单 Run、多 Run 三条兼容路径保持现有语义。
- AC-32：现有 `session_result` 继续作为 Agent child canonical result。
- AC-33：现有 Task API 在迁移阶段保持可用。
- AC-34：`dsl_context`、Session Log 和 Markdown 不再新增权威状态。

### 25.7 需求—架构覆盖

| 需求 | 架构模块 | 数据实体 | 状态机/流程 | API/操作 | 验收标准 |
|---|---|---|---|---|---|
| FR-01 | Task Definition | Requirement、Resource、Revision | FLOW-01 | Task/Requirement Read | AC-01、AC-02 |
| FR-02 | Document Fabric | Resource、Revision、Projection | FLOW-01、FLOW-06 | Resource Read、Projection Rebuild | AC-02—AC-05 |
| FR-03 | Graph Store | Graph、Action、Edge | FLOW-02 | Graph/Action Read、Graph Accept | AC-06—AC-10 |
| FR-04 | Execution Journal | Attempt、Result、Event | FLOW-03 | Attempt/Event Read | AC-08、AC-11—AC-14 |
| FR-05 | Interaction | Interaction | FLOW-04 | Interaction Respond | AC-19、AC-21 |
| FR-06 | Recovery | Checkpoint、Event、Attempt | FLOW-05 | Task Resume、Recovery Read | AC-15—AC-24 |
| FR-07 | Idempotency/Fencing | Command、Attempt、Outbox | FLOW-02、FLOW-03、FLOW-05 | 所有 Command | AC-08、AC-17、AC-18、AC-24、AC-29 |
| FR-08 | Projection | Projection、Resource | FLOW-06 | Projection Rebuild | AC-03—AC-05、AC-27 |
| FR-09 | Compatibility | Legacy Run Mapping | FLOW-07 | 现有 Task/Run API | AC-31—AC-34 |
| FR-10 | Governance | Audit、Recovery Projection | FLOW-08 | Audit、Reconcile、Recovery API | AC-19、AC-28—AC-30 |
| FR-11 | Operations | Event、Checkpoint、Outbox indexes | FLOW-05、FLOW-08 | 分页读取与指标 | AC-24、AC-28 |
| FR-12 | Audit Trail | Event、Resource、历史 Revision | FLOW-07、FLOW-08 | History/Event Read | AC-01、AC-12、AC-25、AC-30 |

未覆盖项：无。

## 26. 测试策略

### 26.1 状态机测试

- 合法状态转换；
- 非法跳转拒绝；
- optimistic compare-and-set；
- active Revision/Attempt 唯一约束；
- dependency satisfaction；
- acceptance gate。

### 26.2 崩溃点测试

在每个事务和副作用边界注入崩溃：

```text
before resource write
after resource write
before DB commit
after DB commit
before outbox claim
after outbox claim
before executor start
after executor start
before result write
after result write
before checkpoint
after checkpoint
before projection rename
after projection rename
```

每个用例重启 Runtime 两次，验证恢复幂等。

### 26.3 真实实现测试

- 使用真实 SQLite 和临时目录；
- 不复制 Runtime 状态机逻辑到测试；
- 文件测试验证 fsync/rename 后的实际文件；
- child Session 使用真实 Session/Assignment/Result 路径；
- 外部副作用用可查询的本地测试服务，不只断言 mock 调用次数。

### 26.4 模糊与属性测试

随机生成：

- DAG；
- Action 状态序列；
- crash 点；
- outbox 重投；
- lease 到期；
- result 晚到；
- Revision 切换。

持续验证不变量：无双 active Revision、无双 live Attempt、无错误依赖推进、无终态回退。

## 27. 实施切片

### M0：需求与事件基础

- `task_requirement`
- `task_resource`
- `task_event`
- command idempotency
- 现有 Task 双写 Event

独立验收：Task 创建、修订和结果能够形成连续 Event 与 Resource refs。

### M1：规范化 Graph

- `task_graph`
- `task_action`
- `task_action_edge`
- 旧 workflow 双写和对比

独立验收：同一个 Task 的新旧进度投影一致。

### M2：Attempt 与 Scheduler

- `task_action_attempt`
- lease/fencing
- Task outbox
- execution mode

独立验收：进程中断后 replayable/idempotent Action 可恢复，双 Attempt 被约束。

### M3：Checkpoint 与恢复协调器

- `task_checkpoint`
- Task-first bootstrap
- uncertain/reconcile
- recovery event

独立验收：故障矩阵中的恢复用例通过。

### M4：文档 Projection

- projection job
- TaskDocuments 收敛
- drift 修复
- rebuild API

独立验收：删除、损坏、延迟发布均可恢复。

### M5：迁移与 UI

- 旧 Task/Run 迁移
- Task 进度 Projection
- Action/Attempt/Recovery UI
- 审计入口

独立验收：新旧会话可读，旧数据不被错误重放。

每个里程碑都应支持独立实现、独立验证、渐进启用。通过 feature flag 控制新写入、新读取和新调度，避免在一个发布中同时切换所有权威路径。

## 28. 主要风险

### 双模型长期并存

如果 `workflow.actions` 和新 Graph 同时可写、同时可调度，两套状态会继续漂移。迁移期允许双写比较，但每个阶段只能有一个调度权威源。

### Event 被误当成万能数据库

全量 event sourcing 会放大实现成本。当前方案保留规范化状态表，Event 用于审计、订阅和修复。

### Checkpoint 保存过多正文

Checkpoint 只保存游标、hash、状态摘要和 refs。正文进入 Resource。

### exactly-once 宣称过度

数据库事务内可以精确约束状态，但数据库与外部世界之间无法凭空获得 exactly-once。设计通过 execution mode、幂等键、start checkpoint 和 reconcile 暴露边界。

### 启动扫描过重

恢复候选必须由索引筛选，不能枚举全部历史 Event、Run 和 Resource。

## 29. 外部方案对照

本设计只吸收与当前问题直接相关的做法：

- durable workflow 需要持久化执行历史和状态边界；
- at-least-once 适合幂等操作；
- at-most-once 需要在执行前确认 start checkpoint；
- 进程恢复要防止同一工作被多个 executor 同时接管；
- 日志不能替代执行历史和当前状态。

这些原则与当前仓库的 SQLite、outbox、Assignment 去重和 SessionResult 模型兼容。无需引入外部工作流引擎。

参考：

- AWS Step Functions，Workflow type 与 execution guarantee：
  `https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html`
- AWS Durable Execution SDK，Idempotency and retries：
  `https://docs.aws.amazon.com/durable-execution/patterns/best-practices/idempotency/`
- DBOS，Workflow Recovery：
  `https://docs.dbos.dev/production/workflow-recovery`

## 30. 决策摘要

| 决策 | 选择 |
|---|---|
| 状态权威源 | SQLite |
| 大正文 | content-addressed Resource |
| Markdown | 可重建 Projection |
| 进度 | Action/Attempt 事实 + Projection |
| 审计 | append-only Task Event |
| 恢复边界 | Task Checkpoint + Event seq |
| 外部派发 | durable outbox |
| 重复执行控制 | command/action idempotency + lease fencing |
| 非幂等中断 | at-most-once 或 manual reconcile |
| 旧模型 | 渐进迁移，不立即删除 |
| 启动顺序 | Task recovery 先于 Session auto-continue |

这套体系的落点很清楚：需求有不可变来源，设计和计划有可引用文档，执行图有规范化节点，进度有事实表，副作用有提交边界，恢复有 Checkpoint，文档丢失可以重建。系统不再靠“看起来像上次执行到这里”继续，而是根据已提交事实决定下一步。
