# Bug Fix: Session Timeline Blank After Long Content

## 问题描述

- 日期: 2026-06-02
- 严重程度: High
- 影响范围: 主会话区长内容渲染

主会话区在内容较多时偶发空白，需要切换到其他会话再切回才恢复显示。

## 根因分析

- 问题位置:
  - `packages/app/src/pages/session/message-timeline.tsx`
  - `packages/ui/src/components/message-part.css`
- 原因: Timeline 每条消息外层和 assistant message 根节点都启用了 `content-visibility: auto`。长会话中消息高度动态变化，并且页面同时存在历史窗口、自动滚动和滚动恢复逻辑，浏览器可能把可见区内容继续保留在跳过绘制状态。切换会话会重挂载 Timeline，因此显示恢复。

## 修复方案

- 移除 Timeline 消息外层的 `content-visibility: auto` / `contain-intrinsic-size`。
- 移除 assistant message 根节点的 `content-visibility: auto`。
- 保留现有历史窗口逻辑，由应用层限制长会话初始挂载量。

## 验证步骤

1. 运行 `bun typecheck`，确认类型检查通过。
2. 运行 session 相关单测，确认滚动和 session helper 逻辑通过。
3. 检查本地前端服务 `http://127.0.0.1:3001` 返回 200。

## 相关测试

- `bun test src/pages/session/helpers.test.ts src/pages/session/use-session-hash-scroll.test.ts src/pages/session/message-gesture.test.ts`
