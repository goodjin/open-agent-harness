# 模型到运行时协议

模型到运行时协议定义 Agent 如何把意图或结果交给 Runtime。v2 主协议有两条线：`AgentProtocolOutput` 和 `ActionResult`。

## AgentProtocolOutput

Planner / Coordinator 类 Agent 使用 native `AgentProtocolOutput` 工具提交结构化协议包。

顶层结构：

```json
{
  "version": "2",
  "title": "optional package title",
  "strategy": "sequential",
  "items": []
}
```

字段：

| 字段 | 含义 |
|---|---|
| `version` | 当前主版本固定为 `"2"`。 |
| `title` | 协议包标题，可选。 |
| `strategy` | `sequential` 或 `dag`。 |
| `items` | 一个或多个协议 item。 |

Agent 每轮应调用一次 `AgentProtocolOutput`，把本轮要做的动作、交互或终态结果交给 Runtime。

## Item 类型

| kind | 用途 |
|---|---|
| `tool` | 请求 Runtime 执行具体工具。 |
| `agent` | 请求 Runtime 委托子 Agent。 |
| `input` | 请求用户补充信息。 |
| `ask` | 兼容型用户询问 item。 |
| `confirm` | 请求用户确认计划或 assignment mutation。 |
| `wait` | 等待某个目标或依赖。 |
| `answer` | 给用户回答。 |
| `done` | 标记当前协议任务完成。 |
| `success` | 以成功结果结束。 |
| `failure` | 以失败结果结束。 |
| `error` | 以错误结果结束。 |
| `reply` | 回复但不声明满足执行依赖。 |

`depends` 表示 item 的依赖 id。`result` 表示 Runtime 应如何处理执行结果，例如 `summary`、`structured`、`full`、`on_failure`、`on_demand`、`adaptive`。

## Tool Item

```json
{
  "id": "inspect_files",
  "kind": "tool",
  "target": "rg",
  "args": {
    "pattern": "SessionResult"
  },
  "depends": [],
  "result": "summary"
}
```

`target` 必须是具体工具 id，不能依赖模型直接执行 shell。Runtime 负责校验、执行、记录和返回 observation。

## Agent Item

```json
{
  "id": "implement_worker",
  "kind": "agent",
  "target": "worker",
  "prompt": "实现已确认的任务，并用 ActionResult 返回结果。",
  "capabilities": ["code_edit"],
  "depends": [],
  "result": "summary"
}
```

Agent item 触发 delegation。Runtime 创建 child Session 和 Assignment，并监听 child terminal status。

## Confirm Item

```json
{
  "id": "confirm_plan",
  "kind": "confirm",
  "prompt": "是否确认执行该计划？",
  "plan": "完整计划正文",
  "assignment": {
    "op": "create",
    "target": "self"
  },
  "depends": []
}
```

Confirm 可以只请求用户确认，也可以携带 assignment mutation。`plan` 才是完整任务内容。

## Terminal Items

Terminal items 包括：

- `answer`
- `done`
- `success`
- `failure`
- `error`
- `reply`

它们都会结束当前协议推进，但语义不同。

`reply` 需要特别处理：它是终态回复，但通常不满足父会话依赖。Runtime 可以把它记录成 `SessionResult`，并标记为 non-satisfying。

## ActionResult

Worker / Verifier 类 delegated Session 使用 native `ActionResult` 工具提交完成结果。

Worker 示例：

```json
{
  "action_id": "assigned_action",
  "status": "success",
  "result": "Task completed.",
  "changed_files": "packages/opencode/src/session/result.ts",
  "verification": "bun typecheck passed from packages/opencode",
  "blockers": "none"
}
```

Verifier 示例：

```json
{
  "action_id": "verify_action",
  "target_action_id": "assigned_action",
  "status": "success",
  "result": "Verification passed.",
  "issues": "none",
  "evidence": "Reviewed code and ran checks.",
  "worker_feedback": "none"
}
```

Status 值：

- `success`
- `failure`
- `error`
- `reply`
- `skipped`

旧值 `pass` / `fail` 仅作为兼容输入归一化为 `success` / `failure`。

## AgentProtocolOutput 与 ActionResult 的边界

| 协议载体 | 使用者 | 目的 | 是否编排后续动作 |
|---|---|---|---|
| `AgentProtocolOutput` | planner / coordinator | 声明动作、交互、委托或终态结果 | 可以 |
| `ActionResult` | worker / verifier | 汇报被分配工作的完成结果 | 不负责继续编排 |

Worker 不应用 `AgentProtocolOutput` 重新编排父任务。Planner 不应用 `ActionResult` 代替协议包。

## 兼容格式

代码中仍兼容旧结构，例如：

- `kind: "act"`
- `calls[]`
- flat `answer` / `done` / `success` / `failure` / `error` / `reply`

v2 文档不再把这些格式作为主协议。它们只用于历史数据、旧模型输出或恢复路径。
