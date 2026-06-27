# Bug Fix: Network Transport Error Restore

## 问题描述

- 日期: 2026-06-27
- 严重程度: Medium
- 影响范围: session continue / delegated child recovery / provider transport failure

Provider/network failure such as `SSE read timed out` or `Unable to connect` leaves a session in a stopped error/failure state. After the network recovers, clicking Continue should directly resume the previous session loop without adding a new user prompt. Current behavior can no-op through `mode: "restore"` or require the user to type a new message, which pollutes the prompt history.

## 根因分析

- `SSE read timed out` can become a generic `UnknownError`, so existing retry and recoverable-error logic does not classify it as transport retryable.
- `SessionStatus.Info` has `error.recoverable`, but status persistence does not currently preserve `error` detail.
- `/session/tree/resume` restore mode only accepts scheduler states. It should remain strict, but also allow explicitly recoverable transport errors.
- Delegation fallback can convert a network child failure into a generic failed handoff, hiding that the child can be retried without a new prompt.

## 修复方案

1. Classify known provider transport/network failures as retryable API errors.
2. Mark retryable transport errors as `error` with `reason: "transport"` and `recoverable: true`.
3. Persist and restore recoverable error detail.
4. Allow `/session/tree/resume` `mode: "restore"` only for scheduler states and recoverable transport errors.
5. Preserve the existing guard against broad restore of ordinary `failed/error` stopped states.

## 验证计划

1. Unit test transport error classification.
2. Unit test recoverable error status persistence.
3. Server route test that restore resumes recoverable transport error but still no-ops ordinary failed/error.
4. Run focused package tests from `packages/opencode`.

## 验证结果

- `bun test test/session/status.test.ts test/server/session-tree.test.ts test/evaluation/failure.test.ts test/session/delegation.test.ts`
  - 88 pass
- `bun typecheck`
  - pass
