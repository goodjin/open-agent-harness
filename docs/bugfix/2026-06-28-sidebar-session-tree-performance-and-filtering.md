# Bug Fix: Sidebar Session Tree Filtering And Performance

## 问题描述

- 日期: 2026-06-28
- 严重程度: Medium
- 影响范围: 左侧会话树的状态过滤、树线展示、展开收起响应速度、会话树数据加载

左侧会话树存在几个相关问题：

- 树形竖线有时在中间断开，层级关系不够完整。
- 顶部过滤按少量状态推断，部分状态无法按预期筛出。
- 展开/收起在大树上反应慢。
- 当前全局同步优先使用 `/session/tree`，该接口按 root 返回树投影并聚合 message stats；侧栏最终仍由前端基于 `parentID` 构树，存在不必要开销。

## 根因分析

- 状态过滤只分 `running`、`ended`、`failed`、`success`，且 `failed` 未覆盖 `failed`、`blocked`、`aborted` 等状态。
- 手写虚拟列表只减少 DOM 行数，展开/过滤时仍会完整计算可见树、导航列表和子摘要。
- 树线是每一行内部局部绘制，虚拟 spacer 区域不画线；行内容层和展开按钮背景也可能遮挡同一 x 轴的竖线。
- `loadSessionTreeWithFallback` 优先调用 `/session/tree`，导致每个 root 一次请求，并触发后端 message stats 聚合；侧栏只需要扁平 session + status 即可。

## 修复方案

- 将侧栏状态过滤改为分类过滤：活跃、等待、成功、失败、停止。
- 增加统一状态分类 helper，覆盖已知 session status，过滤时保留命中子孙的祖先路径。
- 全局侧栏加载优先使用 `/session/descendants` 扁平批量接口，避免 `/session/tree` 的多 root fan-out 和 message stats 聚合。
- 优化虚拟列表计算，避免同一轮渲染重复调用 `tree()`，并限制子摘要计算范围。
- 调整树线绘制和层级，降低被行内容遮挡的概率，并补齐虚拟切片边界的 guide 连续性。

## 影响文件

- `packages/app/src/context/global-sync/session-load.ts`
- `packages/app/src/pages/layout/sidebar-workspace.tsx`
- `packages/app/src/pages/layout/sidebar-items.tsx`
- `packages/app/src/pages/layout/helpers.ts`
- `packages/app/src/pages/layout/helpers.test.ts`
- `docs/harness-module/session-sidebar.md`

## 验证结果

1. ✅ 从 `packages/app` 运行 `bun test src/pages/layout/helpers.test.ts src/context/global-sync.test.ts`
2. ✅ 从 `packages/app` 运行 `bun typecheck`
3. ✅ 从 `packages/app` 运行 `bun test:e2e:local -- app/smoke.spec.ts`
4. ✅ 检查工作区 diff，提交范围只包含本次侧栏树相关文件
