# 状态、事件、Projection 与 Trace 模型

## 目的

本文定义 Harness run、Action、Assignment、workflow adapter record、protocol run、UI projection、audit、evaluation 和 recovery 共享的状态、projection、trace 与 observability 模型。

## 事实来源

已接受 Event 是规范历史。Projection 是从已接受 Event 派生出来的当前操作视图。

状态文件、数据库行和 adapter-specific JSON 文件可以作为 materialized projection，但不能与已接受 Event 矛盾。

```txt
Command -> validation -> Event -> Projection -> Trigger/Gate -> next Action/Assignment
```

## Trace 与可观测性

Trace 是 Harness run 的结构化可观测视图。它连接已接受 Event、Action envelope、Assignment record、executor invocation、模型可见 Observation、Artifact refs、gate decision、决策、失败和恢复步骤。

Trace 是协议对象，用于 UI、audit、debugging、evaluation 和 recovery。它不是单独的事实来源，而是从已接受 Event、execution record 以及引用的 artifact/log 派生出来。

Trace record 应同时便于人类 operator 和后续 Agent Session 阅读。Trace entry 应携带稳定 id、status、summary、actor、time、refs、visibility，以及足够的 provenance，用来解释它与当前 Projection 的关系。

## Event Envelope

推荐 Event 形态：

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

## Projection 类型

核心 Projection：

- run status
- task/action status
- assignment status
- open decision queue
- gate status
- artifact index
- trace index
- observability summary
- child session tree
- memory index
- concept state
- UI summary

Projection 应能从 Event 和 stored state 重建。如果重建失败，Runtime 应阻塞 mutation，并暴露 repair decision，而不是在不确定状态下继续执行。

## 规范状态

不同 adapter 使用共同状态词汇：

| Canonical | 含义 |
|---|---|
| `draft` | 已创建，但尚未准备执行。 |
| `ready` | 合法且可调度。 |
| `running` | 正在执行。 |
| `waiting_user` | 等待用户/Owner 输入。 |
| `waiting_permission` | 等待审批。 |
| `blocked` | 缺少决策或前置条件，无法继续。 |
| `failed` | 执行失败。 |
| `completed` | 成功完成。 |
| `cancelled` | Runtime/用户在完成前取消。 |
| `aborted` | Run 被有意终止为最终状态。 |

Adapter 映射：

- workflow `success` -> `completed`
- workflow `needs_decision` -> `blocked`，并带 `reason: "needs_decision"`
- workflow `needs_replan` -> `blocked`，并带 `reason: "needs_replan"`
- protocol `completed` -> `completed`
- protocol `blocked` -> `blocked`

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

推荐存储关系：

```txt
events.jsonl or event table
  -> projections/
  -> traces/
  -> adapter state files
  -> UI/API responses
```

Workflow adapter 文件位于 `docs/harness-protocol/00-harness-governance-protocol.md` 定义的 durable Harness run store 内部的 workflow-specific 目录下。

## 第一版边界

第一版应定义：

- event envelope
- 面向 UI 的 projection summary shape
- protocol/workflow/session 之间的 status mapping
- 从 sequence id 开始的 event replay
- protocol run 的 trace/export shape
- 面向 UI 和 Agent Session 消费的 observability summary
