# Session Lifecycle v1 实现方案

## 版本目标

Session Lifecycle v1 的目标是把会话执行状态从 transcript 推断改为 Runtime 状态投影。Runtime 在每次状态变化时写入 Event，由 reducer 更新 Materialized State 和 Projection。UI、恢复流程、模型 Observation、Handoff 和 final answer 都读取 Projection。

本版本解决四个问题：

- 任务进度可判断：知道 Action、Assignment、Agent Session 分别处于什么状态。
- 空闲可收敛：所有 Session 都 `idle` 时，Runtime 能判断 run 是完成、继续、阻塞还是等待 fan-in。
- 结果可消费：每个终态或 partial 状态都有 ResultRecord、Artifact refs、criteria 和 evidence。
- 重启可恢复：系统重启后能区分 completed、failed、blocked、interrupted 和可 resume 的 Session。

## 边界

本目录是实现推进文档，不是协议定义。协议定义仍在：

- `docs/harness-protocol/02-model-runtime-protocol.md`
- `docs/harness-protocol/06-state-event-projection-model.md`
- `docs/harness-protocol/09-ui-console-and-agent-management.md`

v1 只做当前 Harness runtime 和 UI 可落地的最小闭环：

- 扩展 schema / store / runtime projection。
- 让 Harness Console 能展示 lifecycle、result、change 和 recovery 信息。
- 让现有 protocol runner compatibility 投影带上 task/session 状态。
- 先不实现完整可视化 timeline、复杂 rollback、多 provider checkpoint adapter。

## Schema 增量

第一步先扩展已有对象，不引入新的顶层抽象。

需要扩展的状态枚举：

| 对象 | 当前常见状态 | 需要补充 |
|---|---|---|
| `Run.status` | `ready`、`running`、`blocked`、`completed`、`failed` | `idle`、`paused`、`waiting_user`、`waiting_permission`、`partial`、`interrupted`、`cancelled` |
| `Action.status` | `ready`、`blocked`、`running`、`completed`、`failed`、`cancelled` | `idle`、`paused`、`waiting_user`、`waiting_permission`、`partial`、`interrupted`、`skipped` |
| `Assignment.status` | `pending`、`running`、`completed`、`failed`、`cancelled` | `ready`、`idle`、`paused`、`waiting_user`、`waiting_permission`、`blocked`、`partial`、`interrupted` |
| `AgentSession.status` | `pending`、`running`、`completed`、`failed`、`cancelled` | `draft`、`ready`、`idle`、`paused`、`waiting_user`、`waiting_permission`、`blocked`、`partial`、`interrupted` |

需要新增或扩展的 records：

| Record | 存储位置 | 用途 |
|---|---|---|
| `ResultRecord` | 数据库表 + raw result 文件 | 数据库记录最小运行语义投影；raw 文件保存原始任务结果 payload。 |
| `ChangeSet` | run-scoped `changes/` 或数据库表 | 记录本周期造成的文件、artifact、projection、decision、context、permission 变化。 |
| `ProgressProjection` | `projection:run-progress` | 汇总 counts、current、blocked、pending_decisions、latest_results 和 `next`。 |
| `LifecycleProjection` | `projection:lifecycle` | 汇总 Run、Action、Assignment、Session、Attempt 的当前状态和触发来源。 |
| `RecoveryPlan` | `projection:recovery` 或 pending decision | 记录重启后哪些 Session 可 resume、retry、block 或 audit。 |
| `SessionNotification` | run-scoped `notifications/` 或 event payload | 记录 parent -> child 的 Runtime-mediated sync 通知。 |
| `ResultCollection` | run-scoped `collections/` 或 projection payload | 记录多个 child session 的 fan-in、timeout 和汇总策略。 |
| `TaskSummary` | run-scoped `task-summaries/` 或 task record field | 记录模型 `task_summary`、用户确认和修订后的任务内容。 |
| `TaskResultIndex` | projection payload | 记录 task -> canonical ResultRecord 的绑定关系和 revision。 |

`ResultRecord` 和 `ChangeSet` 不替代 Artifact。Artifact 保存产物；ResultRecord 解释产物是否满足任务；ChangeSet 解释本轮改变了什么。ResultRecord 数据库行不是完整结果副本；完整 `ActionResult` 或 terminal `AgentProtocolOutput` result item 保存在 raw result 文件，通过 `raw_ref` 读取。

当前已在 `packages/opencode` delegation 路径先落地 ResultRecord 的最小闭环：

- `session_result` 数据库表保存 normalized projection。
- `session_result_raw/<result_id>.json` 保存 raw result payload。
- parent `completed_delegations` 和 child `dsl_context.result` 只保存 `result_id` / `raw_ref` 与列表展示字段。
- `SessionResult.parse(result_id)` 是读取完整任务结果 payload 的入口。
- 历史 `session_delegation_result` 和旧 DSL payload 只作为兼容修复来源。

## Task Summary And Result Binding

模型可以在执行前输出 `kind: "task_summary"`。Runtime 将 `task` 保存为 pending TaskSummary，并在 UI 右侧任务栏展示给用户确认。确认前不启动 Action Graph。

TaskSummary 建议 record：

```json
{
  "id": "task_summary_001",
  "run_id": "run_123",
  "session_id": "parent_session",
  "source": "model",
  "status": "pending_confirmation",
  "title": "优化会话生命周期协议",
  "summary": "补充子会话状态框、结果绑定、done result 和右侧任务栏。",
  "goal": "让 Runtime 可展示、获取、持久化和汇总子会话结果。",
  "scope": ["docs/harness-protocol", "docs/harness-implementation"],
  "criteria": ["协议和实现计划均更新。"],
  "created_at": 1780836000000,
  "updated_at": 1780836000000
}
```

`TaskSummary.status` 可取：

| Status | 含义 |
|---|---|
| `pending_confirmation` | 等待用户确认。 |
| `confirmed` | 用户确认，可作为任务合同。 |
| `revised` | 用户修改后确认。 |
| `cancelled` | 用户取消本次任务。 |

Result 绑定规则：

- `done.result`、accepted `ActionResult`、accepted terminal `AgentProtocolOutput` result item、fallback summary 和 synthetic handoff 都可以成为 Task canonical result 的来源。
- `session.result.get` 与会话结束自动回复按 task 维度使用同一份 ResultRecord。
- `ResultRecord` 绑定 `task_id` 和 `session_id`，并进入 `TaskResultIndex`。
- ResultRecord 数据库 projection 只保存 carrier、status、satisfying、session/action ids、`raw_ref`、short summary 和创建时间。
- `ActionResult` raw 文件保存接受的 tool input/output；`AgentProtocolOutput` raw 文件只保存被接受为结果的 terminal item，不保存整个 protocol `items`。
- completed Task 已有 canonical result 时，Runtime 直接返回，不重新生成。
- completed Task 没有 result 时，Runtime 给该 Task 对应 Session 发送 result prompt，要求输出 `done.result`。
- 父会话自动汇总时，只按 child 任务读取 canonical ResultRecord 和 raw result 文件，不重新扫描 transcript。Transcript 解析只属于 repair/backfill。

Result prompt 示例：

```md
Your task is marked completed, but no persisted result exists yet.
Return `kind: "done"` with a `result` object.
Base the result on the task criteria, accepted events, artifacts, and trace refs.
Do not start new work.
```

## 状态触发点

状态只由 Runtime 接受的 Event 触发。模型可以报告“我完成了”或“我阻塞了”，但 Runtime 需要用 criteria、executor result、gate、decision、artifact 和 policy 校验后再写状态。

| 触发场景 | 写入 Event | 更新对象 | 新状态 | 说明 |
|---|---|---|---|---|
| 创建 run | `run.created` | Run | `ready` | Run 有 goal 和初始 task，可进入规划或调度。 |
| 接受模型 `act` declaration | `action.graph_persisted`、`action.accepted` | Action Graph、Action | `ready` | 每个 call 变成 Action；依赖未满足的 Action 仍可保持 `ready`，blocked reason 由 Projection 派生。 |
| 依赖不可满足 | `action.blocked` | Action、Run | `blocked` | 依赖 Action 失败、缺 Artifact、cycle、缺权限或 projection stale。 |
| 选择 executor | `action.executor_selected` | Action | `running` | Runtime 确认 executor、authority、budget 和 resource lock。 |
| 创建 agent assignment | `assignment.created`、`session.created` | Assignment、AgentSession | `ready` | Session 已绑定 Assignment、authority 和 context summary。 |
| 开始模型调用或 tool 调用 | `assignment.started`、`session.started`、`action.started` | Assignment、Session、Action | `running` | 记录 attempt id、provider/tool handle、timeout 和 checkpoint。 |
| 子会话被分派，父会话没有活动调用 | `session.idle` | 父 AgentSession | `idle` | 父会话等待 child result 或 fan-in；不代表任务完成。 |
| 普通进度更新 | `session.progress_reported`、`assignment.progress_reported` | Session、Assignment、ProgressProjection | 通常保持 `running` 或 `idle` | 更新 current step、summary、latest evidence，不关闭任务。 |
| 需要用户澄清 | `decision.requested`、`session.blocked` 或 `session.progress_reported` | Session、Assignment、Run | `waiting_user` | `blocked_reason.class = needs_user`，UI 展示 Decision card。 |
| 需要权限 | `action.permission_requested` | Action、Session、Run | `waiting_permission` | 等待 approve / reject；reject 后进入 `blocked`、`failed` 或 `cancelled`。 |
| tool / model 输出可用 | `action.output_stored`、`artifact.written` | Action、ArtifactIndex | 保持 `running` 或进入 `partial` | 写入 Artifact 和 ChangeSet，等待 criteria / gate 判断。 |
| criteria 全部满足 | `session.result_recorded`、`session.completed`、`assignment.completed`、`action.completed` | Session、Assignment、Action | `completed` | ResultRecord `outcome = success`，required artifact refs 已写入。 |
| 只满足部分 criteria | `session.result_recorded`、`session.partially_completed`、`assignment.partially_completed`、`action.partially_completed` | Session、Assignment、Action | `partial` | ResultRecord `outcome = partial_success`，保留 unresolved 和 next。 |
| executor 明确失败 | `session.failed`、`assignment.failed`、`action.failed` | Session、Assignment、Action | `failed` | failure policy 耗尽或不可重试；保留 `error.class` 和 evidence refs。 |
| 缺前置条件但不是执行失败 | `session.blocked`、`assignment.blocked`、`action.blocked` | Session、Assignment、Action | `blocked` | 例如缺用户输入、缺能力、缺 artifact、resource lock、policy gate。 |
| 进程退出、provider stream 断开、系统重启 | `session.interrupted`、`assignment.interrupted`、`action.interrupted` | Session、Assignment、Action | `interrupted` | Runtime 先做恢复评估，不把它直接归为 failed。 |
| 用户或 Runtime 取消 | `session.cancelled`、`assignment.cancelled`、`action.cancelled` | Session、Assignment、Action | `cancelled` | 不自动恢复；可由显式 retry 创建新 attempt。 |
| 跳过可选节点 | `action.skipped` | Action | `skipped` | 由 Decision、Gate 或 dependency policy 触发，保留 reason。 |
| 恢复成功 | `rehydration.completed`、`session.resumed` | Session、Assignment、Action | `ready` 或 `running` | 根据 checkpoint 和 side effect 分类决定继续还是重新调度。 |
| 恢复失败 | `rehydration.failed` | Session、Run | `blocked` 或 `failed` | 无法确认状态时优先 block，并请求 audit / user decision。 |

## 状态更新算法

Runtime 的更新路径保持单向：

```txt
Command 或 executor result
  -> validate schema / authority / gate
  -> append Event
  -> apply lifecycle reducer
  -> update Materialized State
  -> rebuild affected Projection
  -> publish subscription event
```

Reducer 规则：

1. `session.*` event 只直接更新 AgentSessionRecord。
2. `assignment.*` event 只直接更新 Assignment。
3. `action.*` event 只直接更新 ActionRecord。
4. Run 状态由 Projection 汇总，不由单个 event 直接覆盖，除非是 `run.abort` 这类 run-level command。
5. ResultRecord 写入后再评估 criteria、gate 和 downstream handoff。
6. ChangeSet 写入后更新 ArtifactIndex、Trace 和 UI summary。
7. Projection rebuild 失败时，Run 进入 `blocked` 或 `projection_stale` 标记，Runtime 暂停 mutation。

Run 汇总优先级：

```txt
aborted/cancelled command
> running active executor
> waiting_permission
> waiting_user
> blocked without auto recovery
> interrupted recovery pending
> failed required action
> partial accepted result
> completed required graph
> idle with runtime next action
> ready
```

这样可以避免“所有 session idle -> run completed”的误判。`idle` 只触发收敛检查，收敛检查再决定是调度 ready Action、等待 fan-in、评估 Gate，还是关闭 Run。

## 当前落地：SessionStatus 持久化

当前 `packages/opencode` 已先落地会话级轻量运行态，不等待完整 Harness Event / reducer 改造完成。它的目标是让会话树、批量管理和重启恢复不再把所有会话退回 `idle`。

`SessionStatus` 类型：

| Type | 说明 | 是否持久化 | 重启后行为 |
|---|---|---:|---|
| `idle` | 默认空闲态，没有活动调用。 | 否 | 不自动继续。 |
| `queued` | 请求已进入队列，尚未进入执行副作用。 | 是 | 重启后自动继续调度。 |
| `starting` | 会话循环正在启动。 | 是 | 重启后先转为 `interrupted`；无未完成 tool 时自动继续，有未完成 tool 时等待用户恢复。 |
| `running` | 会话正在执行。 | 是 | 重启后先转为 `interrupted`；无未完成 tool 时自动继续，有未完成 tool 时等待用户恢复。 |
| `rate_limited` | provider/model/agent 级限流，携带 active、limit、queued；agent 级限流额外携带 agent。 | 是 | 重启后自动继续等待和调度。 |
| `retry` | 已安排重试，携带 attempt、message、next。 | 是 | 重启后自动继续 retry。 |
| `waiting_permission` | 等待权限审批。 | 是 | 保持等待，不自动继续。 |
| `waiting_user` | 等待用户输入。 | 是 | 保持等待，不自动继续。 |
| `paused` | 安全点暂停。 | 是 | 保持暂停。 |
| `aborting` | 正在取消。 | 是 | 保持停止流程。 |
| `aborted` | 已停止。 | 是 | 不自动继续。 |
| `blocked` | 已知阻塞。 | 是 | 保持阻塞。 |
| `failed` | 已失败。 | 是 | 不自动继续。 |
| `error` | Runtime、provider、model 或工具错误。 | 是 | 保持错误，等待 retry / dismiss。 |
| `timeout` | 调用或等待超时。 | 是 | 保持超时，等待 retry / dismiss。 |
| `interrupted` | 进程停止、stream 断开或重启导致执行上下文丢失。 | 是 | 保持中断，等待恢复判断。 |
| `completed` | 已完成。 | 是 | 不自动继续。 |
| `archived` | 已归档。 | 否 | 不自动继续。 |

写入规则：

- `SessionStatus.set()` 更新内存状态、发布 `session.status`，并写入 `Storage(["session_status", sessionID])`。
- `idle`、`archived` 会删除快照；`completed` 会保留快照，避免重启后被默认 `idle` 误判。
- agent 级并发在提交模型请求前进入 `rate_limited` 等待，不在子会话创建时拒绝创建；已创建会话恢复或继续运行时也经过同一等待路径。
- 快照包含 `sessionID`、`projectID`、`directory`、`status` 和 `time`，不包含消息正文、tool 输出正文或完整 transcript。
- 同一个 session 的写入按 promise chain 串行化，降低连续状态变更乱序落盘的风险。

启动恢复：

- `InstanceBootstrap()` 在 `SessionDelegation.init()` 后调用 `SessionStatus.restore()`。
- `restore()` 只恢复当前 project 和 directory 的快照，并用 schema 校验 `status`。
- `queued`、`rate_limited`、`retry` 属于可恢复调度态；重启后保持原状态并进入自动继续路径。
- `running`、`starting` 属于可能丢失执行上下文的活动态；重启时先转为 `interrupted`，保留原状态到 `prior`。恢复扫描没有发现未完成 tool 时自动继续；发现未完成 tool 时保持 `interrupted`，等待用户确认恢复。
- `blocked`、`waiting_user`、`waiting_permission`、`paused`、`aborted`、`failed`、`error`、`timeout`、`completed`、`interrupted` 只恢复可见状态，不自动发送消息，也不自动创建新请求。
- 自动继续从同一 Session 的持久化历史承接原请求，不注入 “continue” 用户消息。只有用户选择发送消息继续，或 Runtime 需要通知正常停止的模型继续工作时，才写入带来源和目的的消息。

这一步还不是完整 lifecycle Event sourcing。它是当前运行态的 Materialized State，用来避免重启后状态丢失和 UI 误判。后续 Phase 1 / Phase 2 仍需要把同样语义接入 Event、ResultRecord、RecoveryPlan 和 LifecycleProjection。

## UI 映射

UI 只读取 Projection 和 refs。

Harness Console：

- Run list 显示 `run.status`、progress counts、`next.owner`、blocked reason、pending decisions、latest result。
- Run detail 显示 Action Graph，每个 node 使用 `task_status`，并展示 linked Session 的 `session_status`。
- Action detail 显示 criteria matrix、ResultRecord、ChangeSet、Artifact refs、error/blocked/interruption reason。
- Assignment detail 显示 target Agent、authority、Context Bundle、attempts、result、unresolved 和 child trace。
- Recovery panel 显示 `interrupted` sessions、last checkpoint、side effect risk、可选操作 `resume` / `retry` / `audit` / `block`。

Session Workbench：

- Header 继续使用实时 `session_status` 展示当前会话是否 busy、idle、waiting、blocked 或 failed。
- 子会话树展示 parent/child status，父会话 `idle` 时显示“等待子会话结果 / 等待 Runtime fan-in”，而不是“完成”。
- 消息流中 Result Observation 以摘要卡片展示：task status、session status、criteria、artifacts、changes、next。
- `waiting_user` 和 `waiting_permission` 渲染成 Decision / Permission card。

Session Workbench 底部 child-session status panel：

- 父会话等待子会话结果时显示。
- 每个 child 一行：状态图标、会话标题、状态名称、current summary、操作按钮。
- 操作按钮包含 pause、resume、get result、view result、open session。
- `get result` 只在 child task status 为 `completed` 时启用。
- `view result` 打开 persisted ResultRecord modal。

右侧 task bar：

- 展示 task title、task summary、source、status、criteria、owner session、child sessions、result ref。
- 用户输入默认作为 task content。
- 支持会话内多任务的切换，默认展示当前 task。
- `task_summary` 生成 pending task content，用户确认后才开始执行。
- 用户修改 task summary 后保存 revised content。
- 有 canonical result 时展示 result entry，点击打开 result modal。

Protocol / Workflow Panel：

- DSL declaration 展示模型声明。
- Action Graph node 展示 Runtime 接受后的状态，不展示模型自称状态。
- Result tab 展示 ResultRecord。
- Changes tab 展示 ChangeSet。
- Trace tab 展示 status 变更来源 event。

UI 色彩和文案建议：

| Status | UI 文案 | 视觉语义 |
|---|---|---|
| `running` | Running | 活跃执行，显示 spinner 或 pulse。 |
| `idle` | Idle | 灰色，不显示成功勾。 |
| `paused` | Paused | 灰色或黄色，显示恢复入口。 |
| `waiting_user` | Needs input | 黄色，显示用户决策入口。 |
| `waiting_permission` | Needs approval | 黄色，显示权限审批入口。 |
| `blocked` | Blocked | 黄色或红色，展示 reason 和 needs。 |
| `partial` | Partial | 黄色，展示已完成部分和未决项。 |
| `interrupted` | Interrupted | 红色或黄色，展示恢复操作。 |
| `failed` | Failed | 红色，展示 error 和 retry。 |
| `completed` | Completed | 绿色，展示 result 和 artifacts。 |

## Runtime 使用点

Runtime 在以下动作中使用生命周期状态：

| Runtime 动作 | 使用字段 | 行为 |
|---|---|---|
| 调度 ready Action | `Action.status`、`depends_on`、resource locks、budget | 找出可执行节点，创建 Assignment 或 executor invocation。 |
| 创建 Agent Session | `Assignment.status`、authority、Context Bundle | 写 `session.created`，初始化 `AgentSession.status = ready`。 |
| 监控执行 | attempt handle、timeout、`session_status` | 超时或 handle 丢失时写 `interrupted`。 |
| 处理 child session fan-in | child Task ResultRecord、parent Action criteria | 汇总完成、partial、failed、blocked，决定 parent 是否继续。 |
| 构造模型上下文 | ResultRecord、ChangeSet、ArtifactIndex、visibility | 给模型传摘要和 refs，不传完整 transcript。 |
| 生成 Runtime Observation | `task_status`、`session_status`、outcome、criteria、next | 明确下一步是继续、回答、repair、review、ask_user 还是 block。 |
| Handoff | ResultRecord、ChangeSet、unresolved、risks、Trace refs | 构造下游 Session 的 Context Bundle。 |
| final answer | completed/partial/failed/blocked ResultRecord | 只汇报 Runtime 确认的结果、变更、验证和阻塞。 |
| 重启恢复 | interrupted sessions、checkpoint、last event、ChangeSet | 判断 resume、retry、audit、block 或 fail。 |
| 自动化监控 | Run status、`next.owner`、updated_at | 找出需要唤醒、提醒、重试或归档的 run。 |
| Evaluation | criteria、outcome、evidence、changes | 判断任务是否完成、失败原因是否明确、结果是否可复现。 |

## 父子通知与结果回收

父会话通知子会话时，不直接写子会话 transcript。Runtime 提供受控工具或内部 command，例如 `session.notify`，把父会话的通信意图转成 `sync` record，再根据目标 child session 状态决定立即送达、排队、唤醒或只更新 context。

### SessionNotification

建议 record：

```json
{
  "id": "note_parent_to_child_a",
  "run_id": "run_123",
  "parent_session_id": "parent_session",
  "target_session_id": "child_a",
  "kind": "sync",
  "status": "info",
  "summary": "Parent updated the lifecycle criteria. Re-check the task before reporting done.",
  "refs": ["projection://run/run_123/lifecycle"],
  "delivery": "queued",
  "reason": "Child has an active model/tool attempt.",
  "created_at": 1780836000000,
  "updated_at": 1780836000000
}
```

`delivery` 可取：

| Delivery | 含义 |
|---|---|
| `accepted` | Runtime 接受通知，尚未路由。 |
| `delivered` | 已写入 child context 或下一轮模型输入。 |
| `queued` | child 正在执行，等待安全点注入。 |
| `rejected` | 权限、scope、目标或 policy 不允许。 |
| `superseded` | 被更新的通知替代。 |

父会话工具调用的返回不能只说“成功”。Runtime 应返回 parent reply，包含每个目标 child 的状态、delivery 和 collection id。

### ResultCollection

当父会话通知多个 child，或等待多个 child 返回时，Runtime 创建 collection。

建议 record：

```json
{
  "id": "collect_child_results_001",
  "run_id": "run_123",
  "parent_session_id": "parent_session",
  "target_session_ids": ["child_a", "child_b"],
  "status": "collecting",
  "timeout_ms": 300000,
  "started_at": 1780836000000,
  "deadline_at": 1780836300000,
  "result_policy": {
    "reply_mode": "aggregate",
    "include_partial": true,
    "on_timeout": "inspect_status_and_summarize"
  },
  "result_refs": []
}
```

`ResultCollection.status` 可取：

| Status | 含义 |
|---|---|
| `collecting` | 仍在等待目标 child 的 result 或状态变化。 |
| `ready` | 已达到回复条件，可汇总给 parent。 |
| `timeout` | 到达 deadline，需要检查目标状态并生成 timeout summary。 |
| `completed` | 已向 parent 回复汇总。 |
| `cancelled` | parent 或 Runtime 取消 collection。 |

Timeout 处理规则：

1. 到达 `deadline_at` 后，不修改 child session 为 failed。
2. Runtime 读取每个 child 的 LifecycleProjection、ResultRecord projection、blocked reason、last update 和 active attempt。
3. 已 completed / partial / failed / blocked 的 child 进入对应汇总桶。
4. still-running、idle、waiting_user、waiting_permission、interrupted 的 child 按当前状态进入状态汇总。
5. Runtime 主动回复 parent，给出 `wait_more`、`continue_with_partial`、`cancel_remaining`、`request_permission` 等可选下一步。

### Parent Reply

Parent reply 是 Runtime 给父会话的结果汇总，不是 child 自己写给 parent 的消息。

建议 projection payload：

```json
{
  "type": "runtime.parent_reply",
  "collection_id": "collect_child_results_001",
  "status": "timeout_summary",
  "summary": "One child completed, one is still running, and one waits for permission.",
  "completed": ["result://session/child_a"],
  "partial": [],
  "blocked": ["session://child_c"],
  "still_running": ["session://child_b"],
  "next": {
    "owner": "parent",
    "action": "decide",
    "options": ["wait_more", "continue_with_partial", "cancel_remaining", "request_permission"]
  }
}
```

Parent reply 写入父会话时应同时保留 machine-readable projection 和用户可读摘要。父 Agent 下一轮上下文读取这个 summary，而不是扫描多个 child transcript。

## 开发推进计划

### Phase 1: Schema And Store

目标：让状态、结果和变更有可落库对象。

改动：

- 扩展 `packages/opencode/src/harness/schema.ts` 的 `Status`、`TaskStatus`、`ActionStatus`、`Assignment.status`、`AgentSessionRecord.status`。
- 新增 `ResultRecord`、`ChangeSet`、`ProgressProjection`、`LifecycleProjection`、`RecoveryPlan`、`TaskSummary`、`TaskResultIndex` schema。
- 新增 raw result file layout，保存 accepted `ActionResult` payload、accepted terminal `AgentProtocolOutput` result item、fallback summary 或 synthetic payload。
- 在 `HarnessStore` 增加 results、changes、lifecycle projections 的 put/list/get 方法。
- 在 `HarnessStore` 增加 task summaries 和 task result index 的 put/list/get 方法。
- 增加 `ResultStore.getRaw()` 和 `ResultStore.parse()`，解析结果由 ResultStore 统一缓存。

验收：

- schema parse 覆盖所有新增状态。
- store 可以写入、读取、列出 ResultRecord 和 ChangeSet。
- raw result 文件可通过 `raw_ref` 读取；ResultRecord 数据库行不复制完整 raw payload。
- store 可以写入、读取、确认和修订 TaskSummary。
- TaskResultIndex 能按 task id 返回 canonical ResultRecord。
- 旧状态值仍能通过兼容解析或迁移路径读取。

### Phase 2: Runtime Reducer And Projection

目标：Runtime 通过 Event 驱动状态，不由单点代码直接拼接 run 状态。

改动：

- 在 `HarnessRuntime` 增加 `transition()` 或 `lifecycle()` helper。
- 扩展当前 `refresh()` 和 `project()`，从 tasks/actions/assignments/sessions/results/decisions 汇总 Run 状态。
- 写入 `run-progress`、`lifecycle`、`recovery` projections。
- 写入 `task-summary` 和 `task-result-index` projections。

验收：

- all-idle 但仍有 ready action 时，Run 不会变成 `completed`。
- required action failed 时，Run 进入 `failed`。
- waiting permission / waiting user 优先级高于 idle。
- interrupted session 会生成 RecoveryPlan。
- completed task 没有结果时，可以触发 `session.result_requested`。

### Phase 3: Agent Assignment And Protocol Compatibility

目标：真实子会话执行能写入 Session lifecycle 和 ResultRecord。

改动：

- `assignAgent()` 创建 Assignment 和 AgentSession 时使用 `ready`。
- 启动 child session 时转 `running`。
- child 返回后先写 raw result 文件和 ResultRecord projection，再把 Session / Assignment / Action 转为 completed、partial、blocked 或 failed。
- 现有 `session/runner.ts` 的 protocol run 投影继续写入 `dsl_context.protocol.runs`，但增加 `task_status`、`session_status`、`result_id`、`change_refs`、`blocked_reason`。
- 支持模型输出 `task_summary`，Runtime 保存 pending task content。
- 支持模型输出 `done.result`，Runtime 绑定 TaskResultIndex。

验收：

- child session 完成后 parent fan-in 能通过 `result_id` 消费 ResultRecord。
- child session 失败不会被 parent 当作 completed。
- parent session `idle` 时 UI 能显示等待 child 或 Runtime fan-in。
- `task_summary` 不会启动执行，用户确认后才进入 `act`。
- repeated `done.result` 不生成重复 canonical result。

### Phase 4: Parent Notification And Collection

目标：父会话可以通过 Runtime 通知子会话，并收到主动汇总回复。

改动：

- 增加 `session.notify` Runtime tool / command。
- 增加 `SessionNotification` store API。
- 增加 `ResultCollection` store API 和 deadline 检查。
- child 正在 `running` 时通知进入 `queued`；child 到安全点后注入。
- child `idle`、`ready`、`blocked`、`waiting_user`、`waiting_permission` 时按 policy 立即送达或更新等待原因。
- collection 到期时读取 child 当前状态并生成 timeout summary。

验收：

- parent 通知单个 child 后，parent 能收到 delivery 状态回复。
- parent 通知多个 child 后，Runtime 创建 collection 并返回 collection id。
- 所有 child 完成后，parent 收到聚合 ResultRecord refs / Artifact refs / risks / unresolved。
- collection timeout 后，still-running child 保持 `running`，不会被标记为 failed。
- timeout summary 能列出 completed、partial、blocked、failed、still_running、waiting_permission 等状态桶。

### Phase 5: UI

目标：Harness Console 和 Session Workbench 显示同一套 Runtime Projection。

改动：

- `packages/app/src/pages/harness.tsx` 读取 ProgressProjection、ResultRecord 和 ChangeSet。
- Run detail 增加 Notifications / Collections 区域。
- Run detail 增加 Result / Changes / Recovery 区域。
- Session side panel 把 `idle` 与 `completed` 分开显示，把 `interrupted` 和 `partial` 加入 label/tone。
- Protocol / Workflow Panel 展示 task_status 与 session_status。
- Session Workbench 底部增加 child-session status panel。
- 右侧增加 task bar，展示 TaskSummary、criteria、status、result ref 和 child sessions。
- 增加 result modal，先展示 canonical ResultRecord projection，再按需读取 raw result file。
- `get result` 按钮调用 `session.result.get`，只在 completed child task 上启用。

验收：

- `idle` 不显示成功勾。
- `waiting_user` 和 `waiting_permission` 显示可操作入口。
- `interrupted` 显示恢复操作入口。
- ResultRecord 和 ChangeSet 可从 UI 看到 refs 和摘要。
- parent reply、notification delivery 和 collection timeout summary 可从 UI 看到。
- 父会话等待子会话时，底部 panel 每个 child 一行并随状态更新。
- completed child 可以获取结果；非 completed child 禁用获取结果。
- 获取结果弹框展示持久化 ResultRecord，并按需展开 raw result payload。
- 右侧 task bar 可以显示用户输入来源和 `task_summary` 来源的任务内容。

### Phase 6: Recovery Command

目标：重启后可按 RecoveryPlan 恢复或阻塞。

改动：

- 新增 `run.recover` 或 `session.recover` command。
- 支持 `resume`、`retry`、`audit`、`block`。
- 恢复后写 `rehydration.completed` 或 `rehydration.failed`，并更新 lifecycle projection。
- 已落地的 `SessionStatus.restore()` 作为 Phase 6 的最小恢复入口，后续需要把恢复判断升级为 RecoveryPlan。

验收：

- completed / failed / cancelled Session 不会被自动重跑。
- running 但 handle 丢失的 Session 会进入 `interrupted`。
- 不确定 side effect 时进入 `blocked`，等待用户或 audit。
- 重启后 `blocked`、`waiting_user`、`waiting_permission`、`error`、`timeout` 不会被误置为 `idle`。
- 重启后 `queued`、`rate_limited`、`retry` 会自动继续；`running`、`starting` 在无未完成 tool 时自动继续，有未完成 tool 时保持 `interrupted` 等待用户恢复。

## 测试计划

从 `packages/opencode` 运行测试，不从 repo root 运行。

建议新增测试：

- `test/harness/session-lifecycle.test.ts`
- `test/harness/session-recovery.test.ts`
- `test/harness/result-change-set.test.ts`
- `test/harness/run-projection.test.ts`
- `test/harness/session-notification.test.ts`
- `test/harness/result-collection.test.ts`
- `test/harness/task-summary.test.ts`
- `test/harness/task-result-index.test.ts`

覆盖场景：

- 状态触发与 reducer 更新。
- all-idle 不误判 completed。
- partial result 写入和 parent fan-in。
- failed / blocked / interrupted 的原因字段。
- RecoveryPlan 生成。
- parent -> child notification delivery。
- 多 child collection 聚合回复。
- timeout 后检查 child 当前状态，不直接标记 failed。
- `task_summary` 等待用户确认后再执行。
- completed task result get 使用已绑定 ResultRecord，避免重复生成。
- session 中历史任务应按 task id 独立读取结果，不应互相覆盖。
- completed task 无结果时触发 result prompt 并保存 `done.result`。
- UI/API projection shape。

## 最小交付

第一版可以先交付：

- schema 扩展。
- store results / changes。
- Runtime lifecycle reducer。
- run projection 汇总。
- parent notification 和 result collection 的基础 API。
- TaskSummary 和 TaskResultIndex。
- Harness Console 展示 ProgressProjection、ResultRecord、ChangeSet。
- Session Workbench 底部 child status panel 和右侧 task bar。

Session Workbench 的细节卡片、完整 recovery command 和复杂 checkpoint adapter 可以放到后续版本。
