# Session 状态与生命周期

Session 是可恢复的执行容器。它承载 Agent Instance、消息、工具调用、Assignment、用户交互、子会话关系和结果投影。

## Session 与 Turn 的边界

Session 生命周期长于一次模型调用。Turn 是一次用户输入、恢复输入或 Runtime 唤醒驱动的处理周期。

当前 Turn outcome 包括：

- `completed`
- `waiting_user`
- `waiting_child`
- `failed`
- `blocked`
- `error`

Turn 结束不代表 Session 结束。一个 Session 可以等待用户、等待子会话、被中断后恢复，或者在 terminal result 后结束。

## SessionStatus

当前实现中的 SessionStatus 包括：

| 状态 | 含义 |
|---|---|
| `idle` | 无活动执行。 |
| `queued` | 已排队等待运行。 |
| `starting` | 正在启动模型或执行环境。 |
| `running` | 正在执行。 |
| `rate_limited` | 被 provider、model 或 agent 限流。 |
| `waiting_permission` | 等待权限。 |
| `waiting_user` | 等待用户输入或确认。 |
| `waiting_child` | 等待 delegated child session。 |
| `error` | 发生错误，可带 recoverable 标记。 |
| `timeout` | 执行超时。 |
| `paused` | 已暂停。 |
| `aborting` | 正在中止。 |
| `aborted` | 已中止。 |
| `failed` | 执行失败。 |
| `blocked` | 被阻塞。 |
| `interrupted` | 运行中断，可记录 prior 状态。 |
| `completed` | 正常完成。 |
| `terminal_reply` | 以回复结束，但不代表满足父依赖。 |
| `user_completed` | 用户侧标记完成。 |
| `archived` | 已归档。 |
| `retry` | 等待重试。 |

这些状态描述 Session 容器，不直接替代 Assignment 状态或 Result 状态。

## 状态类别

DB 投影中会将状态归入更粗的类别：

- `active`
- `blocked`
- `interrupted`
- `terminal`
- `archived`

状态类别用于查询、恢复和调度。具体状态仍以 `SessionStatus.Info` 为准。

## 等待状态

等待状态是协作系统里的关键分叉：

- `waiting_user`：Runtime 需要用户输入、确认或权限。
- `waiting_child`：Parent Session 依赖一个或多个 child session。
- `rate_limited`：Runtime 因限流暂缓执行。
- `retry`：Runtime 将在指定时间后重试。

等待状态不是失败。它表示 Session 暂停在某个外部条件上。

## Terminal 状态

Terminal 状态表示当前 Session 的运行已经结束或不可继续：

- `completed`
- `terminal_reply`
- `user_completed`
- `failed`
- `blocked`
- `aborted`
- `archived`

其中 `terminal_reply` 需要特别处理。它表示 Session 给出了回复并停止，但这类结果通常不满足 parent action 的普通依赖。

## 恢复顺序

启动恢复时，Runtime 需要先恢复 Session 状态，再初始化 delegation 监听。

推荐顺序：

```txt
load persisted SessionStatus
  -> restore recoverable or interrupted sessions
  -> init delegation subscriptions
  -> listen terminal child status
  -> fan-in child SessionResult
  -> auto continue parent when dependencies are satisfied
```

这个顺序避免 child 已经终态但 parent 没有被唤醒。

## Auto Continue 与 Manual Continue

Auto continue 适用于 Runtime 能确定继续是安全的场景，例如：

- Session 处于 recoverable 状态。
- interrupted 前处于 active 状态。
- 没有 stale non-idempotent tool 正在执行。
- child terminal result 已写入且依赖满足。

Manual continue 适用于仍需用户判断的场景，例如：

- stale tool 可能已经执行。
- pending confirm / input 需要用户处理。
- 失败原因无法自动修复。
- parent 需要用户选择下一步。

外部调用方不应只看是否 interrupted。它要看 Runtime 是否已经完成 bootstrap recovery，以及 Session 是否仍停在需要人工介入的状态。

## 持久化投影

当前状态事实投影到 DB `session` 表的状态字段，DB 是当前生命周期状态来源：

- `status_class`
- `status`
- `status_message`
- `status_recoverable`
- `status_updated_at`
- `status_source`
- `status_detail`

旧 JSON 状态文件 `session_status/<id>.json` 可能仍留在磁盘上，但只作为历史产物处理，不参与当前状态恢复。
