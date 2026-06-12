# Action 与 Executor 契约

## 目的

本文定义 Harness 中的可执行单元。

任何可能改变执行状态的模型请求、tool call、委托 Agent 任务、Runtime 操作、人工审批、pipeline 或 service invocation，在执行前都要归一化为 `Action`。Runtime 可以接受不同的模型侧 carrier，但内部执行路径保持一致。

Action 属于持久化 Action Graph。Runtime 接受执行声明后，先创建或更新 Run、Action Graph、Action records 和 dependency edges，再根据 policy、gate 和 executor availability 调度执行。

## 核心规则

协议边界是 Action。Tool call 是可能的 carrier 之一。

```txt
model intent -> persisted Action Graph -> normalized Action -> policy checks -> executor invocation -> result -> event/projection
```

可接受的 carrier：

- 原生 Harness DSL declaration
- `AgentProtocolOutput` 或等价的 Runtime 自有 toolCall carrier
- 从直接 tool request 安全恢复
- 从 task/delegation request 安全恢复

恢复得到的 Action 要标记 `origin.kind: "recovered"`，让日志和评测能够区分显式协议输出与恢复后的协议输入。

## Action 形态

Action 字段沿用总纲的统一字段。Runtime 内部可以把模型侧简写展开为对象，但字段名保持一致。

内部 Action 字段：

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
  "criteria": [
    "package.json is read from the current workspace.",
    "The result records package name, scripts and relevant dependencies."
  ],
  "failure": {
    "on_failure": "block",
    "retry": {
      "max_attempts": 1
    }
  },
  "permission": {
    "mode": "inherit"
  },
  "budget": {
    "timeout_ms": 120000
  },
  "result": {
    "return_to_model": "summary",
    "store_full": true
  },
  "artifacts": {
    "expected": [
      {
        "name": "package_manifest_summary",
        "type": "structured_summary",
        "visibility": "model"
      }
    ]
  },
  "handoff": {
    "target": {
      "type": "agent",
      "capability": "dependency_review"
    },
    "constraints": ["use_manifest_summary"],
    "depends_on": ["artifact://action/read_package/output"],
    "evidence": [],
    "budget": {
      "cost": "low",
      "timeout_ms": 300000
    },
    "risks": [],
    "unresolved": []
  },
  "visibility": {
    "model": "summary",
    "user": "summary",
    "logs": "full",
    "trace": "summary",
    "future_runs": "ref"
  },
  "idempotency": "safe_retry",
  "cancellation": "best_effort"
}
```

稳定字段：

- `id`
- `type`
- `operation`
- `executor.type`
- `executor.target`
- `args`
- `side_effects`
- `depends_on`
- `criteria`
- `failure`
- `budget`
- `result`
- `artifacts`
- `handoff`
- `visibility`
- `permission`
- `origin`

## Contract 语义

Action Graph Contract 描述一次 Run 或流程图的整体目标、输入、约束、依赖、预算、gate、loop、failure、Artifact 和完成标准。Action Contract 描述 Runtime 接受单个 Action 后需要维护的执行边界。

Graph-level policy、Action-level policy、Runtime policy 和 Agent metadata / Orchestration Policy 都可以提供执行策略。Runtime 在接受和调度前合并这些策略，并把最终结果记录到 Action、Assignment、Event、Projection 和 Trace。

核心字段：

| 字段                | 含义                                                                     |
| ------------------- | ------------------------------------------------------------------------ |
| `goal` / `criteria` | Action 要达成的目标和完成判定条件。                                      |
| `constraints`       | scope、兼容性、风格、权限、时间、成本和安全约束。                        |
| `depends_on`        | 必须先满足的 Action、Artifact、Decision 或 Projection 条件。             |
| `input` / `args`    | executor 可见的结构化输入。                                              |
| `artifacts`         | 期望产生、读取、更新或引用的 Artifact。                                  |
| `evidence`          | 验收和审计需要保留的证据。                                               |
| `budget`            | cost、timeout、tokens、attempts、parallelism 等资源边界。                |
| `failure`           | failed、blocked、retry、ask_user、handoff、abort 等处理语义。            |
| `handoff`           | 后续 executor 接力时需要携带的目标、约束、证据、风险和未决问题。         |
| `visibility`        | 结果进入 model、user、logs、trace 和 future runs 的规则。                |
| `loop`              | 有边界的重复执行语义，必须有 attempt、预算、时间、条件或 Decision 边界。 |

Action Contract 是 Runtime、Executor、UI 和后续 Agent Session 共同读取的治理对象。模型可以声明其中一部分，Runtime 根据上下文补齐可执行边界。

## 依赖归一化与 Verifier 处理

Action Graph 在执行前要经过一次依赖归一化。归一化的对象是 `depends_on` 字段，目的是保留模型显式声明的 action 级执行顺序，并让系统主动补出的 verifier 挂到对应 worker 之后。

归一化分两层：

1. **Schema 层**：解析模型输出时移除 `depends_on` 中字符串字面量 `"none"`。`"none"` 是历史兼容哨兵；schema 在校验前过滤掉它，让 Runtime 看到真实的空依赖。`AgentProtocol.NONE_DEPENDENCY` 暴露这个常量。
2. **Runtime 层**：按 Action Graph 走依赖校验和系统校验补齐。判断规则：
   - `depends_on` 非空：保持原样，模型已经显式声明 action 级执行顺序。
   - `depends_on` 中的每个 id 必须指向当前包内 action，或已经完成的历史 child-session action id。
   - 执行器按 `depends_on` 做 DAG 调度；当前包内依赖只有在前置 action 达到终态后才算满足。
   - Agent delegation 只表示 child session 已创建，不表示 action 已完成。委托 action 在 child session 结果返回前投影为 blocked/waiting；依赖它的 verifier、tool 或其他 agent action 不会启动。
   - 目标 Agent `kind` 为 `verifier` 时，Runtime 不要求 `depends_on` 指向 worker action，也不按 agent 类型判断依赖是否合法。
   - Runtime 不用 verifier agent 名称和 worker agent 名称做会话级匹配；多个 action 可以使用同一个 agent target。
   - 当系统发现 worker 缺少所需校验者时，由系统创建 verifier action，按 agent 模板能力和 `<worker-agent>-verifier` 命名约定选择默认 verifier，并把新 action 的 `depends_on` 指向被校验 worker action id。

如果 verifier 的 `depends_on` 命中已完成的历史 child-session action id，Runtime 会把对应 prompt 和 summary/output 附加到 verifier prompt。没有命中历史 handoff 时，verifier 仍按自身 prompt 和当前协议上下文执行。schema 层的 `"none"` 过滤后表示空依赖，不会触发 verifier worker 依赖校验。

`confirm` 是包级人机边界。只要 Action Graph 内存在 `confirm`，Runtime 会先执行 confirmation gate，不检查 confirm 自身的 `depends_on`，也不要求其他 action 依赖 confirm。用户确认前，后续 `agent` / `tool` action 不应启动；用户确认后，Runtime 从同一个持久化 package 继续执行剩余 action。确认提交必须携带明确 `response: "confirm" | "cancel"`，执行器不得把空答案或本地化文案猜测为用户意图。

## Artifact 语义

Artifact 是 Action 或 Executor 产生的可引用产物。Runtime 使用 Artifact ref 把大型输出、证据和中间结果从模型上下文中分离出来。

Artifact record 字段：

```json
{
  "id": "artifact_read_package_output",
  "type": "structured_summary",
  "name": "package_manifest_summary",
  "producer": "action:read_package",
  "scope": "run",
  "uri": "artifact://action/read_package/output",
  "summary": "package.json scripts and dependencies summary.",
  "status": "available",
  "visibility": {
    "model": "summary",
    "user": "summary",
    "logs": "full",
    "trace": "summary",
    "future_runs": "ref"
  },
  "evidence": ["event:action.output_stored"]
}
```

Artifact Contract 定义期望产物，Artifact record 记录实际产物。Runtime 在 Action result、Event、Projection 和 Trace 中引用同一个 Artifact id。

## Gate 与 Budget 语义

Gate 是状态迁移或执行前的强制检查。常见 Gate 包括 schema、authority、scope、dependency、approval、verification、review、privacy、release 和 budget。

Budget Policy 约束资源使用：

- `timeout_ms`：执行时间上限。
- `cost`：成本等级或预算分类。
- `tokens`：模型输入、输出和 reasoning token 预算。
- `max_attempts`：重试次数。
- `parallelism`：可同时运行的 executor 数。
- `cache`：缓存读取、写入和复用策略。

Runtime 在执行前校验 Gate，在执行中更新消耗，在状态投影中暴露剩余预算和阻塞原因。

## Executor 类型

Runtime 支持的 executor class：

| Type       | 含义                                                      | 执行语义                                                                          |
| ---------- | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `tool`     | 有边界的 tool 或 MCP tool                                 | 按 tool schema 执行，受 resource、side effect、permission 和 `result` 约束。      |
| `agent`    | 委托 LLM session                                          | Runtime 创建 Assignment 和 Agent Session，并记录 child-session trace。            |
| `runtime`  | Harness 自有操作，例如 summarize、checkpoint、merge、wait | Runtime service 在同一状态事务模型中执行。                                        |
| `human`    | 用户/Owner 澄清、审批或决策                               | Runtime 创建 pending decision，并由 UI/API 收集结果。                             |
| `pipeline` | 预定义确定性多步过程                                      | Pipeline 被视为一个 executor，内部步骤写入 trace。                                |
| `service`  | 外部集成                                                  | Service invocation 受 network、secret、approval、budget 和 artifact policy 约束。 |

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

Manifest 字段：

```json
{
  "id": "manifest_read_package",
  "action_id": "read_package",
  "sandbox": {
    "mode": "workspace_read"
  },
  "workspace": {
    "cwd": ".",
    "read": ["package.json"],
    "write": []
  },
  "tools": ["read_file"],
  "network": "disabled",
  "secrets": [],
  "artifacts": {
    "output": "artifact://action/read_package/output"
  },
  "snapshots": [],
  "timeout_ms": 120000
}
```

## ToolCall 恢复

当模型输出直接 tool request 时，Runtime 只有在以下条件成立时才可以将其恢复为 Action：

- 该 tool 能映射到唯一 executor target
- 参数能通过对应 executor schema 校验
- side effects 可以分类
- permission policy 已知
- `result` 可以安全默认
- 执行不会绕过已禁用的 Agent/tool policy

不安全的恢复应关闭执行路径。

如果模型调用的 tool 因 permission policy、active tool allowlist 或当前 Agent authority 被过滤掉，Runtime 不应把该调用修复成 `invalid` tool。应直接返回权限阻止错误，说明被请求的 tool、当前 Agent、`inherit_permissions` 是否为 true，以及命中的权限规则或请求级禁用原因。

示例：

- `read_file({ path: "package.json" })` 可以恢复为 `operation: "read"`。
- `bash({ command: "rm -rf dist" })` 需要显式 side effect 分类和审批。
- `task({ description: "fix it" })` 过于模糊，除非 target agent、scope 和 expected result 都能安全推导。

## 生命周期

Action 生命周期事件：

```txt
action.graph_persisted
action.accepted
action.graph_ready
action.blocked
action.started
action.executor_selected
action.permission_requested
action.permission_resolved
action.retry_scheduled
action.loop_attempt_started
action.loop_attempt_completed
action.output_stored
action.completed
action.partially_completed
action.failed
action.cancelled
```

每个终态 Action result 应包含：

- `status`
- `summary`
- `artifact_refs`
- `logs_ref`
- 失败或阻塞时的 `error`
- `criteria` 的满足情况
- `failure` 的处理结果
- `handoff` 或 pending decision
- 回放给模型内容的 `visibility` 摘要

## 协议能力边界

Action / Executor 契约覆盖以下能力：

- 模型声明和 toolCall carrier 归一化为 Action。
- Action Graph dependency、criteria、failure、budget 和 result。
- Tool、Agent Session、Runtime service、human、pipeline 和 service executor。
- Sandbox、Workspace、Manifest、Snapshot 和 Rehydration。
- Artifact、Trace、Projection 和 Event 的统一引用。
- Handoff 和 downstream Assignment。
- Runtime 对 side effect、permission、privacy、approval 和 budget 的 gate enforcement。
- Action Graph 持久化、pause / resume、retry、bounded loop、Decision 和系统重启后的恢复。
