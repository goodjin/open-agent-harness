# 状态、事件、Projection 与 Trace 模型

## 目的

本文定义 Harness run、Action、Action Graph、Assignment、Artifact、Handoff、Workflow Profile、protocol run、UI projection、audit、evaluation 和 recovery 共享的状态、projection、trace 与 observability 模型。

## 事实来源

已接受 Event 是规范历史。Projection 是从已接受 Event 派生出来的当前操作视图。

状态文件、数据库行、Action Graph record、Workflow Profile JSON 和场景化 Adapter JSON 可以作为 materialized projection，但不能与已接受 Event 矛盾。

```txt
Command -> validation -> Event -> Projection -> Trigger/Gate -> next Action/Assignment
```

状态对象分为五类：

- **Event**：Runtime 接受的事实记录。
- **Projection**：从 Event 和 materialized state 推导出的当前操作视图。
- **Materialized State**：用于快速读取、恢复和调度的持久化状态。
- **Trace**：围绕 run、Action、Assignment、Artifact、Gate、Decision 和 Observation 组织出的证据链。
- **Artifact Index**：记录产物 id、来源、状态、可见性、摘要和引用位置。

## Trace 与可观测性

Trace 是 Harness run 的结构化可观测视图。它连接已接受 Event、Action record、Assignment record、executor invocation、模型可见 Observation、Artifact refs、gate decision、决策、失败和恢复步骤。

Trace 是协议对象，用于 UI、audit、debugging、evaluation 和 recovery。它不是单独的事实来源，而是从已接受 Event、execution record 以及引用的 artifact/log 派生出来。

Trace record 应同时便于人类 operator 和后续 Agent Session 阅读。Trace entry 应携带稳定 id、status、summary、actor、time、refs、visibility，以及足够的 provenance，用来解释它与当前 Projection 的关系。

Runtime 主动编排也属于 Trace 的证据链。Trace 应能说明 Runtime 为什么触发编排、触发点是什么、来源 Agent Session 是谁、命中了哪个 `orchestration_policy`、生成了哪个 Contract / Handoff Contract、后续 Assignment 获得了什么 authority，以及该编排是否阻塞 parent action 完成。

Trace entry 形态：

```json
{
  "id": "trace_action_read_package",
  "run_id": "run_123",
  "kind": "action",
  "status": "completed",
  "summary": "Read package.json and stored a manifest summary.",
  "actor": "runtime",
  "refs": {
    "events": ["evt_041", "evt_042"],
    "action": "action:read_package",
    "artifacts": ["artifact://action/read_package/output"],
    "projection": "projection://run/run_123"
  },
  "visibility": {
    "model": "summary",
    "user": "summary",
    "logs": "full"
  }
}
```

## Event Envelope

Event 形态：

```json
{
  "id": "evt_123",
  "seq": 42,
  "time": "2026-05-27T12:00:00Z",
  "scope": "run",
  "namespace": "project:open-agent-harness",
  "type": "action.completed",
  "actor": {
    "type": "runtime",
    "id": "runtime"
  },
  "run_id": "run_123",
  "action_id": "read_package",
  "data": {},
  "refs": ["artifact://action/read_package/output"],
  "prev": "evt_122"
}
```

必需属性：

- 稳定 id
- Event log 内单调递增的 sequence
- timestamp
- type
- actor
- scope
- data payload

### Orchestration 事件

Runtime 评估和展开 `orchestration_policy` 时，应产生可审计 Event。

事件类型：

- `orchestration_policy.evaluated`
- `orchestration_policy.skipped`
- `orchestration.triggered`
- `orchestration.blocked`
- `orchestration.assignment_created`
- `orchestration.completed`
- `orchestration.failed`
- `handoff.created`

### 通用执行事件

Action、Assignment、Artifact、Gate 和环境恢复使用共享事件类型：

- `run.created`
- `task.summary_proposed`
- `task.summary_confirmed`
- `task.summary_revised`
- `task.summary_cancelled`
- `action.graph_persisted`
- `action.accepted`
- `action.graph_ready`
- `action.started`
- `action.executor_selected`
- `action.permission_requested`
- `action.permission_resolved`
- `action.output_stored`
- `action.completed`
- `action.partially_completed`
- `action.retry_scheduled`
- `action.loop_attempt_started`
- `action.loop_attempt_completed`
- `action.failed`
- `action.cancelled`
- `assignment.created`
- `assignment.started`
- `assignment.progress_reported`
- `assignment.completed`
- `assignment.partially_completed`
- `assignment.blocked`
- `assignment.failed`
- `assignment.interrupted`
- `assignment.resumed`
- `session.created`
- `session.started`
- `session.progress_reported`
- `session.idle`
- `session.paused`
- `session.completed`
- `session.partially_completed`
- `session.blocked`
- `session.failed`
- `session.interrupted`
- `session.cancelled`
- `session.resumed`
- `session.result_requested`
- `session.result_recorded`
- `session.result_revised`
- `session.change_set_recorded`
- `session.notification_requested`
- `session.notification_delivered`
- `session.notification_queued`
- `session.notification_rejected`
- `result.collection_started`
- `result.collection_updated`
- `result.collection_timeout`
- `result.collection_completed`
- `runtime.parent_reply_recorded`
- `artifact.declared`
- `artifact.written`
- `artifact.indexed`
- `gate.evaluated`
- `gate.blocked`
- `decision.requested`
- `decision.applied`
- `snapshot.created`
- `rehydration.started`
- `rehydration.completed`
- `rehydration.failed`
- `workflow.created`
- `workflow.saved_from_run`
- `workflow.updated`
- `workflow.run_created`
- `workflow.archived`

`orchestration.triggered` 数据形态：

```json
{
  "id": "evt_orchestration_001",
  "seq": 84,
  "time": "2026-05-27T12:08:00Z",
  "scope": "run",
  "namespace": "project:open-agent-harness",
  "type": "orchestration.triggered",
  "actor": {
    "type": "runtime",
    "id": "runtime"
  },
  "run_id": "run_123",
  "assignment_id": "assign_code_developer",
  "orchestration_id": "orchestrate_verify_implementation",
  "data": {
    "policy_id": "verify_implementation",
    "trigger": "on_completed",
    "source_agent_id": "code_developer",
    "target_capability": "verification",
    "required": true,
    "dedupe_key": "implementation_verification_chain",
    "reason": "Source assignment completed with write side effects and produced artifact://current/patch."
  },
  "refs": ["artifact://current/patch"],
  "prev": "evt_083"
}
```

## Projection 类型

核心 Projection：

- run status
- run goal contract
- action graph
- task/action status
- assignment status
- orchestration status
- orchestration chain
- handoff status
- handoff chain
- session notification queue
- result collection status
- parent reply summary
- task summary confirmation
- task result index
- open decision queue
- gate status
- artifact index
- trace index
- budget summary
- environment summary
- observability summary
- child session tree
- memory index
- concept state
- UI summary

Projection 应能从 Event 和 stored state 重建。如果重建失败，Runtime 应阻塞 mutation，并暴露 repair decision，而不是在不确定状态下继续执行。

## 规范状态

不同 Run、Action Graph、Workflow asset 和场景化 Adapter 使用总纲定义的共同状态词汇：

| Canonical | 含义 |
|---|---|
| `draft` | 已创建，但尚未准备执行。 |
| `ready` | 合法且可调度。 |
| `running` | 正在执行。 |
| `idle` | 当前没有正在运行的 executor，但也没有达到终态；常见于等待调度、等待父 run 消费结果或恢复检查。 |
| `paused` | 用户或 Runtime 在安全点暂停执行；保留上下文、checkpoint 和下一步恢复入口。 |
| `waiting_user` | 等待用户/Owner 输入。 |
| `waiting_permission` | 等待审批。 |
| `blocked` | 缺少决策或前置条件，无法继续。 |
| `partial` | 已产生可用结果，但部分必要子项、验证、handoff、Artifact 或 gate 未完成或未通过。`partial` 不等同于 `completed`；下游只能消费 Runtime 标记为可用的 Artifact，并需要通过 failure、Decision 或 Handoff 处理未决部分。 |
| `failed` | 执行失败。 |
| `completed` | 成功完成。 |
| `skipped` | 被 Decision、Gate 或依赖规则跳过，且跳过行为已记录。 |
| `interrupted` | 执行被进程退出、网络断开、模型中断、系统重启或外部原因打断，Runtime 尚未判定为失败或取消。 |
| `cancelled` | Runtime/用户在完成前取消。 |
| `aborted` | Run 被有意终止为最终状态。 |

Profile / Adapter 映射：

- Workflow Run `completed` -> `completed`
- Workflow Run `blocked` -> `blocked`
- Workflow Run `waiting_user` -> `waiting_user`
- Workflow Run `waiting_permission` -> `waiting_permission`
- Workflow Run `failed` -> `failed`
- Workflow Run `partial` -> `partial`
- protocol run `completed` -> `completed`
- protocol run `blocked` -> `blocked`
- protocol run `partial` -> `partial`

## 会话生成周期

会话生成周期描述一次 Agent Session 从创建、执行、产出、空闲到终态或恢复的全过程。它服务三个问题：

- 当前任务到哪一步了。
- 系统重启后哪些会话还能继续，哪些只能等待人工处理。
- 所有会话都空闲时，Runtime 如何判断 run 已完成、失败、阻塞还是仍在等待 fan-in。

需要分开记录 Task / Action 状态和 Agent Session 状态。Task / Action 回答“这件事完成了吗”；Agent Session 回答“执行这件事的会话现在处于什么运行阶段”。同一个 Task 可以经历多个 Session，例如重启恢复、handoff、context limit 后新开会话；同一个 Session 也可能汇报一个 Action 的 partial result，并让 Runtime 决定是否继续、重试、交给下游或请求用户。

### 状态分层

状态分层：

| 层级 | 对象 | 回答的问题 | 典型消费者 |
|---|---|---|---|
| Run | `Run` / `Workflow Run` | 整个目标是否可以关闭、恢复或升级。 | UI、scheduler、automation、export |
| Task | `Task` / `Action Graph node` | 用户或流程声明的工作单元是否达成。 | Runtime scheduler、Gate、Workflow |
| Assignment | `Assignment` | 某个 executor 被授予的任务合同是否履行。 | Routing、handoff、review、repair |
| Session | `Agent Session` | 某次模型会话是否正在跑、空闲、阻塞、失败或可恢复。 | Session workbench、rehydration、context compiler |
| Attempt | `Attempt` / `Invocation` | 某次模型调用、tool 调用或 pipeline 步骤发生了什么。 | Trace、debug、retry、evaluation |

Runtime 可以从子层推导父层，但不能只靠 transcript 文本推断状态。每次状态变化都要由 Event 接受，再进入 Projection。

### Agent Session 状态

Agent Session 使用以下状态：

| Status | 含义 | 是否终态 | 恢复动作 |
|---|---|---:|---|
| `draft` | 会话记录已创建，Context Bundle 或 Assignment 尚未绑定。 | 否 | 补齐缺失合同后进入 `ready`，否则 `blocked`。 |
| `ready` | 会话已具备 context、authority 和目标，可调用模型或 executor。 | 否 | 可调度。 |
| `running` | Runtime 正在调用模型、执行 tool 或等待 executor 返回。 | 否 | 监控 timeout、预算和 cancellation。 |
| `idle` | 当前没有活动调用；会话可能等待父 run 消费结果、等待下一轮输入、等待 fan-in 或等待恢复检查。 | 否 | 读取 `next` 和所属 Assignment，决定关闭、继续或保持空闲。 |
| `paused` | 会话在安全点暂停，当前不调度新的模型或 tool 调用。 | 否 | 用户或 Runtime 可以通过 resume 恢复。 |
| `waiting_user` | 需要用户澄清、输入或选择。 | 否 | 创建 Decision，等待 `decision.answer`。 |
| `waiting_permission` | 需要权限审批。 | 否 | 等待 approve / reject。 |
| `blocked` | 缺少前置条件、上下文、资源、锁、能力或决策，Runtime 已知道不能自动继续。 | 否 | 暴露 `blocked_reason` 和 `needs`。 |
| `partial` | 已有可用结果，但 Session 自身不能把任务推进到 completed。 | 否 | Runtime 决定接收 partial、创建 repair/review、handoff 或继续。 |
| `interrupted` | 调用或进程被中断，结果不完整，原因可能来自重启、断网、provider stream 断开或本地进程退出。 | 否 | 通过 checkpoint、last accepted event 和 artifact refs 判断 resume、retry 或 block。 |
| `failed` | Session 执行失败，且 failure policy 没有自动恢复路径。 | 是 | 只能通过 retry、repair、handoff 或人工 Decision 打开新路径。 |
| `completed` | Session 已产出满足 Assignment Contract 的结果，且 Runtime 已记录 result。 | 是 | 可被 parent、downstream 或 final answer 消费。 |
| `cancelled` | 用户或 Runtime 主动取消。 | 是 | 不自动恢复，除非用户显式 retry。 |

`idle` 不是成功状态。它只说明“现在没有活跃调用”。Runtime 判断 run 是否完成时，应同时检查 Assignment、Action Graph、pending Decision、Gate、Artifact Contract 和 child session tree。

### Runtime SessionStatus 子集

当前 Runtime 会额外维护一个轻量的 `SessionStatus` Projection，用于会话列表、会话树、重启恢复和批量管理。它复用上面的状态词汇，但范围更窄：它只描述某个 Agent Session 的当前运行态，不替代 Task / Action 的完成判定，也不替代 ResultRecord。

`SessionStatus` 可以取以下类型：

| Type | 含义 | 重启后默认行为 |
|---|---|---|
| `idle` | 没有活动调用，也没有需要保留的运行态。 | 不持久化，不自动继续。 |
| `queued` | 请求已接受，等待进入模型或 executor 调度。 | 自动恢复调度。 |
| `starting` | 正在启动模型循环、tool loop 或 executor。 | 自动恢复调度。 |
| `running` | 模型、tool 或 executor 处于活动执行中。 | 自动恢复执行。 |
| `rate_limited` | provider 或 model 并发限制触发，等待额度释放。 | 自动恢复等待和调度。 |
| `retry` | Runtime 已安排重试，记录 attempt、message 和 next 时间。 | 自动恢复重试计划。 |
| `waiting_permission` | 等待权限审批。 | 保留状态，等待审批或用户操作。 |
| `waiting_user` | 等待用户输入、选择或澄清。 | 保留状态，等待用户操作。 |
| `paused` | 用户或 Runtime 在安全点暂停。 | 保留状态，不自动继续。 |
| `aborting` | 取消请求已发出，正在等待安全停止。 | 保留状态，不自动继续。 |
| `aborted` | 会话已被用户或 Runtime 停止。 | 保留状态，不自动继续。 |
| `blocked` | Runtime 已知道缺少前置条件，不能自行推进。 | 保留状态，不自动继续。 |
| `failed` | 会话失败，当前 failure policy 没有自动恢复路径。 | 保留状态，不自动继续。 |
| `error` | Runtime、模型、provider 或工具返回错误。 | 保留状态，不自动继续。 |
| `timeout` | 调用或等待超时。 | 保留状态，不自动继续。 |
| `completed` | 会话已完成，结果应通过 ResultRecord 消费。 | 不作为活动运行态持久化，不自动继续。 |
| `archived` | 会话已归档。 | 不作为活动运行态持久化，不自动继续。 |

`rate_limited` 应携带 `providerID`、`modelID`、`scope`、`active`、`limit` 和 `queued`，让 UI 能说明是 provider 级限制还是 model 级限制。`retry` 应携带 `attempt`、`message` 和 `next`，让恢复逻辑知道下一次尝试的依据。

余额不足、配额不足、认证失效这类 provider 错误应进入可分类的 `error` 或 `blocked`，并在 `message` / `error.class` 中说明原因。除非 Runtime 明确把它转成 `retry` 或 `rate_limited`，重启后不应自动继续，避免重复提交无效请求。

### Task / Action 状态

Task / Action 状态更接近业务结果：

| Status | 使用场景 |
|---|---|
| `draft` | Action Graph 尚未 ready。 |
| `ready` | 依赖满足，可调度。 |
| `running` | 至少一个 Assignment 或 executor 正在执行。 |
| `waiting_user` | 需要用户输入才能判定或继续。 |
| `waiting_permission` | 需要审批才能执行或提交结果。 |
| `blocked` | 缺前置条件、资源、锁、能力、上下文、artifact 或决策。 |
| `partial` | 可用结果已产生，但 criteria、gate 或必要产物只完成一部分。 |
| `failed` | 任务没有达到 criteria，并且 failure policy 关闭或耗尽。 |
| `completed` | criteria 满足，必要 result 和 Artifact 已记录。 |
| `skipped` | 按依赖、Decision 或 Gate 跳过。 |
| `interrupted` | 执行被打断，尚未完成 failure classification。 |
| `cancelled` | 被取消。 |

Task / Action 的终态由 criteria、gate、result 和 evidence 决定，不由最后一条 assistant message 决定。

### 结果记录

每个终态或 `partial` 的 Session、Assignment 和 Action 都应写入 Result Record。Result Record 是 Runtime 后续判断、UI 展示、handoff、恢复和 final answer 的输入。运行时要按任务记录结果。

Result Record 与 Task 绑定。一个 Task 默认只有一个 canonical ResultRecord；重复生成会造成父会话汇总不稳定，因此 Runtime 应通过 `task_id`、`session_id`、`assignment_id`、`action_id` 和 result revision 管理更新。UI 的“获取结果”和会话结束时的自动回复使用同一份 ResultRecord。

Result Record 字段：

```json
{
  "id": "result_session_review_toolbar",
  "scope": "task",
  "run_id": "run_123",
  "session_id": "ses_review_toolbar",
  "task_id": "task_review_toolbar_1",
  "assignment_id": "assign_review_toolbar",
  "action_id": "review_toolbar",
  "status": "completed",
  "revision": 1,
  "canonical": true,
  "outcome": "success",
  "summary": "Reviewed toolbar behavior and found two confirmed issues.",
  "criteria": [
    {
      "text": "Find correctness and regression risks in toolbar behavior.",
      "status": "satisfied",
      "evidence": ["artifact://run_123/review_report"]
    }
  ],
  "artifacts": ["artifact://run_123/review_report"],
  "changes": ["change://run_123/review_report"],
  "evidence": ["trace://run_123/action/review_toolbar", "event:session.completed"],
  "unresolved": [],
  "risks": ["Dropdown layering fix needs browser verification."],
  "next": {
    "owner": "runtime",
    "action": "schedule_repair"
  },
  "visibility": {
    "model": "summary",
    "user": "summary",
    "logs": "full",
    "trace": "summary",
    "future_runs": "ref"
  }
}
```

字段语义：

| 字段 | 含义 |
|---|---|
| `status` | Canonical status，供 Projection 和调度使用。 |
| `task_id` | 当前结果的任务级标识。 |
| `revision` | 同一 Task 结果的修订序号。 |
| `canonical` | 是否为该 Task 当前可消费的主结果。 |
| `outcome` | 面向结果分类，可取 `success`、`partial_success`、`failure`、`blocked`、`cancelled`、`interrupted`、`skipped`。 |
| `summary` | 一到三句结果摘要，面向用户和后续模型。 |
| `criteria` | 每条完成标准的满足情况，可取 `satisfied`、`partial`、`unsatisfied`、`not_checked`。 |
| `artifacts` | 可消费产物引用。 |
| `changes` | 本周期造成的变更引用。 |
| `evidence` | 支撑 status 和 outcome 的 Event、Trace、Artifact 或 log ref。 |
| `error` | 失败、阻塞或中断时的结构化错误。 |
| `blocked_reason` | `blocked` 时的直接原因。 |
| `interruption` | `interrupted` 时的中断来源、最后安全点和恢复建议。 |
| `unresolved` | 未解决但不一定阻塞的事项。 |
| `risks` | 已知风险。 |
| `next` | Runtime 可执行的后续动作建议。 |

结果获取规则：

- 默认先用当前 active 的 Task；若当前无 active Task，则用该 Session 最新的 completed Task。
- 只有任务状态为 `completed` 的 Task 可以被用户或父会话主动“获取结果”。
- 如果目标 Task 已有 canonical ResultRecord，Runtime 直接返回该结果，不重新生成。
- 如果目标任务 completed 但没有 ResultRecord，Runtime 写入 `session.result_requested`，向该 Task 对应 Session 发送结果生成 prompt，要求输出 `done.result`。
- Runtime 收到 `done.result` 后写入 `session.result_recorded`，并更新 task result index。
- 如果结果需要修订，Runtime 写入 `session.result_revised`，保留历史 revision，并只把该 Task 的最新 canonical revision 提供给父会话汇总。

错误与阻塞应使用可分类字段：

```json
{
  "error": {
    "class": "tool_error | model_error | permission_denied | budget_exhausted | context_missing | dependency_failed | validation_failed | environment_error | user_cancelled | unknown",
    "message": "Test command exited with code 1.",
    "retryable": true,
    "refs": ["log://run_123/test/stderr"]
  },
  "blocked_reason": {
    "class": "needs_user | needs_permission | missing_dependency | missing_artifact | resource_locked | capability_gap | policy_gate | projection_stale",
    "message": "Review gate requires a human decision before merge.",
    "needs": ["decision://run_123/review_gate"]
  }
}
```

### 进度与空闲判定

Runtime 的 run-level status 通过 Projection 汇总，不直接读取会话最后消息。

判定顺序：

1. 如果存在 `running` Session、Assignment 或 Action，Run 为 `running`。
2. 如果存在 `waiting_permission`，Run 为 `waiting_permission`。
3. 如果存在 `waiting_user`，Run 为 `waiting_user`。
4. 如果存在 `blocked` 且没有可自动恢复路径，Run 为 `blocked`。
5. 如果存在 `interrupted`，Runtime 先执行恢复评估；可恢复则创建 `session.resumed`，不可恢复则进入 `blocked` 或 `failed`。
6. 如果所有 required Action 都 `completed` 或按规则 `skipped`，且 required Gate 通过，Run 为 `completed`。
7. 如果存在 failed required Action 且 failure policy 耗尽，Run 为 `failed`。
8. 如果只有 optional Action 失败，或 required Action 产生 partial result 且 policy 允许接收，Run 为 `partial`。
9. 如果所有 Session 都是 `idle`，但仍有 ready Action、pending fan-in、未消费 result 或未评估 Gate，Run 保持 `idle` 或 `ready`，并暴露 `next.owner = runtime`。

Progress Summary 字段：

```json
{
  "status": "running",
  "phase": "review",
  "counts": {
    "actions_total": 6,
    "actions_completed": 3,
    "actions_running": 1,
    "actions_blocked": 1,
    "actions_failed": 0
  },
  "current": ["action:review_toolbar"],
  "blocked": ["action:browser_verify"],
  "pending_decisions": ["decision://run_123/permission_browser"],
  "latest_results": ["result://session/review_toolbar"],
  "next": {
    "owner": "runtime",
    "action": "wait_for_running_assignment"
  }
}
```

### 系统重启后的恢复

重启后 Runtime 应先恢复轻量 `SessionStatus`，再重建或校验更完整的 Projection。启动顺序：

1. 读取当前 project 和 directory 范围内的 `SessionStatus` 快照。
2. 用 `SessionStatus` schema 校验快照，忽略不合法、跨 project 或跨 directory 的记录。
3. 把合法快照恢复到内存 Projection，先让 UI 能看到重启前的阻塞、等待、错误和限流状态。
4. 对可自动继续的状态启动同一个 Session 的执行循环，从已持久化的 session history、checkpoint、last accepted event 和 artifact refs 继续。
5. 对不可自动继续的状态只保留可见状态和原因，等待用户、权限、恢复命令或 audit action。
6. 对没有快照但可能存在悬空 tool / executor 的会话，再执行 stale handle recovery。

自动继续只适用于可以安全恢复调度的运行态：

| 恢复输入 | Runtime 判断 |
|---|---|
| `queued` / `starting` | 重新进入调度队列。 |
| `running` 且有 live executor handle | 继续监控原 handle。 |
| `running` 且没有 live handle | 从同一 Session 的持久化历史恢复执行循环；不注入新的用户消息。 |
| `rate_limited` | 恢复等待和调度，继续遵守 provider / model 限流。 |
| `retry` | 恢复 retry 计划，按 attempt 和 next 时间继续。 |
| `interrupted` 且有 safe checkpoint | 创建 `session.resumed` 或 retry attempt。 |

以下状态不自动继续：

| 恢复输入 | Runtime 判断 |
|---|---|
| `waiting_user` | 保持等待用户输入，UI 展示 Decision 或输入入口。 |
| `waiting_permission` | 保持等待审批，UI 展示 permission entry。 |
| `paused` | 保持暂停，等待显式 resume。 |
| `blocked` | 保持阻塞，展示 `blocked_reason`、`needs` 或错误摘要。 |
| `aborting` / `aborted` | 保持停止语义，不恢复原请求。 |
| `failed` / `error` / `timeout` | 保留失败或错误状态，等待 retry、repair、dismiss 或人工处理。 |
| `completed` / `cancelled` / `archived` | 保持终态，不重新执行。 |
| `idle` 且 Assignment completed | 保持 idle，等待 parent/fan-in 消费 result。 |
| `idle` 且 Action ready | 进入调度检查，由 Action Graph 决定是否进入 `ready` 或保持 idle。 |
| Projection stale | 阻塞 mutation，先执行 `projection.rebuild.request`。 |

“恢复原请求句柄”只在 live executor handle 仍存在时成立。进程重启后通常没有内存句柄，Runtime 应恢复同一个 Session 的持久化状态和历史，再启动新的执行循环承接原请求。自动继续不通过发送用户消息实现；只有用户选择“发送消息继续”或 Runtime 需要通知模型继续正常停止后的工作时，才向 Session 注入带来源、目的和目标的结构化消息。

恢复事件应记录恢复原因、恢复依据和恢复后的 next action。Runtime 不应在无法确认副作用的情况下自动重放写操作。

### 变更呈现

会话周期中的变更不只包括文件 diff，也包括状态、决策、产物、上下文和权限变化。Runtime 应为每个 Action 或 Session 维护 Change Set。

Change Set 字段：

```json
{
  "id": "change_run_123_review_toolbar",
  "run_id": "run_123",
  "source": "session:ses_review_toolbar",
  "status": "available",
  "summary": "Added review report and updated review gate result.",
  "items": [
    {
      "type": "artifact",
      "op": "create",
      "ref": "artifact://run_123/review_report",
      "summary": "Structured review report."
    },
    {
      "type": "projection",
      "op": "update",
      "ref": "projection://run/run_123/review_gate",
      "summary": "Review gate moved to partial."
    }
  ],
  "evidence": ["event:session.change_set_recorded"],
  "visibility": {
    "model": "summary",
    "user": "summary",
    "logs": "full",
    "trace": "summary"
  }
}
```

`items[].type` 可取：

- `file`
- `artifact`
- `projection`
- `event`
- `decision`
- `permission`
- `context`
- `memory`
- `handoff`
- `workflow`
- `environment`

UI 使用 Change Set 展示“本会话改变了什么”。Runtime 使用 Change Set 判断 downstream context、handoff 输入、final answer changed-files 摘要、恢复审计、rollback 影响范围和 evaluation evidence。

### Runtime 可搭配功能

这些状态和结果字段给 Runtime 提供以下能力：

- **恢复调度**：根据 `status`、`interruption`、checkpoint 和 side effect 分类选择 resume、retry、block 或 audit。
- **空闲收敛**：所有 Session `idle` 时，通过 Action Graph、Result Record 和 Gate 判断 run 是否关闭或继续。
- **失败归因**：用 `error.class`、`blocked_reason.class` 和 evidence refs 生成可审计失败报告。
- **Fan-in 汇总**：多个 child session 完成后，按 Result Record 和 criteria 汇总 parent Action 结果。
- **Context 编译**：后续模型只接收 result summary、artifact refs、unresolved 和 risks，不读取完整 transcript。
- **Handoff**：把 `result`、`changes`、`unresolved`、`risks` 和 Trace refs 打包给下游 executor。
- **UI 进度视图**：Run list、Session tree、Action Graph 和 timeline 读取同一 Projection。
- **自动化与监控**：cron、heartbeat 或外部 watcher 可以按 `status`、`next.owner` 和 `updated_at` 找出需要唤醒的 run。
- **评测与回放**：evaluation 读取 criteria、outcome、evidence 和 Change Set，判断任务是否真的完成。

## Artifact Index

Artifact Index 是 Projection 的一部分，记录 run 中可被引用和复用的产物。

Artifact Index 字段：

```json
{
  "id": "artifact_patch_current",
  "run_id": "run_123",
  "producer": "action:implement_timeout",
  "type": "patch",
  "name": "current_patch",
  "status": "available",
  "uri": "artifact://run_123/current_patch",
  "summary": "Patch implementing auth timeout handling.",
  "visibility": {
    "model": "summary",
    "user": "summary",
    "logs": "full",
    "future_runs": "ref"
  },
  "evidence": ["event:action.output_stored", "trace:action:implement_timeout"]
}
```

Artifact Index 让 Runtime 在构造模型上下文、UI 视图、Handoff Contract、Trace export 和恢复流程时使用同一个引用。

## Materialized State

Materialized State 是状态的持久化形态，用于快速读取、调度、展示和恢复。它包括数据库行、状态文件、Action Graph record、Workflow Profile JSON、场景化 Adapter JSON、artifact index、UI summary cache 和 executor checkpoint。

Materialized State 保存“当前状态”，Projection 保存“当前操作视图”。例如 Action Graph node state 文件可以记录某个 node 的状态、attempt、output 和 error；Projection 会把这些状态和 Event 一起汇总成 run 进度、blocked reason、pending decision 和 UI summary。

Runtime 接受新 mutation 时以 Event 和当前 Projection 为准；Materialized State 提供恢复和查询效率。

### SessionStatus 持久化

`SessionStatus` 是 Materialized State 的轻量成员。它只保存会话运行态和恢复所需的少量元信息，不保存消息正文、tool 输出正文、完整 transcript 或大对象。消息内容仍由 Session log / message store 管理，并且只在 UI 选中会话或 Runtime 需要执行该会话时读取。

快照建议形态：

```json
{
  "sessionID": "ses_review_toolbar",
  "projectID": "project_open_agent_harness",
  "directory": "/Users/jin/github/open-agent-harness",
  "status": {
    "type": "blocked",
    "message": "Provider balance is insufficient."
  },
  "time": 1780836000000
}
```

持久化规则：

- `idle`、`completed` 和 `archived` 不作为活动运行态保存；写入这些状态时应删除对应快照。
- 其他状态需要持久化，避免 Runtime 重启后把 `blocked`、`waiting_user`、`waiting_permission`、`error`、`timeout` 或限流状态误读成 `idle`。
- 快照按 session id 存储，并带上 project id 和 directory；恢复时必须校验作用域，避免不同 workspace 的同名 session 互相污染。
- 同一 session 的状态写入需要按顺序串行化，防止 `running -> blocked -> idle` 这类连续变更乱序落盘。
- 快照是 Projection cache，不是规范事实来源；若它与 Event、ResultRecord 或 Assignment Contract 冲突，Runtime 应以已接受 Event 和恢复审计为准，并重建 Projection。

## 事务边界

对任何改变状态的 Command：

1. 校验 schema。
2. 校验 authority。
3. 校验 gate 和当前 Projection。
4. 追加 accepted Event。
5. 更新 Projection。
6. 发出 subscription/update event。

如果 Event append 前任一步失败，则不产生状态变更。如果 append 后 Projection update 失败，Runtime 必须将 Projection 标记为 stale，并要求 rebuild，之后才能接受进一步 mutation。

## 存储层

存储关系：

```txt
events.jsonl or event table
  -> projections/
  -> traces/
  -> action graph records
  -> workflow profile records
  -> adapter state records
  -> UI/API responses
```

Run、Action Graph、Action、Assignment、Workflow Profile、Workflow Run、Adapter state 和 executor checkpoint 都位于 Harness run store 或受 Runtime 管理的 profile / adapter store 中。它们作为 Materialized State 参与 Projection、Trace、Replay、Export 和恢复。

## Replay、Export 与恢复

Replay 从 Event sequence、Materialized State、Artifact Index、Action Graph records、Workflow Profile records 和 Adapter records 重建 Projection。Export 从 Trace、Event、Artifact summaries 和 redaction policy 生成可审计材料。

恢复流程使用以下对象：

- Event Log：确定 Runtime 已接受的事实。
- Projection：判断当前是否可继续执行。
- Materialized State：恢复 run、Action Graph、Action、Assignment、Workflow Profile、Adapter 和 executor 当前状态。
- Snapshot：恢复 workspace、artifact index 或 executor state。
- Manifest：重建 executor 可见环境。
- Trace：解释恢复前后的证据链和决策来源。

Runtime 在恢复后写入 `rehydration.completed` 或 `rehydration.failed` 事件，并更新 Projection 与 Trace。
