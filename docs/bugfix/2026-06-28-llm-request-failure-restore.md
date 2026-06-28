# Bug Fix: LLM Request Failure Restore

## 问题描述

- 日期: 2026-06-28
- 严重程度: High
- 影响范围: session resume, provider failures, single-session continue

`Protocol: epic_m2_chaidep_extension_host (@epic-planner)` 因 `Unable to connect` 停在 `terminal_error` 后，点击继续不能直接恢复旧 loop，而是提示需要输入 resume message。

## 根因分析

- 问题位置: `packages/opencode/src/server/routes/session.ts`
- 当前 `/session/tree/resume` 的 `restore` 模式只允许 scheduler 状态，或显式 `reason: "transport"` 的 stopped 状态。
- 历史错误可能只持久化为 `{ type: "error", message }`，没有 `reason: "transport"`。
- 更重要的是，能否直接继续不应只看错误分类，而应看上一轮 LLM 请求是否已经产生可消费输出或工具副作用。

## 修复方案

- 保留 scheduler 状态直接 restore。
- 对 `error` / `timeout` / `failed`，检查最近 assistant:
  - 有 `error`;
  - 没有有效文本输出;
  - 没有 completed/error tool part。
- 满足以上条件时，认为是 LLM 请求失败，允许直接 restore 原 loop。
- `aborted`、完成态、等待用户/权限、已有工具副作用的失败仍不直接 restore。

## 验证计划

1. 新增路由测试: 无 transport reason 的 provider/auth/quota 类 LLM error 可直接 restore。
2. 新增路由测试: 已有 tool result/error 的 failed session 不走 restore。
3. 运行 `packages/opencode` 下 `bun test test/server/session-tree.test.ts`。
4. 运行 `packages/opencode` 下 `bun typecheck`。

## 文档影响

- 更新 `docs/harness-module/protocol-runtime.md` 的 resume 语义说明。
