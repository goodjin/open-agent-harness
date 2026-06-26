# Bug Fix: Session Tree Scroll Position

## 问题描述

- 日期: 2026-06-26
- 严重程度: Medium
- 影响范围: App 左侧会话树导航

点击较下面的会话，或通过会话树中的展示入口跳转到会话内容时，左侧会话树会自动滚动追踪选中项。这个副作用会改变用户正在查看的树位置，导致刚选中的会话或当前观察区域离开视野。

## 根因分析

- 问题位置: `packages/app/src/pages/layout.tsx`
- 原因: 会话路由同步时调用 `scrollToSession()`，该函数查询左侧树中的 `data-session-id` 元素并执行 `scrollIntoView({ block: "nearest", behavior: "smooth" })`。
- 代码流程: 点击会话或消息展示入口更新路由后，`syncSessionRoute()` 记录最近会话和已读状态，同时触发左侧容器自动滚动。

## 修复方案

- 移除会话路由同步中的左侧会话树自动滚动。
- 保留路由同步的状态职责: 记录最近会话、标记通知已读、展开当前 workspace。
- 删除不再需要的 `scrollToSession()` 和 `scrollSessionKey` 状态。

## 验证步骤

1. 运行 `packages/app` 布局单元测试。
2. 运行 `packages/app` 类型检查。
3. 运行轻量 app smoke 检查，覆盖 Vite 编译、app 启动和项目会话渲染。

## 设计约束

左侧会话树的滚动位置由用户滚动和已有的 session scroll persistence 维护。点击会话、展开会话、展示消息、切换路由都不应主动改变当前树滚动位置。
