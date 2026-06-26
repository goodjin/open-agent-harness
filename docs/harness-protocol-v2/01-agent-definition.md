# Agent 定义

Agent 是 Harness 中可被 Runtime 调度的能力单元。v2 文档区分 Agent Definition 和 Agent Instance：前者是静态能力定义，后者是绑定到 Session 的一次运行。

## Agent Definition

Agent Definition 描述一个 Agent 能做什么、怎么被调用、使用什么协议、拥有怎样的权限边界。

建议模型如下：

| 字段 | 含义 |
|---|---|
| `id` | Agent 的稳定标识。 |
| `name` | 人类可读名称。 |
| `kind` | Agent 类型，例如 planner、coordinator、worker、verifier、reviewer。 |
| `entry` | Agent 入口，通常是 prompt、instruction 或 runtime profile。 |
| `capabilities` | Agent 适合完成的能力标签。 |
| `tools` | Agent 可见或可请求的工具集合。 |
| `protocol` | Agent 使用的协议族。 |
| `authority` | Runtime 授予它在某类任务中的动作边界。 |
| `model` | 默认模型或模型选择策略。 |
| `concurrency` | 并发、限流或路由约束。 |

Definition 不直接执行任务。Runtime 基于 Definition 创建 Agent Instance。

## Agent Instance

Agent Instance 是某个 Agent Definition 在某个 Session 中的一次运行身份。它绑定：

- `session_id`
- active Assignment
- 当前上下文
- 可用工具
- 协议族
- 状态投影
- 结果归属

同一个 Agent Definition 可以创建多个 Agent Instance。它们可能并发运行，也可能分别服务于不同 parent session、不同 assignment 或不同 project。

## Agent Role

Role 是调度语义，不等同于协议载体。

| Role | 典型职责 | 常用协议载体 |
|---|---|---|
| planner | 拆解任务、创建计划、请求确认、委托子任务 | `AgentProtocolOutput` |
| coordinator | 编排子任务、等待依赖、汇总结果 | `AgentProtocolOutput` |
| worker | 执行一个被委托的任务 | `ActionResult` |
| verifier | 审查或验证 worker 的结果 | `ActionResult` |
| reviewer | 给出评审意见，可作为 verifier 或普通 child session | `ActionResult` 或 `AgentProtocolOutput` |

Role 可以影响 Runtime 如何构造上下文、提供工具、解释结果和处理依赖，但 Role 不直接授权状态变更。

## Protocol Family

当前实现中有两类主要协议载体：

- `AgentProtocolOutput`：模型可见的结构化输出协议，供 planner / coordinator 声明 action、agent delegation、input、confirm、terminal item。
- `ActionResult`：delegated worker / verifier 的完成协议，供子 Session 返回机器可判定结果。

两者都可能产生 `SessionResult`，但使用场景不同：

- Planner / Coordinator 用 `AgentProtocolOutput` 继续编排。
- Worker / Verifier 用 `ActionResult` 完成被分配的工作。
- Runtime 把不同 carrier 归一化为 `SessionResult`，再决定是否满足父会话依赖。

## Authority

Authority 是 Runtime 在具体任务和上下文中授予 Agent Instance 的动作边界。它不只来自 Agent Definition，还受 Assignment、Session、project policy、用户确认和当前状态影响。

常见 authority：

- 是否可以创建 tool action。
- 是否可以创建 child agent action。
- 是否可以请求 `confirm`。
- 是否可以创建或更新 Assignment。
- 是否可以提交 terminal result。
- 是否可以满足父会话依赖。

Agent 可以声明意图，但 Runtime 决定是否接受和执行。

## Agent 与 Session 的关系

Agent Definition 是模板，Session 是运行容器，Agent Instance 是二者的绑定。

```txt
Agent Definition
  -> Runtime selects definition
  -> Runtime creates Session
  -> Session hosts Agent Instance
  -> Assignment gives work boundary
  -> Result closes or advances collaboration
```

因此，协议文档讨论 Agent 时需要说明是哪一层：

- 静态能力：Agent Definition。
- 运行身份：Agent Instance。
- 执行容器：Session。
- 工作归属：Assignment。
- 完成事实：SessionResult。
