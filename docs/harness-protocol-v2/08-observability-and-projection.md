# 观测与投影

观测层把 Runtime 事实投影给人类调试、外部调用方和后续 Agent。它不创造新的协议事实，而是把 Session、Assignment、Result、Event 和日志组织成可读证据。

## 事实与投影

| 层 | 例子 | 职责 |
|---|---|---|
| Canonical fact | `SessionResult`、Assignment content revision、SessionStatus | 保存可恢复事实。 |
| Event | `session.status`、event outbox | 通知其他组件发生了什么。 |
| Projection | DB status fields、outbox payload、derived summary | 提供查询和外部读取。 |
| Evidence | raw result、session log、part、tool output | 支持审计和调试。 |

文档和外部调用方应尽量说明自己读取的是哪一层，避免把投影状态当成事实状态。

## SessionResult

`SessionResult` 是跨 Session 交接结果的 canonical record。

核心字段：

- `id`
- `carrier`
- `status`
- `satisfying`
- `session_id`
- `parent_session_id`
- `child_session_id`
- `run_id`
- `action_id`
- `target_action_id`
- `raw_ref`
- `summary`
- `created_at`

`raw_ref` 指向 `session_result_raw/<result_id>`，保存原始 carrier 数据。

## Carrier

当前 carrier 包括：

- `action_result`
- `agent_protocol_output`
- `fallback_summary`
- `synthetic`

Carrier 表示结果从哪里来，不直接表示结果是否成功，也不直接表示是否满足依赖。

## Status 与 Satisfying

`SessionResult.status` 当前包括：

- `completed`
- `partial`
- `blocked`
- `failed`
- `waiting_user`
- `terminal_reply`

`satisfying` 是依赖推进的关键字段。外部调用方可以读取所有结果，但 Runtime 只能用 satisfying result 推动普通依赖。

## Event Outbox

跨进程或异步消费场景下，状态变化需要进入 outbox。Outbox 不替代 canonical record，它只是通知机制。

推荐读取顺序：

```txt
event notification
  -> load canonical record
  -> update projection
  -> update parent session / debug projection / external consumers
```

消费方不要只依赖 outbox payload 判断最终状态。

## Execution Trace

Execution trace 是运行过程的可读投影，应记录：

- user input
- model response
- protocol item summary
- tool execution
- child session creation
- child result
- pending confirm / input
- status transition
- final result

Execution trace 不应吞掉 child result。即使 parent 已继续或 session 已完成，child result 仍应稳定可查。

## Active Session Projection

Active session projection 适合保留当前执行摘要：

- active Assignment。
- pending interaction。
- waiting child count。
- latest result summary。
- manual continue command。
- recoverable / interrupted detail。

它不是任务事实来源。事实仍来自 Assignment、SessionStatus、SessionResult 和 pending interaction projection。

## Debug 视图

调试 delegation 或 parent 不恢复问题时，应分层检查：

1. Native tool call 是否发生。
2. Child Session 是否创建。
3. Child Assignment 是否存在。
4. Child 是否产生 terminal carrier。
5. `SessionResult` 是否写入。
6. Result 是否 `satisfying`。
7. Parent 是否收到 fan-in 通知。
8. Parent deps 是否满足。
9. Parent 是否创建继续 Turn。
10. 外部投影是否能读取该结果。

这套检查避免把所有问题都归为“状态不对”。

## Logs 与 DB

本地调试常用事实面：

- SQLite `session` 表状态字段。
- SQLite `session_result`。
- SQLite `assignment`。
- `session_log`。
- `part`。
- `session_status/<id>.json` 历史状态文件。
- `session_result_raw/<result_id>`。
- `session_assignment_content/<assignment_id>/rev-<n>`。

协议文档只定义语义。具体查询语句和排障命令应放到模块文档或调试手册中。
