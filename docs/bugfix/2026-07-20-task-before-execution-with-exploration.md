# Bug Fix: Require Task before execution while allowing exploration

## 问题描述

- 日期：2026-07-20
- 严重程度：High
- 影响范围：无 Task 会话的首次 Agent Protocol 执行

当前 Runtime 会在首次 executable action 前通过 legacy fallback 自动创建 Task。这样虽然保证了执行时存在 Task，却允许模型绕过“先生成并确认 Task，再执行”的产品流程。

同时，模型在生成 Task 前需要读取代码、搜索文件或查询外部资料，以便形成准确的任务定义。不能把所有工具调用都视为正式任务执行。

## 目标行为

1. 无 Task 时允许白名单内的只读探索工具运行，不创建 Task，也不把探索 Run 迁移成 legacy Task。
2. 探索白名单为：`read`、`glob`、`grep`、`webfetch`、`websearch`、`lsp`、`todoread`、`agent_query`。
3. `bash` 不属于探索工具，因为 Runtime 无法可靠判断命令是否有副作用。
4. 无 Task 时，agent delegation、写工具、持久化工具和其他非白名单工具必须由已确认的 `assignment={"op":"create","target":"self"}` 建立 Task 后执行。
5. 缺少 Task assignment 的正式协议包在执行前拒绝，并触发一次协议修复提示；任何正式 action 都不得启动。
6. 历史 Run 的 legacy migration 保留，但新的实时执行路径不再用 legacy fallback 代替 Task admission。
7. delegated 子会话继续由父 assignment 自动绑定已确认 Task，不重复确认。

## 实现计划

1. 在 Runner 中集中定义无 Task 探索 action 分类。
2. 扩展 package validation：无 Task 的正式 action 缺少 create assignment 时返回 admission issue。
3. 探索 package 执行但不持久化为正式 protocol Run，不触发 Task bind；结果仍通过当前消息提供给下一次模型调用。
4. 首次正式 action 的 `bind()` 强制要求 assignment，移除该路径的 implicit legacy Task 创建。
5. 更新 Task Admission 提示，写明探索白名单与 `bash` 边界。
6. 增加 Runner 回归测试：探索成功且无 Task、探索后创建 Task、正式 action 无 assignment 被拒绝、agent delegation 无 Task 被拒绝、确认后正常执行。
7. 更新 `docs/harness-module/protocol-runtime.md`。

## 验证计划

1. ✅ 完整 Runner 测试：68 pass。
2. ✅ Protocol schema 测试：41 pass。
3. ✅ `bun typecheck`。
4. ✅ 重新生成 builtin agent manifest。
5. ✅ 检查 git diff，现有 `.superpowers/` 未纳入变更。

补充：存量 Task 并发测试 `lets only a confirmed create win a multi-run migration race` 单独运行仍失败；本次没有修改 `task.ts` 或该测试，其断言依赖两个并发 Promise 的固定完成顺序，与本次 admission 路径无直接关系。
