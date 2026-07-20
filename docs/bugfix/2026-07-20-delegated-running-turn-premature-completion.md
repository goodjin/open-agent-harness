# Bug Fix: Delegated running turn prematurely completes

## 问题描述

- 日期：2026-07-20
- 严重程度：High
- 影响范围：使用 chat runner 且需要多轮工具调用的 delegated child session
- 现象：子会话首次工具调用成功后停止，没有提交结果；子会话被误标为 `terminal_success`，父会话持续停留在 `blocked_child`。

## 根因分析

- 问题位置：`packages/opencode/src/session/turn.ts`、`packages/opencode/src/session/prompt.ts`
- `SessionTurn.next()` 只选择持久化状态为 `queued` 的 turn。
- prompt loop 首轮会将 turn claim 为 `running`；模型以 `tool-calls` 结束后，processor 要求继续下一轮，但 loop 再次选择 turn 时忽略了当前 `running` turn。
- loop 因没有可选 turn 而退出，收尾逻辑在没有 queued turn 和 pending child 时写入 `completed`，最终投影为 `terminal_success`。
- delegation 层没有收到 `ActionResult`，因此不会创建 `session_result` 或恢复父会话。

## 修复方案

1. 保持 `SessionTurn.next()` 只负责 queued turn 的 FIFO drain。
2. 增加当前 active turn 选择逻辑，prompt loop 优先继续 `running` turn，没有 active turn 时再领取 queued turn。
3. 增加回归测试，覆盖 running turn 连续执行、queued FIFO、done 忽略和 running 优先级。
4. 精简 delegated chat task 的初始文本，删除重复的 ActionResult 调用协议、字段和 JSON 示例；结果协议继续由 agent system prompt 提供。
5. 保留 verifier 只读边界、任务正文和结果详略策略；protocol runner 的 AgentProtocolOutput 终态说明不在本次范围内。

## 影响文件

- `packages/opencode/src/session/turn.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/session/delegation.ts`
- `packages/opencode/test/session/turn.test.ts`
- delegation prompt 相关回归测试
- 对应 harness module 文档

## 验证计划

1. 从 `packages/opencode` 运行 turn 与 delegation 相关测试。
2. 从 `packages/opencode` 运行 `bun typecheck`。
3. 启动真实 delegated child：确认普通工具调用后进入下一轮并最终提交结果。
4. 核对 `session_result`、父会话 completed delegation 和父会话恢复状态。

## 验证结果

- ✅ `bun test test/session/turn.test.ts`：7 passed。
- ✅ `bun test test/session/prompt-runner.test.ts -t "session loop continues the running turn after ordinary tool calls"`：1 passed；确认普通工具调用后同一 running turn 进入第二轮并正常完成。
- ✅ `bun test test/session/runner.test.ts -t "default protocol runner falls back when model self-delegates to default"`：1 passed；确认 delegated chat task 保留任务正文和 detail policy，同时不再携带 ActionResult 协议段。
- ✅ `bun test test/session/delegation.test.ts`：39 passed；覆盖 canonical result、parent notification、dependent action、fallback、recovery 与 `session_continue`。
- ✅ `bun test test/session/action-result.test.ts test/session/turn.test.ts`：15 passed。
- ✅ `bun typecheck`：通过。
- ⚠️ `bun test test/session/prompt-runner.test.ts` 全文件：13 passed、3 failed。两个失败来自既有 `resumeAfter` callback 在没有 queued turn 时拒绝，另一个来自测试仍期待已不在 catalog 中的 `explore` 工具；逐个复跑结果相同，均不经过本次新增分支，未纳入本修复范围。

## 非目标

- 不改变 ActionResult schema 或存储格式。
- 不改变 planner/protocol runner 的 AgentProtocolOutput 结果载体。
- 不修改任务 admission、revision 或 sibling handoff 语义。
