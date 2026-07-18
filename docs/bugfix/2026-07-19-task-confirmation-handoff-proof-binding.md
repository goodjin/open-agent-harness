# Bug Fix: Handoff confirmation proof binding

## 问题描述

- 日期：2026-07-19
- 严重程度：High
- 影响范围：Task handoff 确认重放、失败后重试、恢复扫描与相关 server 测试

completed confirmation proof 目前未把 `handoff_id` 和 handoff 的 `context_refs` 纳入不可变身份。相同 session、proposal、message、title 与 body 下，请求可能通过另一条 handoff path 重放既有 proof。server 重试测试还依赖状态轮询，无法确定后台 continuation 已在 teardown 前结束。

## 根因分析

- `SessionTaskConfirmation.claim()` 的既有 proof 校验未比较 `TaskConfirmationTable.handoff_id`。
- confirmation snapshot 只保存通用 proposal 字段，缺少 handoff ID 与规范化的 context refs。
- `SessionTaskHandoff.launch()` 使用 fire-and-forget loop；测试没有持有该 promise，mock 恢复和 fixture 销毁可能早于后台 continuation。

## 修复方案

1. handoff 请求构造 snapshot 时加入 handoff ID 与 context refs；update 继续使用 `handoff_id = null`。
2. claim、completed replay、legacy import 与 recovery 统一校验 durable `handoff_id` 和 snapshot hash。
3. 增加 route/domain 回归测试：跨 path 重放、context refs 漂移均返回 409且不创建 peer；原 path retry 保持幂等。
4. server retry 测试使用受控 loop promise，并在 teardown 前显式等待后台 continuation 排空。

## 影响模块

- `packages/opencode/src/session/task-confirmation.ts`
- `packages/opencode/test/server/session-task.test.ts`
- `docs/harness-module/protocol-runtime.md`

## 验证计划

1. 先运行新增定向测试并确认失败原因命中 proof 绑定缺口。
2. 实现最小修复后复跑新增测试。
3. server session-task 测试至少连续运行三轮。
4. 运行 handoff/recovery、opencode typecheck、SDK 一致性检查。
5. 运行 app 定向测试、typecheck 与 smoke。
6. 执行 `git diff --check` 并确认提交范围不包含 `.superpowers/`。

## 验证结果

- 新增测试先复现跨 handoff path 返回 200，以及 durable snapshot 被篡改后仍可重放；修复后均返回冲突。
- `test/server/session-task.test.ts` 连续三轮均为 17 pass、0 fail，未出现后台未处理异常。
- handoff 19 pass、recovery 19 pass。
- opencode typecheck 与 SDK 一致性检查通过。
- app 提案定向测试 33 pass、typecheck、真实 smoke 通过。
