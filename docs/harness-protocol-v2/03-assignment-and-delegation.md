# Assignment 与 Delegation

Assignment 是多 Agent 协作中的任务归属对象。它把任务内容、来源、目标 Session、状态和结果引用放到同一个运行时投影中。

## Assignment 定义

Assignment 表示某个 Task 当前由哪个 Session / Agent Instance 负责。它不等同于 Task 正文，也不等同于 Agent Definition。

当前实现中的 Assignment 包含：

- `id`
- `parent_id`
- `session_id`
- `source_type`
- `source_session_id`
- `source_message_id`
- `source_run_id`
- `source_action_id`
- `target`
- `title`
- `status`
- `content_ref`
- `content_hash`
- `content_version`
- `result_ref`
- `result_status`
- `time_created`
- `time_updated`

其中 `content_ref` 指向 `session_assignment_content/<assignment_id>/rev-<n>`，保存完整 plan 和 source 信息。

## Assignment Source

当前有两类来源：

| Source | 触发路径 | 说明 |
|---|---|---|
| `confirm` | 用户确认 `confirm` item 后创建或更新 | 用户确认后的任务归属。 |
| `delegation` | Parent Session 创建 child agent action | 委托子 Agent 执行时创建。 |

`confirm.plan` 是完整任务内容。`confirm.assignment` 只表达 mutation 元数据，例如：

```json
{
  "op": "create",
  "target": "self"
}
```

因此，协议文档不能把 `confirm.assignment` 写成任务正文。任务正文在 `plan`。

## Assignment Operation

当前 v2 schema 支持：

- `create`
- `update`

目标支持：

- `self`：当前 Session。
- child session id：当前 Session 的直接子会话。

Runtime 会校验目标 Session 是否存在，以及非 `self` target 是否是当前 Session 的直接 child。

## Active Assignment

一个 Session 可以有历史 Assignment，但只有一个最新的非 `superseded` Assignment 作为 active assignment。

创建新的 Assignment 时，当前 active assignment 会被标记为 `superseded`。更新 Assignment 时，会复用当前 Assignment id 并增加 content revision。

这让 Assignment 同时支持：

- 当前任务归属查询。
- 历史版本审计。
- 恢复时重建任务上下文。

## Delegation 流程

Parent Session 创建 agent item 后，Runtime 执行 delegation：

```txt
Parent AgentProtocolOutput item(kind: agent)
  -> Runtime validates action
  -> Runtime creates child Session
  -> Runtime creates child Assignment(source_type: delegation)
  -> Child Agent works
  -> Child returns ActionResult or terminal AgentProtocolOutput
  -> Runtime writes SessionResult
  -> Runtime notifies Parent
  -> Parent continues if dependencies are satisfied
```

Delegation 不是普通消息转发。Parent 只声明要委托什么；Runtime 负责创建 child session、构造 prompt、保存 assignment、监听 child 状态并处理结果。

## Parent Assignment 与 Child Assignment

Delegation 创建 child Assignment 时，会记录 parent active assignment 的 `id` 作为 `parent_id`。

这条关系说明：

- child assignment 属于哪个上级任务。
- child result 最后应回到哪个 parent action。
- 外部投影可以把任务树、会话树和结果树对齐。

Parent Assignment 的完成不等于 Child Assignment 的完成。Parent 可能需要多个 child result、verifier gate 或用户输入后才完成。

## Result Fan-in

Fan-in 是 child session 结束后，Runtime 把结果送回 parent session 的过程。

当前实现中，terminal child status 会触发 fan-in。fan-in 需要处理不同 carrier：

- `action_result`
- `agent_protocol_output`
- `fallback_summary`
- `synthetic`

Runtime 将结果写入 `SessionResult`，并标注：

- `status`
- `satisfying`
- `parent_session_id`
- `child_session_id`
- `run_id`
- `action_id`
- `target_action_id`
- `raw_ref`

`satisfying: true` 才能推动普通依赖继续。

## Worker 与 Verifier

Worker 的 `ActionResult` 表示执行结果。Verifier 的 `ActionResult` 表示对某个 `target_action_id` 的验收结论。

规则：

- Worker `success` 表示 worker 自报完成。
- Verifier `success` 或允许的 `skipped` 才能满足对应 verifier gate。
- Worker `reply` 是终态交互结果，但通常不满足执行依赖。
- Verifier `failure` 应作为问题反馈，而不是直接覆盖 worker 的任务内容。

## Assignment 状态

当前 Assignment 状态包括：

- `pending`
- `running`
- `completed`
- `failed`
- `cancelled`
- `superseded`

结果状态包括：

- `completed`
- `partial`
- `blocked`
- `failed`
- `waiting_user`

Assignment 状态描述任务归属的执行投影；Session 状态描述会话运行容器；Result 状态描述完成事实。三者需要分开读。
