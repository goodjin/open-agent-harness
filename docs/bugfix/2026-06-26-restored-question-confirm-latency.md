# Bug Fix: Restored Question Confirm Latency

## 问题描述

- 日期: 2026-06-26
- 严重程度: Medium
- 影响范围: session timeline 中由 `dsl_context` 恢复出来的 protocol confirm/input 问题卡片

用户点击确认后，前端界面会停留一会儿，没有马上进入 running / rate_limited / queued 等请求大模型阶段的可见状态。

## 根因分析

- 问题位置: `packages/opencode/src/server/routes/question.ts`
- 恢复出来的 protocol confirm/input 不是 live `Question.askReply()` 的 pending entry。
- `/question/:requestID/reply` 对这类合成问题会先更新 `dsl_context`，然后同步 `await SessionPrompt.prompt(...)`。
- `SessionPrompt.prompt()` 默认等待 session loop，因此 HTTP reply 会被后续模型请求、限流队列或模型输出阻塞。
- 前端 `SessionQuestionDock` 只有等 `sdk.client.question.reply()` 返回后才会清缓存并触发强制同步，所以这段时间界面看起来没有变化。

## 修复方案

- 合成 confirm/input 回复后立即发布对应 `question.replied` / `question.rejected` 事件。
- 后台触发 `SessionPrompt.prompt(...)` 继续会话，不再阻塞 HTTP 回复。
- 保持 `dsl_context` / `session_protocol_confirmation` / `session_protocol_input` 的持久化顺序不变，确保刷新后状态可恢复。

## 验证计划

1. 添加回归测试，证明恢复出来的 confirm/input 在 `SessionPrompt.prompt` 长时间不返回时，HTTP reply/reject 仍会立即返回。
2. 验证合成问题回复会发布 `question.replied` / `question.rejected`，前端 reducer 能立即移除 pending question。
3. 从 `packages/opencode` 运行相关测试和 typecheck。
