# Bug Fix: Session Panel Width Clamp

## 问题描述

- 日期: 2026-06-09
- 严重程度: Medium
- 影响范围: `packages/app` 会话页桌面布局

浏览器窗口变窄后，会话区域仍使用之前保存的固定像素宽度，右侧会话面板被推到屏幕外，无法完整看到。

## 根因分析

- 问题位置: `packages/app/src/pages/session.tsx`
- 原因: `layout.session.width()` 是持久化宽度，窗口缩小时没有按当前容器宽度重新限制。
- 相关影响: `SessionSidePanel` 通过 `calc(100% - sessionWidth)` 计算右侧宽度，如果左侧宽度仍是过大的历史值，右侧区域会变成不可见或超出屏幕。

## 修复方案

- 在会话页根 flex 容器上挂载 `ResizeObserver`，记录当前可用宽度。
- 会话区宽度取 `min(layout.session.width(), containerWidth - sideMin)`。
- 拖拽手柄和右侧面板共享同一个受限宽度，避免左右两侧计算不一致。

## 验证步骤

- `cd packages/app && bun typecheck`
- `cd packages/app && bun test:e2e:local -- app/smoke.spec.ts`
- 窄窗口打开会话页，确认右侧区域不再被固定会话宽度挤出屏幕。
