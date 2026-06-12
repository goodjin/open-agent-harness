# Bug Fix: Sidebar Session Scroll Reset

## 问题描述
- 日期: 2026-06-10
- 严重程度: Medium
- 影响范围: 左侧会话树

点击会话树靠下位置的会话后，路由切换期间列表滚动位置可能被重置到顶部。

## 根因分析
- 问题位置: `packages/app/src/pages/layout/sidebar-workspace.tsx`
- 原因: 路由切换或列表 reconcile 过程中，滚动容器可能短暂产生 `scrollTop = 0` 的滚动事件。原逻辑无条件把该值写回 `sessionScroll`，覆盖了用户手动滚到下方的位置，后续恢复也只能按 0 恢复。

## 修复方案
- 新增 `sessionScrollWrite`，在会话路由 settling 期间忽略已有滚动位置下的瞬时归零事件。
- 路由变化时短暂进入 settling 状态；如果 DOM 已经被归零，则用保存的滚动位置恢复。
- 去掉点击会话时按 active row 自动追踪滚动的行为。会话树只恢复用户保存的滚动位置，不再为了让当前 active 会话露出来而上下调整列表。

## 验证步骤
1. 添加回归测试覆盖 settling 期间 `top=0` 不写回。
2. 本地创建 30 个临时会话，滚到下方后点击下方会话，确认 `scrollTop` 保持不变。
3. 连续点击两个下方会话，确认每次点击前后 `scrollTop` 都保持不变。
4. 运行 layout 测试、类型检查和 app smoke。

## 相关测试
- `bun test --preload ./happydom.ts ./src/pages/layout`
- `bun typecheck`
- `bun test:e2e:local -- app/smoke.spec.ts`
