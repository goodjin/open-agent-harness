# Bug Fix: Protocol Confirm Turn and Queued Message Control

## 问题描述

- 日期: 2026-06-29
- 严重程度: High
- 影响范围: protocol runner confirmation flow, session timeline, queued follow-up messages

`lowcode-ai v0.4.3 推进 Prompt 与进度汇总` 会话中，用户确认计划后会话仍回到确认状态，后续发送的消息进入队列后缺少持久化删除入口。

## 根因分析

- 后端已经将 `confirm_v0_4_3_plan` 记录为 completed，但 protocol final 汇总完成后，原始 user turn 仍可能保持 `running`，prompt loop 会再次选中同一个 user turn，导致模型重新输出 confirm 包。
- 确认结果现在主要写入 `dsl_context.protocol.confirmations` 和 storage，timeline 可以显示确认卡状态，但缺少一条用户选择本身的会话历史记录。
- 后端已有 `DELETE /session/{sessionID}/message/{messageID}/queued`，语义只允许删除 `role=user` 且 `metadata.turn.status === "queued"` 的消息；前端只给本地 follow-up 草稿提供取消按钮，没有给已经持久化的 queued user message 暴露删除入口。

## 修复方案

1. 在 protocol confirm 解析用户选择后，写入一条 synthetic user message：
   - 内容包含确认动作、用户选择和计划摘要。
   - `metadata.turn.status` 直接标为 `done`，避免被 `SessionPrompt.turn()` 当作新任务。
   - 作为普通 user message + text part 进入 `MessageV2.toModelMessages()`，成为后续模型历史的一部分。
2. protocol final 完成后，对原始 user turn 执行 `SessionTurn.finish()`：
   - final `answer` / `done` / plain fallback 成功完成时，把原 turn 标为 `done`。
   - 避免确认完成后同一 turn 被再次执行并重复询问确认。
3. 前端 timeline 给持久化 queued user message 提供删除按钮：
   - 只对 `metadata.turn.status === "queued"` 的 user message 显示。
   - 调用现有 `session.cancelQueuedMessage` SDK。
   - 删除失败时走现有 toast 错误路径。

## 影响文件

- `packages/opencode/src/session/runner.ts`
- `packages/app/src/pages/session/message-timeline.tsx`
- `packages/opencode/test/session/runner.test.ts`
- `packages/app/src/pages/session/message-timeline.test.ts`
- `docs/harness-module/protocol-runtime.md`

## 验证计划

1. 运行 protocol runner 聚焦测试，覆盖确认记录、模型历史、turn 收口。
2. 运行 session timeline 聚焦测试，覆盖 queued user message 删除入口判断。
3. 从 `packages/opencode` 运行 `bun typecheck`。
4. 从 `packages/app` 运行 `bun typecheck`。

## 设计建议

- 确认和输入都属于用户对 runtime question 的回答，应进入 durable conversation history，而不是只存在于临时 question 通道。
- queued prompt 的 UI 控制应区分本地草稿队列与后端持久化队列，两者都需要可撤销入口。
