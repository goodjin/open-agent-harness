# Bug Fix: ActionResult completion and stopped-session rate limit continuation

## 问题描述

- 日期: 2026-06-26
- 严重程度: High
- 影响范围: delegated worker/verifier child sessions, session status transitions, provider/model rate limit recovery

`Protocol: Review f4_1_pre_release_hygiene_worker (@general-executor-verifier)` 在提交 `ActionResult(failure)` 后继续进入下一轮 LLM 请求。该请求遇到 provider/model 限流后尝试写入 `rate_limited`，但状态机拒绝 `failed -> rate_limited`，导致 child session 变成 `terminal_error`，父 session 继续等待异常 child。

## 根因分析

- `SessionStatus` 允许完成态重新进入 `running`，但部分非归档停止态没有允许新请求先进入 `rate_limited` 或排队态。
- `SessionPrompt.loop` 只统计 `ActionResult` tool call 的成功/失败次数，没有在 delegated `ActionResult` 成功提交后立即结束当前 loop。
- `SessionPrompt.finish` 的 defer 收尾没有统一识别所有已结束状态，直接 break 后可能把 `failed` 等状态覆盖成 `completed`。

## 修复方案

- 修改 `packages/opencode/src/session/status.ts`，允许非 archived 停止态进入新请求的 `queued`、`starting`、`running`、`rate_limited` 状态。
- 修改 `packages/opencode/src/session/prompt.ts`，在 delegated `ActionResult` 成功提交后调用 `SessionDelegation.complete` 并结束当前 loop。
- 修改 `SessionPrompt.finish`，对已结束状态不再执行 waiting-child/completed 收尾覆盖。
- 增加回归测试覆盖 `failed -> rate_limited`、`blocked -> rate_limited` 等继续路径，以及 delegated `ActionResult(failure)` 不再触发后续 LLM 请求。

## 验证结果

1. ✅ `bun test test/session/status.test.ts`
2. ✅ `bun test test/session/prompt-runner.test.ts`
3. ✅ `bun test test/session/delegation.test.ts`
4. ✅ `bun typecheck`

## 文档影响

- 更新 `docs/harness-module/protocol-runtime.md`，记录非 archived 停止态可继续进入新请求等待态，以及 delegated `ActionResult` 是 child loop 的终止信号。
