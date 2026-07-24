# Bug Fix: 上一 Run 闭包恢复与任务图同包派发

> 此文档中的“Task 准入同包派发执行图”方案已被
> `docs/bugfix/2026-07-24-two-phase-task-admission-and-graph-execution.md`
> 取代。当前规则是 create/update 只持久化 Task 或 Revision，忽略同包执行图，
> 再由 durable bootstrap 请求模型生成新图。本文其余内容仅保留为历史设计记录。

## 用户目标

修复父会话在子会话结果已经返回后，模型连续漏交上一 Run 终态结果，最终报错 `Protocol package omitted or misplaced the terminal result for the previous Run.` 的问题。同时允许协议包在首次创建 Task 时携带完整任务图，由 Runtime 先持久化 Task/Revision，再派发任务图中的子会话。

## 已确认范围

1. 正常情况下仍由父模型输出上一 Run 的 `success`、`failure`、`error` 或 `reply` 总结。
2. Runtime 保留一次模型闭包重试；重试仍漏交时，只在上一 Run 的委派结果已经全部落库、后续任务图本身合法时进行确定性闭包恢复。
3. 恢复总结必须基于规范化 `session_result`，保留未满足 action，不能把失败结果写成成功。
4. 首次 `create/self` 确认项允许与 executable actions 同包。用户确认后，Runtime 先持久化 Task、Revision 和完整 workflow，再执行 action graph。
5. `update/self` 继续使用独立修订流程：先停止旧 Revision 的作用域子会话，再激活和执行新 Revision；不得复用首次创建的同步快速路径。
6. `handoff/peer` 继续只在平级新会话中执行，新任务图不得在源会话执行。
7. 用户取消确认、Task/Revision 持久化失败、依赖校验失败时，不得创建子会话。

## 当前根因

### 上一 Run 无法闭包

- Run `apr_f87b6dfe5001GIZCB6TsvTAD6G` 的三个委派结果均已写入 `session_result`，其中 worker 结果 `satisfying=0`。
- 父模型连续两次只声明后续补救 action，没有先输出上一 Run 的终态总结。
- `runner.ts` 第二次校验失败后直接结束会话，没有利用已经持久化的规范化子结果进行安全恢复。
- Run 初始执行快照与最终 outcome 分开存储；缺少 `session_protocol_run_outcome` 时，Run 会继续显示为 `blocked`。

### Task 创建后重复请求

- 当前创建确认通过后，`confirm()` 使用 `actions: []` 创建 Task/Revision。
- 同一协议包中的准备 actions 被丢弃，并通过 `task_revision_bootstrap` 再请求模型生成正式任务图。
- 该流程增加一次模型调用，也让任务描述与实际图之间出现不必要的重建窗口。

## 实现方案

### 1. 确定性 Run 闭包恢复

1. 保留现有首次闭包校验与一次强制重试。
2. 第二次仍缺少终态结果时，先校验后续 action graph 的 schema、依赖和 Task 准入。
3. 查询上一 Run 对应的规范化 `session_result`；只有所有已派发 action 都有终态记录时才允许恢复。
4. 生成保守的 fallback summary，列出满足和未满足的 action，并标明该结果由 Runtime 从子会话结果恢复。
5. 通过 `SessionRuns.finish()` 写入 outcome 后执行合法的新任务图，同时记录专用恢复日志。
6. 子结果不完整、存在等待用户的子会话、新图不合法或 outcome 冲突时继续 fail closed。

### 2. Task 与任务图同包提交

1. 确认 action 仍作为包级 gate 排在 executable actions 之前。
2. `create/self` 确认成功后，将同包 executable actions 一并写入 Task Revision workflow，不再写入空 actions。
3. 只有 Task、Revision、assignment 和 workflow 均持久化成功后，executor 才能开始第一个非 human action。
4. 同一 run 的后续 bind 应识别刚完成的 assignment，不把它误判为禁止执行的 replay。
5. 不再为带完整图的 create 包启动重复的 `task_revision_bootstrap`；只有确认包没有 executable actions 时才保留 bootstrap。
6. `update/self` 保持现有 recovery 边界，避免新旧工作流并行；本轮不在确认回调中直接执行更新图。
7. `handoff/peer` 保持源包 action 不执行。

### 3. 提示词与协议约束

- 更新 Task admission 和 default/planner 规则：当需求和任务图已经明确时，优先在同一个确认包内提交 assignment 与完整图。
- 明确 Runtime 的执行顺序是“确认、持久化、校验、派发”。
- 删除“带 assignment 的准备包图会被忽略”的旧说明。

## 预计影响模块

- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/session/task.ts`
- `packages/opencode/src/session/task-confirmation.ts`
- `packages/opencode/src/protocol/task-admission.ts`
- default、milestone-planner、feature-planner 的源提示词及生成文件
- `packages/opencode/test/session/runner.test.ts`
- 必要的 Task/Recovery/Prompt 测试
- `docs/harness-module/protocol-runtime.md`

## 验证计划

1. 模型连续两次漏交上一 Run 结果，Runtime 从完整 `session_result` 恢复 outcome，并执行后续合法图。
2. worker 失败、verifier 完成时，fallback summary 保留失败 action，不产生成功误报。
3. 子结果未齐、等待用户或新图非法时，不闭包、不派发。
4. 模型显式提交终态总结时，始终优先使用模型结果。
5. `create/self + confirm + agent graph`：确认前无 Task/子会话；确认后 Task workflow 已包含完整图，之后才创建子会话；不触发重复 bootstrap。
6. Task 持久化失败或用户取消时，子会话数量保持为零。
7. `update/self`：确认后仍先进入修订停止与恢复流程，不走首次创建的同步派发路径。
8. `handoff/peer + graph`：源会话不执行 action，目标平级会话收到任务。
9. 从 `packages/opencode` 执行相关 Bun 测试与 `bun typecheck`。
10. 重启 4096 服务后，用受控会话验证真实协议包顺序；不自动重放 actgraph-desktop 的修改任务。

## 执行记录

- `bun typecheck`：通过。
- `bun test test/session/runner.test.ts`：71 通过，0 失败。
- `bun test test/session/task.test.ts`：84 通过，0 失败。
- `bun test test/protocol/schema.test.ts`：41 通过，0 失败。
- Task admission 的 LLM 定向测试：1 通过，0 失败。
- protocol runner 提示词定向测试：2 通过，0 失败。
- `test/session/recovery.test.ts`：18 通过，1 失败；失败项为既有的 `session_control list` 作用域用例返回空列表，本次未修改 Recovery 或 SessionControl，实现差异与该失败路径无交集。
