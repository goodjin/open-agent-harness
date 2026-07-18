# Task Recovery Revision TOCTOU 修复计划

## 问题描述

- 日期：2026-07-18
- 严重程度：Critical
- 影响范围：Task Revision bootstrap outbox 恢复与投递
- 现象：恢复流程选中当前 Revision 的 pending outbox 后，如果在异步消息查询期间激活了下一 Revision，旧 outbox 仍可能被 claim、prompt 并标记 delivered。

## 根因分析

- 问题位置：`packages/opencode/src/session/task-recovery.ts` 的 `start()`。
- `pending()` 只保证读取瞬间的 Revision 身份正确。
- 后续 claim CAS 仅校验 outbox `id + status`，没有同时校验 Session Task 的 `current_revision_id`。
- `MessageV2.get`、`Session.get` 和 `SessionPrompt.prompt` 形成多个可并发切换 Revision 的异步边界。

## 修复方案

1. 先用 barrier 测试在 `MessageV2.get` 期间激活下一 Revision，稳定复现旧 outbox 被错误投递。
2. 提供一个集中式 Revision guard，以 outbox payload 的 `task_id + revision_id` 对照 Session Task 的 `session_id + current_revision_id`。
3. 在 claim 前、lease/fixed-message 状态变更前、prompt 前后和最终 delivered 前重新校验 guard。
4. guard 失效时保留旧 outbox 状态，不 prompt、不 delivered、不解锁 Task；当前 Revision 后续仍可正常恢复。

## 影响文件

- `packages/opencode/src/session/task-recovery.ts`
- `packages/opencode/test/session/recovery.test.ts`
- `docs/harness-module/protocol-runtime.md`

## 验证计划

1. barrier 回归测试先 RED 后 GREEN。
2. 并发 claim 唯一性、lease/fixed-message 和多 Revision outbox 用例通过。
3. 相关测试集、`bun typecheck`、Agent manifest 构建、迁移一致性和 `git diff --check` 通过。

## 验证结果

- barrier 用例在修复前稳定失败：v3 激活后仍收到 v2 prompt。
- 修复后 barrier 用例验证 v2 保持 pending、Task 保持 blocked，随后 v3 可独立恢复为 delivered/running。
- 并发 claim、lease/fixed-message 及多 Revision 恢复回归通过。
