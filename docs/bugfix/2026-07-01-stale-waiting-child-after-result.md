# Bug Fix: Stale waiting child after delegated result delivery

## 问题描述

- 日期: 2026-07-01
- 严重程度: High
- 影响范围: delegated child fan-in, session tree/sidebar status, parent session closeout

父会话 `M-2 收口 + M-3 起步派发(branch merge / signed tag / docs sweep / M-3 backlog)` 显示 `Waiting for 1 delegated child session.`，但直属子会话已经全部结束。

现场数据:

- 父会话: `ses_0e4e12960ffenU3nJnvcDoVhal`
- DB 行状态: `blocked_child`
- `dsl_context.protocol.pending_delegations`: 空
- 残留相关 child: `docs_sweep_anchored_test`
- child session 状态: `terminal_success`
- child 交付的 `ActionResult.status`: `blocked/failure`

## 根因分析

问题不是子会话仍在执行，而是父会话持久化状态没有在 pending delegation 清空后收敛。

`SessionStatus.get()` 对 `waiting_child` 有 repair 逻辑，能把空 pending 或 terminal child pending 解释为 `completed`。但该 repair 只返回内存状态，没有回写 `session` 表。使用 DB 投影的列表、树或缓存路径仍会看到旧的 `blocked_child`。

## 修复方案

- 让 `SessionStatus.get()` / `SessionStatus.list()` 对 `waiting_child` 的 repair 结果持久化回 DB。
- 保留已有语义: child 的 non-satisfying `ActionResult` 仍作为结果交付给父会话，不等同于 live pending child。
- 添加回归测试覆盖:
  - `pending_delegations` 已空但 DB 状态仍是 `blocked_child` 时，读取状态会返回并持久化为 `completed`。
  - pending child row 已 terminal 时，读取父状态会返回并持久化为 `completed`。

## 影响文件

- `packages/opencode/src/session/status.ts`
- `packages/opencode/test/session/status.test.ts`
- `docs/harness-module/protocol-runtime.md`

## 验证计划

从 `packages/opencode` 运行:

- `bun test test/session/status.test.ts`
- `bun typecheck`
