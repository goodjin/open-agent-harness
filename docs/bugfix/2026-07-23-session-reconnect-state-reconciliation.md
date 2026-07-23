# Bug Fix: 会话重连后仍显示请求排队

## 问题描述

- 日期：2026-07-23
- 严重程度：High
- 影响范围：当前会话状态、消息 Turn 状态、子会话列表与任务图

会话“查询PRD需求并分模块核对完成度”在确认后已经进入运行并派发子会话，但原页面仍显示“请求排队中 / 请求已持久化，等待当前运行结束后消费”。刷新页面后状态和子会话可以恢复，说明 Runtime 没有停在队列中，前端缓存没有在实时连接恢复后完成对账。

## 证据与根因

1. Runtime 日志显示确认请求成功，紧接着会话由 `waiting_user` 进入 `running`，模型请求已开始。
2. Turn 从 `queued` 认领为 `running` 时通过 `message.updated` 广播；子会话创建通过 `session.created` 广播。
3. 页面依赖这些实时事件更新本地 Store。若服务重启或 SSE 短暂断线期间错过事件，当前页面不会补拉消息。
4. `server.connected` 虽然触发目录 bootstrap，但会话树加载受 `sessionMeta` 缓存短路，实际不会重新请求会话和 descendants。
5. Runs 面板对 descendants 只执行一次请求，不能弥补连接中断期间错过的子会话事件。

## 修复方案

- 在全局同步状态中记录实时连接代次；每次 `server.connected` 或 `global.disposed` 时递增。
- 连接恢复时清除各目录的会话树加载元数据，再触发目录 bootstrap，使状态、根会话和 descendants 从服务端重新对账。
- 当前会话监听页面连接代次；代次变化后强制同步会话详情、最新消息页和 Todo，使 Turn 的持久化状态覆盖旧缓存。
- Runs 侧栏在连接代次变化后重新请求当前会话 descendants，避免只依赖一次性懒加载和实时事件。
- 保留 Runtime 的队列语义，不依据会话级 `running` 状态猜测某个 queued Turn 是否已经开始。

## 影响模块

- `packages/app/src/context/global-sync.tsx`
- `packages/app/src/context/global-sync/event-reducer.ts`
- `packages/app/src/pages/session.tsx`
- `packages/app/src/pages/session/session-side-panel.tsx`
- `docs/harness-module/ui-console.md`

## 验证计划

1. 单元测试覆盖 `server.connected` 与 `global.disposed` 同时触发全局刷新和会话对账通知。
2. 当前会话在连接代次变化后强制拉取消息，已认领 Turn 不再保持旧的 `queued` 展示。
3. Runs 面板在连接恢复后重新加载 descendants，错过 `session.created` 事件也能展示子会话。
4. 在 `packages/app` 执行相关单元测试、`bun typecheck` 和本地应用冒烟测试。
5. 重启 4096 服务并在浏览器中检查目标会话的状态、Runs 和子会话列表。
