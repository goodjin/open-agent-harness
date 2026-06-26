# Bug Fix: session tree resume state policy

## 问题描述

- 日期: 2026-06-26
- 严重程度: Medium
- 影响范围: session tree resume, timeline child resume, session-level abnormal continue UI

`Protocol: imp_r8_guard_regex (@backend)` 在 UI 中显示等待/可继续，但点击继续没有可见效果。DB 中该会话实际已经是 `terminal_error`，错误为旧状态机的 `blocked -> rate_limited`。当前 `/session/tree/resume` 默认 `restore` 模式只处理 `interrupted`，其他状态返回 `{ resumed: 0 }`，前端没有提示，因此用户看到的是“没反应”。

## 根因分析

- 服务端没有明确区分恢复原 loop 的 `restore` 模式和追加用户消息的 `message` 模式。
- `restore` 模式只允许 `interrupted`，没有覆盖 `queued`、`rate_limited`、`retry` 等可重新挂回调度的状态。
- `error`、`failed`、`blocked`、`paused`、`aborted`、`timeout` 这类 stopped 状态需要 user-driven message 继续，不能静默走 restore。
- 前端忽略 `resumed: 0`，没有刷新状态或提示用户切换继续方式。

## 修复方案

- 在服务端定义明确状态表：
  - `restore`: `interrupted`、`queued`、`rate_limited`、`retry`、`running`、`starting`。
  - `message`: 除 `archived` 外均可发送；`completed`、`terminal_reply`、`user_completed` 仍需 `include_completed`。
- 更新 session tree restore 测试，确认 aborted 默认 restore 不再误恢复，message mode 可以继续 stopped 会话。
- 前端处理 `{ resumed: 0 }`，强制刷新当前 session 并显示“未恢复会话”的提示。

## 验证计划

1. 运行 `bun test test/server/session-tree.test.ts`。
2. 运行 `bun test:e2e:local -- app/smoke.spec.ts`。
3. 运行 `bun typecheck`。

## 验证结果

- `packages/opencode`: `bun test test/server/session-tree.test.ts` 通过。
- `packages/opencode`: `bun typecheck` 通过。
- `packages/app`: `bun typecheck` 通过。
- `packages/app`: `bun test:e2e:local -- app/smoke.spec.ts` 通过。

## 文档影响

- 更新 `docs/harness-module/protocol-runtime.md` 的 session tree resume 状态策略。
