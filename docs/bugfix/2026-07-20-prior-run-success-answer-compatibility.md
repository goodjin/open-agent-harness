# Bug Fix: Prior Run `success + answer` compatibility

## 问题描述

- 日期：2026-07-20
- 严重程度：High
- 影响范围：协议 runner 在接收 delegated Run 结果后的下一次 `AgentProtocolOutput`

父 Agent 收到上一轮 delegated Run 的结果后，可能在同一个 v2 协议包中用 `success` 关闭上一轮 Run，并用 `answer` 回复用户。当前校验把两者都计为冲突的 terminal item，导致整个协议包以 `invalid_prior_run_result` 被拒绝，包内的新 agent action 也不会进入调度器。

## 目标语义

- `success`、`failure`、`error`、`reply` 中恰好一个负责提交上一轮 Run 的结果。
- `answer` 可以与上一轮结果并存，负责承载面向用户的回复。
- 上一轮结果仍须出现在新 executable action 之前。
- 多个上一轮结果项仍然拒绝，避免旧 Run 状态含糊。
- 没有上一轮结果、只有 `answer` 时仍然拒绝。

## 修复方案

1. 调整 `closureIssue`，只对上一轮结果类型计数，不再把 `answer` 当作冲突结果。
2. v2 协议同时存在结果项与 `answer` 时，优先用 `answer` 作为 declaration 的用户消息。
3. 持久化上一轮 Run 时，从原始 v2 items 单独提取结果项摘要，避免把用户回复误存成旧 Run 摘要。
4. 增加 schema 与 runner 回归测试，覆盖 `success + answer`、多个结果项及结果顺序。
5. 更新协议运行时模块文档。

## 影响文件

- `packages/opencode/src/protocol/schema.ts`
- `packages/opencode/src/session/runner.ts`
- `packages/opencode/test/protocol/schema.test.ts`
- `packages/opencode/test/session/runner.test.ts`
- `docs/harness-module/protocol-runtime.md`

## 验证计划

1. ✅ 在 `packages/opencode` 运行完整 schema 测试：41 pass。
2. ✅ 在 `packages/opencode` 运行相关 runner 测试：4 pass；新增 executable package 兼容用例单独复跑通过。
3. ✅ 在 `packages/opencode` 运行 `bun typecheck`。
