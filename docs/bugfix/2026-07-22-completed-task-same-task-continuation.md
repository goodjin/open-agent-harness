# Bug Fix: 已完成主任务无法继续派发同任务子会话

## 问题描述

- 日期：2026-07-22
- 严重程度：High
- 影响范围：主会话任务完成后，用户继续提出属于同一任务的执行请求

`lowcode-ai` 项目的会话“查询PRD需求并分模块核对完成度”生成了合法的 Agent Protocol action graph，但没有创建子会话。界面只显示工具调用完成，后续没有可见响应。

## 根因分析

- 当前 `Task` 与 `Revision` 已因上一轮协议结果进入 `completed`。
- 新协议包属于同一任务的后续执行，运行时应追加一个新的 Run。
- `SessionTask.write()` 目前只允许 `legacy` 任务重新激活终态 Revision；普通 `user` 主任务会抛出 `session_task_revision_not_active`。
- 异常发生在 Run 持久化和子会话创建之前，且协议 runner 没有把这类绑定失败写成可见的失败结果，最终造成“工具调用后没反应”。
- 修复后进行真实恢复时进一步确认：恢复出的 delegated blocked Run 会进入普通的 blocked 修复分支，再请求一次模型，造成相同 Agent 子任务重复派发；恢复入口也没有自行结束原用户 Turn 和投影 `waiting_child`。

## 目标语义

1. 一个会话仍只绑定一个 Task。
2. 用户在同一 Task 内继续执行时，可以在当前 Revision 上追加新的 Run。
3. 已完成或失败的非委派 Task 在追加 Run 前重新进入 `running/active`，旧 Run 和结果作为历史记录保留。
4. `delegation` 子任务保持终态约束，避免子会话自行复活已交付任务。
5. 协议绑定失败必须形成可见、可诊断的失败记录，不能静默把会话收口为完成。

## 修复方案

1. 扩展 `SessionTask.write()` 的终态 Revision 重激活条件：允许非 `delegation` Task 在存在新 `runID` 时重新激活。
2. 重激活时同步把 Task 状态恢复为 `running`，清理当前 Revision 的终态结果字段，但保留 workflow 中历史 Run 数据。
3. 在协议入口捕获执行前的 `SessionTask.Conflict`，写入协议失败文本、日志和错误完成状态。
4. delegated Run 已创建子会话时，不进入 blocked Run 的模型修复分支；等待真实子结果后再恢复父会话。
5. 协议恢复成功创建或复用子会话后，显式结束原用户 Turn 并投影 `waiting_child`，避免同一 Turn 再次生成 action graph。
6. 增加任务层测试，覆盖普通主任务完成后追加新 Run，以及 delegated Task 不可复活。
7. 增加 runner 测试，验证同任务续跑、恢复派发、已有子会话恢复和绑定冲突可见性。
8. 更新协议运行时模块文档。

## 影响文件

- `packages/opencode/src/session/task.ts`
- `packages/opencode/src/session/runner.ts`
- `packages/opencode/test/session/task.test.ts`
- `packages/opencode/test/session/runner.test.ts`
- `docs/harness-module/protocol-runtime.md`

## 验证计划

1. ✅ `session/task.test.ts`：84 pass。
2. ✅ `session/runner.test.ts`：70 pass。
3. ✅ `packages/opencode`：`bun typecheck` 通过。
4. ✅ 4096 端口第一次真实恢复已确认 Task 从 `completed` 原位恢复为 `running/active`，新 Run 写入 workflow，子会话收到完整任务正文。
5. ✅ 代码稳定后重新执行在线路径：只创建 1 个 `routing-reviewer` 子会话 `ses_078598fdeffe23N1AQPr6A8ZcG`，父会话进入 `waiting_child`；子会话收到完整 review Task 正文并以 `terminal_reply` 返回 `REVISE (2 blocking findings, 3 minor refinements)`。
6. ✅ 在线 DB 核对：主 Task 保持 `source_type=user/status=running`，当前 Revision 为 `active`，新 Run 已追加为第 9 个 workflow Run；错误依赖重试包被拒绝且没有创建重复子会话。

## 执行记录

- ✅ 状态重激活、显式失败、恢复 Turn 收口和 delegated wait 防重复已实现。
- ✅ 单元、类型和无重载真实路径验证完成。
