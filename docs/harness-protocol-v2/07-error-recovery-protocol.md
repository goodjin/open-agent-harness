# 异常处理与恢复协议

异常处理是多 Agent 协作协议的一部分。Runtime 需要区分模型输出错误、执行错误、子任务失败、用户拒绝、中断恢复和结果不可满足依赖。

## 异常分类

| 类型 | 例子 | 处理方向 |
|---|---|---|
| Protocol error | 模型没有调用 `AgentProtocolOutput`，或 schema 校验失败。 | 提示模型按协议重试，必要时标记 recoverable error。 |
| Tool error | 工具执行失败、参数错误、权限不足。 | 记录 tool result，返回 observation，或进入 error / blocked。 |
| Delegation error | child session 创建失败、child 无结果、child 失败。 | 写入 non-satisfying result，唤醒 parent 判断。 |
| Interaction rejection | 用户拒绝 confirm。 | 记录用户决策，恢复同一 Session，让 Agent 修订计划或停止。 |
| Runtime interruption | 进程重启、网络中断、模型流中断。 | bootstrap restore，判断 auto continue 或 manual continue。 |
| Result mismatch | 有 terminal result，但不能满足依赖。 | 投递结果，不推进依赖，parent 继续处理异常分支。 |

## Protocol Error

模型输出不符合协议时，Runtime 不应直接猜测意图并执行高风险动作。

推荐处理：

```txt
invalid model output
  -> store malformed evidence
  -> send protocol reminder
  -> retry same Session when recoverable
  -> mark error or blocked after repeated failures
```

如果检测到模型试图调用 native tool 但格式不完整，可以给出明确修复提示，要求重新调用正确的 native tool。

## ActionResult Error

Worker / Verifier 的 `ActionResult` 校验失败时，Runtime 应要求 child Session 重新提交 `ActionResult`。

反复失败后，Runtime 可以停止 child Session，并生成 `SessionResult`：

- `carrier: "synthetic"` 或 `fallback_summary`
- `status: "failed"` 或 `blocked`
- `satisfying: false`

这样 parent 能看到 child 已终止，但不会误以为依赖满足。

## Child Terminal But Non-satisfying

Child Session 终态并不自动推进 parent。

常见 non-satisfying 结果：

- `reply`
- `failure`
- `error`
- verifier `failure`
- fallback summary 缺少可判定完成事实
- synthetic terminal status result

Runtime 应把结果投递给 parent，并让 parent 根据上下文决定下一步：重试、改派、请求用户输入、降级处理或停止。

## User Rejection

用户拒绝 confirm 时，Runtime 记录拒绝，并将拒绝原因或上下文返回同一 Session。

Agent 可选择：

- 修改计划。
- 缩小 scope。
- 请求更多 input。
- 给出 reply。
- 结束任务。

拒绝不应被写成系统失败，除非任务没有其他可行路径。

## Interrupted Recovery

`interrupted` 表示运行被打断，可能发生在模型流、工具调用、子任务等待或状态写入附近。

恢复时需要判断：

- 中断前的 prior 状态。
- 是否有 stale non-idempotent tool。
- 是否已有 terminal child result。
- 是否存在 pending input / confirm。
- Session 是否 still recoverable。

能自动恢复时，Runtime 自动继续。不能自动判断时，Runtime 暴露 manual continue 命令。

## Fallback Result

当 child Session 已经终止但没有标准 carrier，Runtime 可以生成 fallback result，保证 parent 有可观察事实。

fallback result 的原则：

- 保存 raw evidence 引用。
- 明确 carrier。
- 明确 status。
- 默认保守设置 `satisfying: false`，除非 Runtime 有足够证据。
- 不覆盖已有 canonical result。

## Rate Limit 与 Retry

`rate_limited` 和 `retry` 是可恢复等待状态，不是任务失败。

Runtime 应保留：

- provider / model / agent scope。
- active / limit / queued。
- reset 或 next retry 时间。
- 原始 Session 上下文。

恢复后继续同一个 Session，而不是创建新任务。

## Error Visibility

异常需要同时服务三类读者：

- Runtime：知道能否继续、如何恢复。
- 外部调用方：知道可以提交什么 command。
- Agent：知道前一步失败原因和可选下一步。

因此，错误记录应包含机器字段和人类可读摘要。机器字段用于恢复和依赖判断，人类摘要用于 trace、debug 和后续 Agent 上下文。
