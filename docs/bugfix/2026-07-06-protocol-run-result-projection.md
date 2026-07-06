# Bug Fix: Protocol Run Result Projection

## 问题描述

- 日期: 2026-07-06
- 严重程度: High
- 影响范围: protocol graph, delegated action result display, completed parent sessions

`整合 src/ 与 packages/ 两套 api-server` 的根会话已经是 `terminal_success`, `pending_delegations` 为 `{}`, 4096 `/session/status?directory=/Users/jin/codewave/lowcode-ai` 返回根会话 `completed`。界面仍可能在 Protocol 图里显示等待或 blocked。

## 根因分析

- 问题位置: `packages/opencode/src/session/delegation.ts`
- `runner.ts` 初次派发 delegated action 时会把当前 protocol run/action 写入 `dsl_context.protocol.runs`。异步 child 边界在当轮模型中表现为 `blocked`, 这是合理的临时投影。
- child 完成后, `delegation.ts` 会写 `session_result`, 清理 `pending_delegations`, 更新 `completed_delegations`, 并刷新 parent session status。
- 但 child result fan-in 没有同步回写 `dsl_context.protocol.runs[].actions[]`, 导致 UI graph 继续读取旧的 `blocked` action 快照。
- 前两次修复覆盖了 result 生成、pending 清理和 session status projection, 没覆盖 protocol run graph projection。

## 修复方案

- 在 `SessionDelegation.store()` 写入 parent completed delegation 时, 同步修正 matching `run_id + action_id` 的 run action。
- action status 由 canonical `SessionResult.status` 映射到 graph status。
- action summary 使用 child result summary。
- run status 根据 action 状态重算: 有 failed => failed; 有 blocked => blocked; 有 running/pending => running; 否则 completed。
- 保留 failed/blocked/reply 结果的语义, 让父会话裁决, 但不再误显示为仍在等待 child。

## 验证计划

从 `packages/opencode` 运行:

- `bun test test/session/delegation.test.ts`
- `bun typecheck`

从 `packages/app` 运行:

- `bun test src/pages/session/session-graph.test.ts`
- `bun typecheck`
- `bun test:e2e:local -- app/smoke.spec.ts`

## 验证结果

- `bun test test/session/delegation.test.ts` -> 35 pass
- `bun typecheck` (`packages/opencode`) -> pass
- `bun test src/pages/session/session-graph.test.ts` -> 5 pass
- `bun typecheck` (`packages/app`) -> pass
- `bun test:e2e:local -- app/smoke.spec.ts` -> 1 pass
- Real session projection check for `ses_0deb8a80dffe3fMfcAcmV2PpYf` -> latest run `apr_f35463137002YiSGChvsNRdNY8` renders `blocked` with failed/completed nodes instead of pending/waiting.
