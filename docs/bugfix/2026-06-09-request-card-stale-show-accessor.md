# Bug Fix: Request Card Stale Show Accessor

## 问题描述

- 日期: 2026-06-09
- 严重程度: High
- 影响范围: 会话自动恢复后，在时间线里的确认/提问卡片点击确认

自动恢复会话后，用户在确认卡片里提交回复，前端 toast 显示请求失败：

`Attempting to access a stale value from <Show> that could possibly be undefined.`

## 根因分析

- 问题位置: `packages/app/src/pages/session/message-timeline.tsx`
- 原因: 时间线 request card 使用 Solid `<Show>` render function 的 accessor，并在 JSX prop 表达式里继续调用 `request()`。
- 代码流程:
  1. 自动恢复后，时间线渲染 active turn 的 question/permission request card。
  2. `SessionQuestionDock` 提交回复后，请求状态被清除，外层 `<Show>` 条件变为 false。
  3. 子组件的 async 清理逻辑继续读取 `props.request.id`。
  4. 该 prop 仍绑定到外层 `<Show>` accessor 表达式，Solid 检测到 accessor 已 stale 并抛错。

## 修复方案

- 修改文件: `packages/app/src/pages/session/message-timeline.tsx`
- 修改内容:
  - 在 `<Show>` render function 内立即读取 `const req = request()`。
  - 将稳定的 `req` 传给 `SessionQuestionDock` 和 `SessionPermissionDock`。
  - 同时把 `submit` / `decide` 回调提前取成局部常量，避免子组件回调延迟读取外层 props 表达式。
  - 收紧 request card 展示条件：确认/权限请求必须匹配当前会话的 active turn，或者匹配该 turn 直接/间接创建的子会话。
  - 子会话请求只展示在父会话区域内对应的任务 turn 下，不作为全局确认框影响其它会话切换。

## 验证步骤

1. 静态扫描确认 request card 不再把 `<Show>` accessor 直接传给子组件。
2. 运行前端类型检查。
3. 运行 app 本地 smoke。

## 相关测试

- `cd packages/app && bun typecheck`
- `cd packages/app && bun test:e2e:local -- app/smoke.spec.ts`

## 设计建议

Solid `<Show>` render function 返回的是 accessor。组件 prop、事件回调、timer、promise cleanup 如果可能在条件卸载后执行，应先把 accessor 的值解包成稳定局部值再传递。
