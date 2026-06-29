# Bug Fix: Sidebar Child Summary Skips Leaf Sessions

## 问题描述

- 日期: 2026-06-29
- 严重程度: Medium
- 影响范围: Web 左侧会话树列表的子会话完成数展示

左侧会话列表可以展开看到大量子会话，但父会话右侧的 `completed/total` 摘要显示成 `1/1`。数据库和树渲染数据都包含完整子会话，问题只发生在摘要计算。

## 根因分析

- 问题位置: `packages/app/src/pages/layout/sidebar-workspace.tsx`
- 触发原因: 摘要计算调用 `childSummaryBySession()` 前先把 `props.all()` 过滤成了只有子节点的 `parents`。
- 代码流程:
  1. 会话树渲染使用完整 `props.all()` 和 `children` map，因此能展示所有子会话。
  2. 摘要计算只传入 `parents`。
  3. `childSummaryBySession()` 用传入的 `sessions` 建 `id -> session` 映射。
  4. 叶子子会话不在 `parents` 中，递归时 `by.get(child)` 失败，被当成缺失数据跳过。

## 修复方案

- 修改 `sidebar-workspace.tsx`，让 `childSummaryBySession()` 使用完整 `props.all()`。
- 添加回归测试，覆盖父会话有多个叶子子会话、且只有一个子会话还有后代时，摘要必须统计全部 descendants。

## 验证步骤

1. 运行 focused layout helper 测试。
2. 运行 `packages/app` typecheck。

## 相关测试

- `packages/app/src/pages/layout/helpers.test.ts`

## 设计建议

会话树展示和摘要汇总可以共享 `children` map，但汇总函数需要完整 session 索引。可以在展示层决定哪些节点显示摘要，不能在传入汇总函数前删除叶子节点。
