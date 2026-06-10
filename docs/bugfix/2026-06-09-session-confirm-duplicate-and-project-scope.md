# Bug Fix: Session confirmation duplicate card and project-scoped alerts

## 问题描述
- 日期: 2026-06-09
- 严重程度: High
- 影响范围: Web session timeline, protocol confirmation flow, global question alerts

`Protocol: Entity Designer bridge (ChangeSet diff)` 这类协议确认会在会话区出现两个确认框。点击确认后还会跳到会话底部，且状态刷新不及时。另一个问题是未打开项目里的确认请求也会弹出全局提示。

## 根因分析
- 问题位置: `packages/app/src/pages/session/message-timeline.tsx`
- 原因: timeline 同时渲染 protocol confirmation card 和普通 question card。去重条件只比较了 `tool.messageID` 和 confirmation `message_id`，但没有比较 `callID`，导致同一个确认请求仍被普通 question 卡接收。
- 问题位置: `packages/app/src/pages/session/composer/session-question-dock.tsx`、`packages/app/src/pages/session.tsx`
- 原因: question dock 在网络请求发出前就调用 `onSubmit()`，session 页的回调又会 `resumeScroll()`，所以点击确认会先跳到底部，并且刷新发生在服务端状态更新之前。
- 问题位置: `packages/app/src/pages/layout.tsx`
- 原因: 全局 `question.asked` 事件没有按当前项目过滤，非当前 directory 的确认也会 toast/notify。

## 修复方案
- `message-timeline.tsx`: 用 `messageID + callID` 建立 confirmation 和 question request 的精确匹配，匹配到 protocol confirmation 时只渲染 confirmation card。
- `session-question-dock.tsx`: `reply/reject` 成功后再触发刷新回调。
- `session.tsx`: question submit 只强制刷新当前会话详情，不恢复自动滚动。
- `layout.tsx`: 非当前项目的 `question.asked` 不弹 toast 或系统通知，切换到目标项目后由会话区展示。
- `question/service.ts`、`question/index.ts`、`runner.ts`: 服务端保留 explicit `response`，protocol confirm runner 优先按 `response` 判断确认或取消。

## 验证步骤
1. ✅ 添加 confirmation/question key 匹配单测。
2. ✅ 添加 `Question.askReply()` 保留 explicit `response` 单测。
3. ✅ 运行 app/opencode 相关测试和 typecheck。
4. ✅ 运行 app smoke 检查。

## 相关测试
- `packages/app/src/pages/session/message-timeline.test.ts`
- `packages/opencode/test/question/question.test.ts`
- `packages/opencode/test/server/question-routes.test.ts`
