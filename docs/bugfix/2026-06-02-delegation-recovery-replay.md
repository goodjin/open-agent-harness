# Bug Fix: Delegation Recovery Replayed Historical Results

## 问题描述

- 日期: 2026-06-02
- 严重程度: High
- 影响范围: protocol parent sessions with persisted child delegation history

The codewave parent session repeatedly received completed child delegation results from older runs. The runtime appeared to loop because each replayed child result triggered another parent follow-up.

## 根因分析

- 问题位置: `packages/opencode/src/session/delegation.ts`
- `SessionDelegation.recover()` scanned persisted child assignments and called `complete()` for every assignment.
- Historical child assignments could have `status/output` but no child-side `notified_at`.
- The parent projection already contained those children in `completed_delegations` and had no pending work, but `complete()` only checked child-side `notified_at`, so it treated old results as undelivered and prompted the parent again.

## 修复方案

- Treat parent `completed_delegations` as the durable delivery projection for historical recovery.
- If the child is no longer in parent `pending_delegations` and already exists in parent `completed_delegations`, recovery now only reconciles `notified_at` and does not notify the parent.
- Keep pending entries until notification succeeds, then remove pending and stamp `notified_at` on both child assignment and parent completed projection.

## 验证步骤

1. Added a failing recovery regression test for historical completed delegations.
2. Applied the recovery and notification state fix.
3. Verified targeted session delegation, prompt runner, nested parent notification, and typecheck.

## 相关测试

- `bun test test/session/delegation.test.ts test/session/prompt-runner.test.ts --timeout 30000`
- `bun test test/session/runner.test.ts -t "protocol runner completes parent assignment after nested child final" --timeout 30000`
- `bun typecheck`
