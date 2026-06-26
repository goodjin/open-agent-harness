# 多 Agent 协作总览

Harness Protocol v2 描述的是一个多 Agent 协作系统。它不把协议理解成一组模型输出字段，而是先定义协作中的对象、关系和状态，再定义模型如何请求运行时执行动作，以及运行时如何把结果、异常和交互投影回系统。

## 协作目标

Harness 要解决的问题是：多个 Agent 在同一个项目上下文中协作完成复杂任务，同时保持执行可控、状态可恢复、结果可追溯、用户可介入。

这个目标拆成五件事：

- Agent 有清楚的能力、权限和协议族。
- Session 承载一次 Agent 运行，并能被恢复、观察和继续。
- Task 通过 Assignment 落到具体 Agent / Session 上。
- Parent Session 和 Child Session 通过 Runtime 协作，不直接通信。
- Result、Event 和 Projection 给人、Runtime 和后续 Agent 提供共同事实。

## 核心链路

标准执行链路如下：

```txt
User request
  -> Runtime creates or resumes a Session
  -> Agent instance receives context
  -> Agent returns AgentProtocolOutput or ActionResult
  -> Runtime validates protocol output
  -> Runtime executes tool / creates child Session / asks user / stores result
  -> Runtime updates SessionStatus, Assignment, SessionResult and projections
  -> Parent Session continues when dependencies are satisfied
```

这条链路里，Agent 只声明意图或提交结果。状态变更、子会话创建、Assignment 归属、结果投递和恢复都由 Runtime 完成。

## 分层

| 层 | 责任 | 主要对象 |
|---|---|---|
| Agent Layer | 判断、计划、执行、审查、解释 | Agent Definition、Agent Instance |
| Session Layer | 承载一次运行，保存上下文、状态和结果 | Session、Turn、Part |
| Task Layer | 表达目标和任务归属 | Task、Assignment |
| Runtime Layer | 校验、路由、执行、恢复、投影 | Action、Interaction、Event、Projection |
| Result Layer | 保存跨 Session 交接结果 | SessionResult、ActionResult、AgentProtocolOutput terminal item |

## 协作边界

Agent Session 之间不直接通信。Parent Session 委托 Child Session 时，Runtime 创建子 Session、写入 Assignment、记录 delegation trace，并在子 Session 结束后通过 `SessionResult` 把结果投递回 Parent Session。

Result delivery 和 dependency satisfaction 是两个判断。一个子 Session 到达终态并产生结果，只说明父会话可以看到这个结果；它是否满足某个 action 的依赖，还要看 result 的 `satisfying`、状态、目标 action 和 verifier gate。

## v2 文档主线

v2 按以下顺序展开：

1. 定义 Agent。
2. 定义协议对象。
3. 定义对象之间的关系。
4. 定义 Assignment 和 delegation。
5. 定义 Session 状态和生命周期。
6. 定义用户交互门。
7. 定义模型到运行时协议。
8. 定义异常恢复。
9. 定义观测和投影。

后续章节中的字段、状态和表结构都服务于这条协作主线。
