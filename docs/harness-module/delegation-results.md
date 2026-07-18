# 委派结果模块

## 结果与运行状态

子会话同时存在两类状态：

- Runtime 状态描述任务是否仍在运行、阻塞或已经结束；
- 交付状态描述父会话是否收到结果，由 canonical `SessionResult` 及父会话的 delegation ledger 记录。

两者不能互相替代。阻塞的子会话可以交付 partial fallback，但这不会把 Runtime 状态改成完成，也不表示 verifier 已通过。

## 子会话整体 Run 投影

父协议 Run 中的 `agent` action 创建子会话后，子会话立即获得一个委派 Run。它代表父会话交给该子会话的整体任务，不要求子会话先输出自己的 DSL。

投影由两部分组成：`SessionAssignment` 提供任务和开始时间，canonical `SessionResult` 提供交付结果、来源和终态。读取时需要同时验证 parent session、child session、run 和 action 的关联；任一关联不匹配，assignment 内容和结果内容都不能进入该 Run。assignment 关联完整时，`task` 使用持久化 plan；无法确认关联时只回退到 delegation action 标题，避免暴露其他任务的计划内容。

没有可信 `SessionResult` 时，委派 Run 保持 `running` 且不展示结果。存在可信结果时，`failed` 映射为失败，`completed` 和 `partial` 映射为完成，其余可交付终态映射为阻塞。这个状态是委派 Run 的读取投影，不会回写或改写子会话 Runtime 状态。

每个子会话只绑定一个顶层 Task。父 action 的 canonical assignment 创建子会话 Task v1；子会话自己的 protocol Run 追加到该 Revision，不会再创建第二个 Task。assignment、父会话、父 Run、action 和子会话任一定位信息不匹配时，Runtime 拒绝绑定或读取结果，避免把其他委派的内容写入当前 Task。

## 结果正文与 fallback

不同 carrier 只读取各自约定的正文：

- `action_result` 只展示 `ActionResult.result`，不展示完整 JSON，也不拿 summary、verification 或 changed files 补成结果正文；
- `fallback_summary` 优先展示持久化 Markdown output，缺失时读取 canonical summary；
- `agent_protocol_output` 优先使用终态协议项的 message，其次使用该项 summary；
- 其他兼容 carrier 只按其 output 或 summary 投影正文。

终态记录存在但正文缺失时，Run 仍保留终态，并显示“未记录最终结果”。Runtime 不拼接元数据，也不猜测结果内容。

当终态子会话没有合法 `ActionResult` 时，delegation finalization 可以从 transcript 生成 fallback summary。失败的 `ActionResult` tool part 会作为诊断证据加入生成上下文，用于区分“没有尝试交付”和“交付被拒绝”。诊断只暴露 action id、目标 action id、role、kind、status 等短字段；结果正文等字段以类型和长度表示，错误文本与 transcript 也有长度限制。

canonical 结果先落库，再更新父、子会话的轻量投影。fallback 表示父会话已获得可用交付，不表示验证通过，也不改变子会话原有 Runtime 状态。UI 需要同时展示 Runtime 状态和 fallback 来源，不能把 fallback 标成 verifier passed。

子会话 Task 的最终正文遵循同一来源边界：合法 `ActionResult` 使用 `ActionResult.result`，无法得到合法结果时才使用显式 `fallback_summary`。原始 tool failure、schema 诊断和被拒绝的提交保留在日志与诊断面，不会混入父会话收到的任务正文。

## 修订时终止

Task 修订确认后，Runtime 先把 Task 标记为 `revising`，停止旧 active Revision 范围内仍在运行的子会话，并保存 completed、partial、failed、fallback 与终止原因。旧 Revision 在停止期间仍是可读的当前版本；收口完成后，Runtime 在同一事务中归档旧 Revision、激活 draft Revision、切换当前指针。

迟到的子结果只能落到原 assignment、Run、action 和 Revision 的诊断或归档范围，不能满足新 Revision 的 action，也不能覆盖新版本结果。历史 Revision 只读，不提供恢复执行入口。

## 内部协议 Run

子会话可以继续输出 DSL，形成自己的 protocol Run。委派 Run 与内部 Run 可以同时存在：前者承载整体委派任务及最终 `ActionResult` 或 fallback；后者记录子会话内部阶段的 actions、执行摘要和模型阶段结论。内部 Run 不复制整体委派结果。

协议 Run 的 executor 状态摘要属于 `execution_summary`，不作为最终 `summary`。最终结果尚未持久化时，即使 actions 已收敛，结果状态仍为 missing；运行中的 Run 则保持 running，不显示空结果卡片。

## 历史兼容

旧会话缺少轻量 summary 或 fallback 标记时，可以按 child session id 从父会话的 `completed_delegations` 投影补齐展示。父协议 Run 缺少独立 outcome 时，也可以从同一 Run、同一 turn 的可信 `protocol_response` 恢复结果。

这些历史路径只在读取时生效，不会覆盖 canonical `SessionResult`、创建新的 outcome，或把历史执行摘要改写成最终结果。
