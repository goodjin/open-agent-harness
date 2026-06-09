# UI 控制台与 Agent 管理协议

## 目的

Harness UI 是用户管理、观察和使用 Harness 系统的操作面。UI 读取 Runtime Projection、Trace、Event、Artifact、Memory 和 Agent registry；用户操作通过 Command、受控 Action 或场景化 operation 进入 Runtime。

UI 不从自然语言 transcript 推断系统状态。它展示 Runtime 已接受和投影出的结构化状态，并让用户在合适边界内创建 run、切换 Agent、进入不同 Agent Session、批准决策、恢复执行、审查证据和导出 trace。

## Surface

UI 由五类 surface 组成：

- **Harness Console**：管理 Run、Task、Action、Assignment、Gate、Decision、Artifact、Event、Projection 和 Trace。
- **Agent Session Workbench**：展示 root session、child session、descendant session，并允许用户进入不同 Agent Session 继续交互。
- **Agent Manager**：管理 Agent 模板、entry、capability、permission、model preference、relationships、orchestration policy 和启用状态。
- **Protocol / Workflow Panel**：观察模型 DSL、Action Graph、Workflow 资产、executor routing、state record 和恢复状态。
- **Governance View**：观察 Memory、Concept、Authority、Gate、Trace export、redaction 和 audit evidence。

## 数据读取模型

UI 默认读取 Projection。Event Log、raw trace、executor logs 和 Artifact 原文作为证据入口存在，不作为常规状态源。

UI 读取对象：

- `Run`
- `Task`
- `Action`
- `Assignment`
- `Agent Session`
- `Artifact`
- `Gate`
- `Decision`
- `Event`
- `Trace`
- `Memory`
- `Concept`
- `Agent`
- `Workflow Profile`
- `Workflow Asset`
- `Workflow Run`

每个 UI record 都应包含稳定 id、status、summary、refs、evidence、actor、time、visibility 和 provenance，让人类和后续 Agent Session 都能读取和复用。

## Command 模型

会改变系统状态的 UI 操作提交为 Command。Runtime 校验 schema、authority、gate、当前 Projection 和 redaction policy 后，追加 Event 并更新 Projection。

Command 类型：

- `run.create`
- `run.pause`
- `run.resume`
- `run.abort`
- `task.summary.confirm`
- `task.summary.revise`
- `task.summary.cancel`
- `task.retry`
- `task.cancel`
- `action.retry`
- `assignment.cancel`
- `session.pause`
- `session.resume`
- `session.result.get`
- `decision.answer`
- `permission.approve`
- `permission.reject`
- `verify.rerun`
- `session.message.submit`
- `session.focus`
- `workflow.create`
- `workflow.save_from_run`
- `workflow.update`
- `workflow.run`
- `workflow.archive`
- `agent.enable`
- `agent.disable`
- `agent.update`
- `concept.replace.request`
- `projection.rebuild.request`
- `trace.export.request`

Command result 返回更新后的 Projection summary、Event refs、Trace refs 和可见的 blocker / rejection reason。失败的 Command 不产生部分状态。

## Harness Console

Harness Console 展示受治理 run 的当前状态和证据链。

核心视图：

- Run list：status、goal、owner、current phase、progress、blocked reason、pending decision、updated time。
- Run detail：Goal Contract、Action Graph、Assignment list、Artifact Index、Gate state、Decision queue、Trace summary。
- Task / Action detail：operation、executor、depends_on、criteria、failure、budget、visibility、status、result、artifacts、events。
- Assignment detail：Agent Session、authority、Context Bundle summary、contract、result、unresolved、child trace。
- Gate detail：gate 输入、判定结果、证据、阻塞原因、可用 Decision。
- Event Explorer：按 sequence、type、actor、scope、refs 和 status 检查已接受事实。
- Audit Export：按 visibility 和 redaction policy 导出 trace、event、artifact summary 和 decision evidence。

Console 中的 graph、timeline、progress、summary 和 comparison view 都是 Projection 或 Trace 的展示形态。

## 多 Agent Session 交互

用户可以与不同 Agent Session 交互，而不是只能停留在一个主会话里。

Session Workbench 展示：

- root session
- child session
- descendant session
- bottom child-session status panel
- right task bar
- Workflow asset management session
- review / test / debug / research 等 specialist session
- waiting_user、waiting_permission、blocked、partial、failed 等状态标记

用户可以：

- 打开任意 Agent Session 查看 session log、Context Bundle 摘要、Assignment、authority、Artifact refs 和 Trace。
- 在某个 Agent Session 内提交补充输入，形成 `session.message.submit` Command。
- 对 waiting_user / waiting_permission 的 session 提供回答、批准或拒绝。
- 从 parent session 跳转到 child session，也可以从 child session 回到 parent run projection。
- 查看某个 Agent Session 的上下文来源，包括 Projection、Memory、Artifact、Trace 和语义解释提示。
- 将某个 session 的 Artifact、summary 或 unresolved issues 作为 Handoff 输入交给后续 Agent Session。
- 在等待子会话结果时，通过底部状态框查看每个子会话的当前状态和结果入口。
- 在右侧任务栏查看当前会话关联的任务内容、执行状态和持久化结果。

Agent Session 之间仍不直接通信。用户在 UI 中进入某个 session，是把输入提交给 Runtime；Runtime 再根据该 session 的 authority、Assignment、Context Bundle 和当前 Projection 构造下一次模型调用。

### 子会话状态框

当父会话等待一个或多个子会话结果时，Session Workbench 底部应显示 child-session status panel。该 panel 读取 Runtime Projection，不从聊天文本推断状态。

每个子会话一行：

- 状态图标。
- 会话标题。
- 状态名称。
- 最近更新时间或简短 current summary。
- 操作按钮。

操作按钮：

| 操作 | 可用条件 | Command / Runtime 行为 |
|---|---|---|
| 暂停 | child session `running`、`ready` 或 `idle` | `session.pause`，Runtime 写入 pause / cancellation-safe state。 |
| 恢复 | child session `paused`、`idle`、`interrupted` 或可恢复的 `blocked` | `session.resume`，Runtime 根据 Projection 构造下一轮输入。 |
| 获取结果 | child task status 为 `completed` | `session.result.get`，返回与 child task 绑定的 canonical ResultRecord。 |
| 查看结果 | child task 有 canonical ResultRecord | 打开 result modal，展示该 task 的 summary、criteria、artifacts、changes、risks、unresolved 和 refs。 |
| 打开会话 | 任意状态 | 进入 child session workbench。 |

状态图标语义：

| Status | 图标语义 |
|---|---|
| `running` | 活跃执行。 |
| `idle` | 等待 fan-in、通知或下一步调度。 |
| `paused` | 已暂停，可恢复。 |
| `waiting_user` | 等待用户输入。 |
| `waiting_permission` | 等待权限审批。 |
| `blocked` | 有明确阻塞原因。 |
| `partial` | 有可用部分结果。 |
| `interrupted` | 需要恢复判断。 |
| `failed` | 已失败。 |
| `completed` | 已完成，可获取结果。 |

`session.result.get` 与会话结束自动回复使用同一份结果。Runtime 不应为 UI 获取动作重复生成结果；如果目标 Task completed 但没有 ResultRecord，Runtime 先请求该 Task 对应 Session 输出 `done.result`，再持久化并返回。

协议恢复：

当加载会话发现最后一条 assistant message 只有 native `AgentProtocolOutput`，但没有 protocol summary、context、response、malformed 或 recovery hint，Runtime 可以进入选择性恢复。恢复不得直接重放整个 protocol package，因为中断前可能已经开始执行非幂等工具或创建子会话。

选择性恢复规则：

| Action | Runtime 行为 |
|---|---|
| `confirm` | 可重新建立 pending user confirmation，让 UI 恢复确认框。 |
| `agent` | 先按 action id 查找已创建 child session；存在时只检查 delegation result 和 child session status，必要时恢复该 child session，不创建重复 child；不存在时才创建新的 child session。 |
| `tool` / `runtime` / 其他 action | 不自动重放。写入 recovery hint，引导用户重新发送或澄清请求，让模型基于当前状态生成新的 protocol package。 |

如果内存中的 question 队列在重启后丢失，但 session `dsl_context.protocol.confirmations` 仍有 `pending` confirmation，`question.list` 应从持久状态合成最新 pending request。确认交互只在会话 timeline 内以请求卡展示，不使用全局弹框或 composer 浮层；用户点击 Confirm / Cancel 时客户端必须提交明确 `response: "confirm" | "cancel"`，Runtime 更新 confirmation 状态，并用明确的用户输入继续对应会话。确认或取消后，请求卡折叠为只读占位，可展开查看原 plan，但不能再次修改。

### 右侧任务栏

Session Workbench 右侧应提供 task bar，用于记录当前会话的任务序列。

任务栏字段：

- task id。
- task title。
- task content / summary。
- source：user input、model `task_summary`、user revised summary 或 Runtime generated。
- status：draft、ready、running、waiting_user、waiting_permission、blocked、partial、completed、failed、interrupted、cancelled。
- owner session。
- child sessions。
- criteria。
- result ref。
- latest update。

任务内容默认来自用户输入。模型也可以在执行前通过 `kind: "task_summary"` 输出任务摘要；Runtime 将其作为 pending task content 展示给用户确认。用户确认后，任务栏使用确认后的内容；用户修改后，任务栏保存 revised content，并以它作为后续 Run / Action Graph 的任务合同来源。

任务栏支持一个会话内多个任务的切换与历史回看，默认展示当前 task。用户可以点开历史任务查看对应状态和结果。

当某个任务有 ResultRecord 时，该任务的任务栏展示结果入口。点击后打开 result modal。Result modal 展示该任务的 canonical result；如有 revision，可展示历史版本，但父会话汇总默认只读取该任务的 canonical revision。

## Agent Manager

Agent Manager 把 Agent 作为受治理 runtime object 管理。

它展示：

- Agent id、name、description、persona
- source：package、user、project
- entry flags：primary、delegable、mentionable、default、hidden
- capability：purpose、tags、cost、writes
- permission：permission_mode、allowed_tools、denied_tools、inherit_permissions
- model preference
- relationships
- orchestration_policy
- enabled / disabled state
- diagnostics

用户可以创建、编辑、启用、禁用 user/project Agent 模板。Package / builtin 模板作为只读来源展示。Disabled Agent 仍在 Agent Manager 中可见，但不会进入普通 picker、mention suggestions 或 delegation candidate。

Agent Manager 需要区分 capability 和 authority：capability 说明 Agent 适合做什么，authority 由 Runtime 在具体 Assignment 中授予。

## Protocol 与 Workflow Panel

Protocol Panel 展示模型与 Runtime 的结构化交互。

它展示：

- model declaration
- recovered tool request
- Action Graph
- selected Action detail
- executor routing
- result
- Runtime Observation
- protocol error
- recovery event
- trace export

Workflow Panel 展示用户创建、保存或命名后的 Workflow 资产，以及从这些资产启动的 Workflow Run。

它展示：

- Workflow Profile
- Workflow asset metadata
- Workflow Run history
- materialized Action Graph
- node status
- ready / running / blocked / partial / failed nodes
- loop attempt
- Decision queue
- Handoff chain
- Artifact Index
- recovery / rehydration status
- workflow trace

Protocol Panel 和 Workflow Panel 使用同一套字段、状态词、Artifact refs、Trace refs 和 visibility。Workflow Run 的执行能力与任务执行生成的 Action Graph 相同；差异在于 Workflow 是可保存、可命名、可复用和可管理的资产。

## Governance View

Governance View 面向权限、记忆、概念和审计。

它展示：

- Authority View：某个 Run、Action、Assignment 或 Agent Session 的生效 authority。
- Memory View：run、project、team、global scope 下的 Memory refs、status、freshness、evidence 和 visibility。
- Concept View：active、superseded、historical concept，以及 replacement request、impact refs 和 gate result。
- Trace View：Command -> Event -> Projection -> Action -> Executor -> Artifact -> Observation 的证据链。
- Redaction View：导出或回放前应用的脱敏规则和被隐藏字段。

Concept replacement、projection rebuild、trace export 和高影响 redaction override 都通过 Command 进入 Runtime，并按决策边界升级。

## Agent 可读 UI 产物

UI 产物需要同时服务人和 Agent Session。

因此，UI 中的摘要、表格、graph node、timeline entry、decision card、artifact card 和 trace export 都应提供：

- 稳定 id
- status
- summary
- refs
- evidence
- actor
- time
- visibility
- source projection
- unresolved issues

后续 Agent Session 可以通过 Context Bundle 引用这些 UI 产物，而不是重新读取完整 transcript 或 raw logs。

## Visibility 与 Redaction

UI 遵守 `visibility` 字段。

- `model` 控制是否进入后续模型上下文。
- `user` 控制是否展示给用户。
- `logs` 控制是否进入审计日志。
- `trace` 控制是否进入 trace export。
- `future_runs` 控制是否成为后续 run 可引用材料。
- `runtime_only` 控制是否只用于 Runtime 内部决策。

Trace export、Artifact preview、raw log view、Memory promotion 和 Agent Session context preview 都需要应用 redaction policy。包含 secret、credential、private key、personal data、敏感路径或未授权外部内容的材料，只能以摘要、引用或脱敏形式展示和复用。

## UI 协议能力

UI 管理协议覆盖以下能力：

- 通过 Projection 观察 Harness 状态。
- 通过 Command 推进 Run、Task、Action、Assignment、Decision、Agent 和 Concept。
- 与 root、child、descendant Agent Session 分别交互。
- 管理 Agent 模板和启用状态。
- 观察模型 DSL、Action Graph、Workflow 资产、executor routing 和 Runtime Observation。
- 检查 authority、gate、memory、concept、artifact、trace 和 audit evidence。
- 将 UI 产物作为 agent-readable refs 供后续 Context Bundle 使用。
