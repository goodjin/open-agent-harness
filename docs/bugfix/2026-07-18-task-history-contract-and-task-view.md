# Bug Fix: Task 历史契约与任务视图可信性

## 问题描述

- 日期：2026-07-18
- 严重程度：Critical
- 影响范围：Task History/Revision API、Handoff 摘要、SDK、Session Task 页面

Task8 首版把单任务入口接入 Session 主区域，但归档版本缺少原终态、停止子会话数与结果等级；current/revision 的 Handoff 恒为空；前端对 missing outcome 仍可能渲染无来源 result，历史进度也未与 current 的 compact/skipped 口径对齐。现有请求竞态测试只检查源码结构，没有验证旧 Promise 不能覆盖新状态。

## 根因分析

- `task_revision.status` 归档时直接从 `active` 改为 `archived`，没有持久化归档前的可信终态。
- `SessionTaskRecovery.resume()` 已持有 canonical revision scope，但 `SessionTask.activate()` 没有接收并保存 stopped child count。
- `SessionTask.current()`、`revision()` 和 `legacy()` 都把 `handoffs` 写死为 `[]`。
- 前端结果正文只检查 `task.result`，没有以 outcome classification 作为渲染边界。
- 历史进度只数 completed action，未纳入 skipped 与 `workflow.compact`。
- UI 内部异步状态与 Solid store 耦合，难以用可控 Promise 覆盖 stale response 行为。

## 修复方案

1. 为 `task_revision` 增加 `terminal_status`、`stopped_child_count`、`result_status`，在 revision 激活事务归档旧版本时写入；结果等级只从 revision workflow/result source 与匹配 action identity 的 canonical `session_result` 聚合。
2. History 仅返回归档摘要 metadata，不返回 body/workflow/result 正文；Revision 返回完整快照及归档 metadata。
3. 为 Task Handoff 增加按 task ID 查询的规范化摘要，并接入 current/revision/legacy，保持 session/task 归属过滤。
4. 抽取前端 outcome、progress、状态标签和可控异步加载 controller；用 deferred Promise 验证 session/current/history/revision 的竞态。
5. missing outcome 不渲染 raw result；历史标题明确归档版本；状态双语映射；loading 使用 `aria-live`，error 使用 `role="alert"`。

## 影响文件

- `packages/opencode/src/session/session.sql.ts`
- `packages/opencode/src/session/task.ts`
- `packages/opencode/src/session/task-handoff.ts`
- `packages/opencode/src/session/task-recovery.ts`
- `packages/opencode/migration/20260718190000_task_revision_archive_metadata/migration.sql`
- `packages/opencode/test/session/task.test.ts`
- `packages/opencode/test/server/session-task.test.ts`
- generated OpenAPI / JavaScript SDK
- `packages/app/src/pages/session/session-task-data.ts`
- `packages/app/src/pages/session/session-task.tsx`
- `packages/app/src/pages/session/session-task.test.ts`
- `packages/app/src/i18n/en.ts`
- `packages/app/src/i18n/zh.ts`

## 验证计划

1. RED：Task/API 测试证明归档 metadata 与 Handoff 缺失。
2. GREEN：运行 Task、Recovery、Handoff、API 聚焦测试。
3. 重新生成 OpenAPI 与 JavaScript SDK，运行生成一致性检查和 migration check。
4. RED/GREEN：前端 outcome、progress、加载竞态与可访问性测试。
5. 运行 opencode/app typecheck、app smoke、`git diff --check`。

## 验证结果

- `packages/opencode` Task、Recovery、Handoff、Task API：108 passed。
- `packages/opencode` typecheck、SDK 一致性检查、Drizzle migration check：通过。
- `packages/app` 单元测试：487 passed；typecheck：通过。
- `packages/app` 本地 smoke：Chromium 1 passed，覆盖 Vite 编译、应用启动与项目 Session 渲染。
- 旧归档空 metadata、legacy handoff、可信结果正文、compact/skipped 进度和异步竞态均有回归测试。
