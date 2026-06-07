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
- `assignment.completed`
- `assignment.partially_completed`
- `assignment.failed`
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
| `waiting_user` | 等待用户/Owner 输入。 |
| `waiting_permission` | 等待审批。 |
| `blocked` | 缺少决策或前置条件，无法继续。 |
| `partial` | 已产生可用结果，但部分必要子项、验证、handoff、Artifact 或 gate 未完成或未通过。`partial` 不等同于 `completed`；下游只能消费 Runtime 标记为可用的 Artifact，并需要通过 failure、Decision 或 Handoff 处理未决部分。 |
| `failed` | 执行失败。 |
| `completed` | 成功完成。 |
| `skipped` | 被 Decision、Gate 或依赖规则跳过，且跳过行为已记录。 |
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
