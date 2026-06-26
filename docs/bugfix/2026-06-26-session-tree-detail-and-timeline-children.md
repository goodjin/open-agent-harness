# Bug Fix: Session Tree Detail Split and Timeline Child Lists

## 问题描述

- 日期: 2026-06-26
- 严重程度: High
- 影响范围: session 页面、子会话 timeline 列表、右侧 Protocol/Graph 子会话计数

会话树刷新使用 `session.list` / `descendants` 返回的 slim session。slim session 会移除 `dsl_context`，但前端把这些对象写回同一个 `session` store，可能覆盖已经通过 `session.get` 获取的完整会话对象，导致 timeline 读取不到 `dsl_context.protocol.pending_delegations` / `completed_delegations`，子会话列表消失。

## 根因分析

- `session` store 同时承载会话树投影和完整会话详情。
- 会话树查询本应只驱动树渲染，但当前 descendants 刷新会覆盖 full session。
- timeline 历史子会话列表只从父 session `dsl_context` 动态推导，没有落在具体 turn 的历史记录上。

## 修复方案

- 拆分前端 store:
  - `session`: 只保存轻量会话树/list 投影。
  - `session_info`: 只保存 `session.get` 或 full `session.updated` 事件得到的完整会话。
- `sync.session.get()` 优先读 `session_info`，再回退树投影用于标题等轻量显示。
- 会话树查询和 descendants 预取不写入 `session_info`，不能覆盖完整会话详情。
- delegation 派发、完成、通知 parent 时，将子会话列表投影写入对应 user turn 的 `metadata.turn.children`。
- timeline 优先读取 turn metadata 中的历史子会话列表，以保证顺序和重启后的显示稳定性；父 session `dsl_context` 只作为兼容旧数据的 fallback。
- slim `session.updated` 事件只能更新树投影；如果 full session detail 已经存在，合并轻量字段时必须保留既有 `dsl_context`，避免详情区重新退化成 slim session。

## 验证步骤

1. 运行 focused app store / delegation tests。
2. 运行 `packages/app` typecheck。
3. 如果涉及页面渲染，运行 app smoke。

## 相关测试

- `packages/app/src/context/global-sync.test.ts`
- `packages/app/src/context/global-sync/event-reducer.test.ts`
- `packages/app/src/pages/session/session-delegations.test.ts`
- `packages/opencode/test/session/delegation.test.ts`

## 设计建议

会话树、完整会话详情、timeline 历史投影应保持独立。`dsl_context` 继续作为运行时协议上下文，但 UI 历史子会话列表应落在 turn metadata，避免为了渲染历史读取完整父会话上下文。
