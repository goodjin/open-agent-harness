# Harness Protocol v2

v2 是一套新的协议文档。它以多 Agent 协作为主线，从 Agent 定义开始，先建立对象模型和关系模型，再说明 Assignment、Session、交互、模型运行时协议、异常恢复和观测投影。

旧版文档仍保留在 `../harness-protocol/`。旧版可作为历史参考，v2 以当前实现为准重新组织概念边界。

## 阅读顺序

| 编号 | 文档 | 责任 |
|---|---|---|
| 00 | `00-multi-agent-collaboration-overview.md` | 多 Agent 协作总览、协议分层和执行主链路。 |
| 01 | `01-agent-definition.md` | Agent 定义、角色、权限、协议族和运行实例。 |
| 02 | `02-object-and-relationship-model.md` | Project、Agent、Session、Turn、Task、Assignment、Action、Result、Event 的对象和关系。 |
| 03 | `03-assignment-and-delegation.md` | Assignment、delegation、父子 Session、依赖满足和 result fan-in。 |
| 04 | `04-session-state-and-lifecycle.md` | Session 状态、Turn 生命周期、恢复、终态和 UI 状态投影。 |
| 05 | `05-interaction-protocol.md` | confirm、input、reply、用户继续输入和 pending interaction 恢复。 |
| 06 | `06-model-runtime-protocol.md` | `AgentProtocolOutput` v2、`ActionResult`、兼容格式和协议边界。 |
| 07 | `07-error-recovery-protocol.md` | 输出错误、执行失败、子任务失败、交互拒绝、中断恢复和 fallback result。 |
| 08 | `08-observability-and-projection.md` | `session_result`、状态投影、outbox、timeline、日志和调试视图。 |

## v2 文档原则

- 先讲协作模型，再讲字段。
- 先定义对象，再定义对象之间的关系。
- 先讲稳定语义，再讲 DB、文件、UI 等实现投影。
- 区分模型可见协议、运行时内部协议、持久化事实和 UI 展示。
- 区分 Session 状态、Turn 状态、Assignment 状态、交互门和依赖满足状态。
- `AgentProtocolOutput` 和 `ActionResult` 是两类结果载体，不能混用。
- 历史 `kind: "act"` / `calls[]` 只作为兼容格式说明，不作为 v2 主入口。

## 当前实现来源

v2 文档以以下实现入口为主要事实来源：

- `packages/opencode/src/protocol/schema.ts`
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/action-result.ts`
- `packages/opencode/src/session/assignment.ts`
- `packages/opencode/src/session/status.ts`
- `packages/opencode/src/session/result.ts`
- `packages/opencode/src/session/delegation.ts`
- `packages/opencode/src/session/session.sql.ts`
- `packages/opencode/src/session/turn.ts`
- `packages/opencode/src/project/bootstrap.ts`
- `packages/opencode/src/server/routes/question.ts`
