# Bug Fix: Session Status Persisted Projection

## 问题描述

- 日期: 2026-07-03
- 严重程度: High
- 影响范围: session status API, cross-project sidebar/session tree UI, stale waiting_child display

`M-2 收口 + M-3 起步派发(branch merge / signed tag / docs sweep / M-3 backlog)` 在数据库中已经是 `terminal_success`, 且 108 个子会话结果全部完成, `pending_delegations` 为 `{}`。界面仍显示等待子会话。

## 根因分析

- 问题位置: `packages/opencode/src/session/status.ts`
- `/session/status?directory=...` 只返回进程内 `SessionStatus.state()`。
- 目标会话属于跨 project directory, 当前服务实例没有该目录的运行态缓存时, status endpoint 返回 `{}`。
- 前端 `mergeSessionStatus` 会保留已有非 idle 状态; 当 status endpoint 没有返回 terminal/completed 覆盖值时, 旧的 `waiting_child` 会继续留在 UI store 中。
- 数据库和子会话树实际已经闭合, 这是状态投影层不够稳, 不是结果 fan-in 再次失败。

## 修复方案

- `SessionStatus.list()` 合并当前目录的持久化 session status rows。
- 读取列表时复用 `recover/repair`, 让空 pending 或 child 已终态的 `waiting_child` 修正为 `completed`。
- 进程内状态仍覆盖 DB 状态, 保持 active running/rate limit 等实时状态优先。
- 增加服务端回归测试: 模拟运行态丢失后, `/session/status?directory=...` 仍从 DB 返回修复后的 `completed`。

## 验证计划

从 `packages/opencode` 运行:

- `bun test test/server/session-list.test.ts`
- `bun test test/session/status.test.ts`
- `bun typecheck`

## 验证结果

- `bun test test/server/session-list.test.ts` -> 15 pass
- `bun test test/session/status.test.ts` -> 44 pass
- `bun typecheck` -> pass
