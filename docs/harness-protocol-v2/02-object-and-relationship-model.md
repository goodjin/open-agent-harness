# 对象与关系模型

本章定义 v2 协议中的核心对象和关系。后续章节都沿用这些定义。

## 核心对象

| 对象 | 定义 | 主要职责 |
|---|---|---|
| Project | 项目上下文和持久化边界。 | 决定 workspace、配置、存储和可见资源。 |
| Agent Definition | 可复用能力定义。 | 描述能力、入口、协议族、工具和权限边界。 |
| Agent Instance | Agent Definition 在 Session 中的一次运行身份。 | 接收上下文，输出协议包或结果。 |
| Session | 可恢复、可观察、可继续的执行容器。 | 保存消息、状态、子会话关系、交互和结果。 |
| Turn | 一次用户输入或恢复输入驱动的运行周期。 | 管理 `queued -> running -> done` 的请求生命周期。 |
| Task | 用户或上级 Agent 期望完成的目标工作。 | 表达要完成什么。 |
| Assignment | Task 在某个 Session / Agent 上的运行时归属和投影。 | 表达谁负责做、内容版本、状态和结果引用。 |
| Action | Agent 请求 Runtime 执行的语义动作。 | 表达工具调用、agent delegation、等待或交互。 |
| Interaction | 需要用户参与的协议门。 | 包括 confirm、input、reply 后继续。 |
| Result | 一个 Session 或 Action 产生的完成事实。 | 用于交接、依赖满足、审计和外部读取。 |
| Event | 状态变化和投影通知事实。 | 驱动恢复、outbox 和调试。 |

## Session 与 Turn

Session 是长生命周期容器。Turn 是一次运行周期。

一个 Session 可以有多个 Turn。比如：

- 用户首次提交任务，创建第一个 Turn。
- Session 等待用户 input，用户补充后创建继续 Turn。
- Session interrupted 后自动恢复，创建恢复 Turn。
- Parent Session 等待 Child Session，child 完成后 parent 被唤醒，创建继续 Turn。

Session 状态描述容器处于什么阶段；Turn 状态描述本次请求处理到了哪里。二者不能混写。

## Task 与 Assignment

Task 是目标，Assignment 是归属。

Task 可以来自用户请求、planner 拆解、confirm plan 或 parent delegation。Assignment 把这个目标绑定到一个 Session / Agent Instance，并保存可版本化的任务内容。

Assignment 不应承载所有任务语义。完整任务正文存放在 Assignment content revision 中；DB 行只保留索引、状态、版本、来源和结果引用。

## Action 与 Assignment

Action 是 Agent 向 Runtime 声明的动作。Assignment 是某类 action 被接受并绑定到 Session 后产生的运行时对象。

典型路径：

```txt
AgentProtocolOutput item
  -> Runtime normalizes Action
  -> Runtime validates and routes
  -> Runtime creates child Session or uses target Session
  -> Runtime creates Assignment
  -> Agent Instance works under Assignment
```

不是所有 Action 都产生 Assignment。tool action、input、wait、answer 等可能只产生执行记录、交互门或 terminal item。

## Parent 与 Child Session

Parent Session 委托 Agent 工作时，Runtime 创建 Child Session。二者的协作关系通过 Runtime 记录：

- parent session id
- child session id
- run id
- action id
- child assignment
- child result
- dependency satisfaction 状态

Child Session 不直接把消息写给 Parent Session。它通过 `ActionResult` 或 terminal `AgentProtocolOutput` 产生结果，Runtime 存成 `SessionResult` 后投递给 Parent。

## Result Delivery 与 Dependency Satisfaction

Result delivery 说明父会话收到了子会话的终态结果。Dependency satisfaction 说明这个结果足以推动父会话的某个依赖继续。

两者分开判断：

- `reply` 可以投递，但通常不满足执行依赖。
- `failure` / `error` 可以投递，但通常不满足普通成功依赖。
- fallback summary 可以投递，但是否满足依赖要由 Runtime 策略判断。
- verifier 的 `success` 或允许的 `skipped` 可以满足对应 gate。

## 关系总图

```txt
Project
  -> Session
      -> Turn
      -> Agent Instance
          -> Agent Definition
      -> Assignment
          -> Task content revision
      -> Action
          -> Tool execution
          -> Child Session
          -> Interaction
      -> SessionResult
      -> Event / Projection / Trace
```

这张图是 v2 文档的对象基础。后续章节只扩展这些对象的状态和协议，不引入另一套命名。
