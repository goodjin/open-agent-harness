# UI 控制台与 Agent 管理协议

## 目的

Harness UI 是用户管理、观察和使用 Harness 系统的操作面。UI 读取 Runtime Projection、Trace、Event、Artifact、Memory 和 Agent registry；用户操作通过 Command、受控 Action 或 Adapter operation 进入 Runtime。

UI 不从自然语言 transcript 推断系统状态。它展示 Runtime 已接受和投影出的结构化状态，并让用户在合适边界内创建 run、切换 Agent、进入不同 Agent Session、批准决策、恢复执行、审查证据和导出 trace。

## Surface

UI 由五类 surface 组成：

- **Harness Console**：管理 Run、Task、Action、Assignment、Gate、Decision、Artifact、Event、Projection 和 Trace。
- **Agent Session Workbench**：展示 root session、child session、descendant session，并允许用户进入不同 Agent Session 继续交互。
- **Agent Manager**：管理 Agent 模板、entry、capability、permission、model preference、relationships、orchestration policy 和启用状态。
- **Protocol / Workflow Panel**：观察模型 DSL、Action Graph、Workflow DAG、executor routing、adapter state 和恢复状态。
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
- `Workflow Node`

每个 UI record 都应包含稳定 id、status、summary、refs、evidence、actor、time、visibility 和 provenance，让人类和后续 Agent Session 都能读取和复用。

## Command 模型

会改变系统状态的 UI 操作提交为 Command。Runtime 校验 schema、authority、gate、当前 Projection 和 redaction policy 后，追加 Event 并更新 Projection。

Command 类型：

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
- workflow runner session
- review / test / debug / research 等 specialist session
- waiting_user、waiting_permission、blocked、partial、failed 等状态标记

用户可以：

- 打开任意 Agent Session 查看 session log、Context Bundle 摘要、Assignment、authority、Artifact refs 和 Trace。
- 在某个 Agent Session 内提交补充输入，形成 `session.message.submit` Command。
- 对 waiting_user / waiting_permission 的 session 提供回答、批准或拒绝。
- 从 parent session 跳转到 child session，也可以从 child session 回到 parent run projection。
- 查看某个 Agent Session 的上下文来源，包括 Projection、Memory、Artifact、Trace 和语义解释提示。
- 将某个 session 的 Artifact、summary 或 unresolved issues 作为 Handoff 输入交给后续 Agent Session。

Agent Session 之间仍不直接通信。用户在 UI 中进入某个 session，是把输入提交给 Runtime；Runtime 再根据该 session 的 authority、Assignment、Context Bundle 和当前 Projection 构造下一次模型调用。

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

Workflow Panel 展示 Workflow Adapter 的 durable orchestration 状态。

它展示：

- Workflow Profile
- DAG / node graph
- node status
- ready / running / blocked / partial / failed nodes
- loop attempt
- Decision queue
- Handoff chain
- Artifact Index
- recovery / rehydration status
- workflow trace

Protocol Panel 和 Workflow Panel 使用同一套字段、状态词、Artifact refs、Trace refs 和 visibility。

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
- 观察模型 DSL、Action Graph、Workflow DAG、executor routing 和 Runtime Observation。
- 检查 authority、gate、memory、concept、artifact、trace 和 audit evidence。
- 将 UI 产物作为 agent-readable refs 供后续 Context Bundle 使用。
