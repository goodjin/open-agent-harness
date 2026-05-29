# Action 与 Executor 契约

## 目的

本文定义 Harness 中的可执行单元。

任何可能改变执行状态的模型请求、tool call、委托 Agent 任务、Runtime 操作、人工审批、pipeline 或 service invocation，在执行前都要归一化为 `Action`。Runtime 可以接受不同的模型侧 carrier，但内部执行路径保持一致。

## 核心规则

Tool call 不是协议边界。它只是可能的 carrier 之一。

协议边界是：

```txt
model intent -> normalized Action -> policy checks -> executor invocation -> result -> event/projection
```

可接受的 carrier：

- 原生 Harness DSL declaration
- `AgentProtocolOutput` 或等价的 Runtime 自有 toolCall carrier
- 从直接 tool request 安全恢复
- 从 task/delegation request 安全恢复

恢复得到的 Action 要标记 `origin.kind: "recovered"`，让日志和评测能够区分显式协议输出与恢复后的协议输入。

## Action 形态

推荐的内部 Action 字段：

```json
{
  "id": "read_package",
  "type": "action",
  "operation": "read",
  "title": "Read package manifest",
  "description": "Read package.json from the current project.",
  "origin": {
    "kind": "protocol_tool_call",
    "message_id": "msg_123",
    "source_id": "call_123"
  },
  "executor": {
    "type": "tool",
    "target": "read_file",
    "capabilities": ["filesystem.read"]
  },
  "args": {
    "path": "package.json"
  },
  "resources": {
    "read": ["file:package.json"],
    "write": []
  },
  "side_effects": ["read"],
  "depends_on": [],
  "permission_policy": {
    "mode": "inherit"
  },
  "budget_policy": {
    "timeout_ms": 120000
  },
  "result_policy": {
    "return_to_model": "summary",
    "store_full": true
  },
  "data_visibility": {
    "model": "summary",
    "user": "summary",
    "logs": "full",
    "future_runs": "ref"
  },
  "idempotency": "safe_retry",
  "cancellation": "best_effort"
}
```

第一版必填字段：

- `id`
- `type`
- `operation`
- `executor.type`
- `executor.target`
- `args`
- `side_effects`
- `result_policy`
- `origin`

## Executor 类型

Runtime 支持的 executor class：

| Type | 含义 | 第一版立场 |
|---|---|---|
| `tool` | 有边界的 tool 或 MCP tool | 先支持只读 Action。 |
| `agent` | 委托 LLM session | routing 和 child-session trace 稳定后支持。 |
| `runtime` | Harness 自有操作，例如 summarize、checkpoint、merge、wait | 支持安全操作。 |
| `human` | 用户/Owner 澄清、审批或决策 | 可在 schema 中表达；执行依赖 UI/API 支持。 |
| `pipeline` | 预定义确定性多步过程 | 后续支持。 |
| `service` | 外部集成 | 后续支持，并受审批 gate 控制。 |

## 执行环境契约

Executor 执行绑定到 Runtime 创建的环境。环境契约定义 executor 在哪里运行、能看到什么状态、能改变什么状态，以及 Runtime 如何在失败或重启后恢复它。

核心环境对象：

- **Sandbox**：executor 的隔离执行边界，覆盖进程、文件系统、网络、secret、外部服务和副作用。
- **Workspace**：executor 可见的工作区域，例如项目目录、worktree、run-scoped 目录、临时目录或挂载的 artifact set。
- **Manifest**：Runtime 提供的环境声明，包含 cwd、读写范围、可用工具、env refs、secret refs、网络策略、artifact 输出策略、snapshot refs 和 timeout。
- **Snapshot**：某个时间点的 workspace、materialized state、artifact index 或 executor state 检查点，用于对比、审计、rollback 判断和恢复。
- **Rehydration**：Runtime 根据 Manifest、Snapshot、Event、Projection 和 Artifact refs 重建 executor 环境或 Agent Session context 的过程。

执行行为：

- Runtime 根据 Action resources、Assignment authority、run policy 和 gate result 创建环境。
- Executor 只接收 Manifest 声明的环境能力。
- Executor 输出被存储为 result summary、logs、artifact refs 和 trace entries。
- Runtime 在 Event 和 Trace 中记录 environment refs，让执行可以被审计和恢复。
- Rehydration 会在继续 suspended、failed 或 long-running Action 前重建环境。

## ToolCall 恢复

当模型输出直接 tool request 时，Runtime 只有在以下条件成立时才可以将其恢复为 Action：

- 该 tool 能映射到唯一 executor target
- 参数能通过对应 executor schema 校验
- side effects 可以分类
- permission policy 已知
- result policy 可以安全默认
- 执行不会绕过已禁用的 Agent/tool policy

不安全的恢复应关闭执行路径。

示例：

- `read_file({ path: "package.json" })` 可以恢复为 `operation: "read"`。
- `bash({ command: "rm -rf dist" })` 不能自动运行；它需要显式 side effect 分类和审批。
- `task({ description: "fix it" })` 过于模糊，除非 target agent、scope 和 expected result 都能安全推导。

## 生命周期

Action 生命周期事件：

```txt
action.accepted
action.blocked
action.started
action.executor_selected
action.permission_requested
action.permission_resolved
action.output_stored
action.completed
action.failed
action.cancelled
```

每个终态 Action result 应包含：

- `status`
- `summary`
- `artifacts`
- `logs_ref`
- 失败或阻塞时的 `error`
- 回放给模型内容的 `visibility` 摘要

## 第一版边界

第一版应支持：

- 面向 search/read/summarize 类 Action 的 `tool` executor
- 面向安全聚合和协议记账的 `runtime` executor
- 默认阻塞 side effect
- 向模型返回简洁可见结果，同时单独存储完整 logs/artifacts
- 只恢复低风险只读 tool call
