# Failed Turn Completion Recovery

## User Goal

历史失败轮次不能在后续用户发送消息时被自动重跑。一次 HTTP/request turn 即使以 assistant error 结束，也应该有明确的 `done/error` turn 标记；错误状态由 turn outcome 表达，不靠未来 loop 反复恢复执行表达。

## Agreed Scope

- `prompt.ts` 的 `result === "stop"` 分支：只要 assistant 已经 `time.completed`，就结束当前 turn。
- assistant 有 error 时写入 `status=done`、`outcome=error`、`reason=error`。
- assistant 无 error 时写入 `status=done`、`outcome=completed`、`reason=assistant`。
- `SessionTurn.fallback` 兼容历史无 turn metadata 的消息：只要同 parent assistant 已 `time.completed`，即使 assistant 有 error，也视为该 user 已处理。
- `SessionTurn.fallback` 只能用于无显式 turn metadata 的 legacy user；如果当前 user 已有 `queued` 或 `running` turn，不能因为后面存在 completed assistant 而跳过。
- 增加回归测试：旧失败 user + errored completed assistant + 新 user，loop 应跳过旧失败轮次并返回新 user 的结果。
- 增加回归测试：running turn + `tool-calls` completed assistant 仍然是未完成当前轮，prompt loop 后续应继续请求模型。

## Affected Modules

- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/turn.ts`
- `packages/opencode/test/session/prompt.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Implementation Plan

1. 调整 `result === "stop"` 分支的 turn 完成逻辑。
2. 放宽 `SessionTurn.fallback` 的历史 assistant completed 判断。
3. 添加回归测试覆盖旧失败轮次不会抢占新请求。
4. 更新 protocol runtime 文档，说明失败轮次也是 done。

## Verification Plan

- ✅ `packages/opencode`: `bun test test/session/prompt.test.ts`
- ✅ `packages/opencode`: `bun typecheck`
- ✅ `packages/opencode`: `bun test test/session/status.test.ts test/session/delegation.test.ts test/session/prompt.test.ts`
- ✅ `packages/opencode`: `bun test test/session/turn.test.ts test/session/prompt.test.ts test/session/status.test.ts test/session/delegation.test.ts`
