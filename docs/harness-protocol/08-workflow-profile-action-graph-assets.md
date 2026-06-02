# Workflow Profile 与 Action Graph 资产协议

## 定位

Harness 使用统一的 Action Graph 表达和执行流程。所有被 Runtime 接受的执行流程都会持久化为 Run、Action Graph、Action、Assignment、Event、Projection、Trace 和 Artifact Index，并支持系统重启后的恢复。

Workflow 是用户创建、保存或命名后的 Action Graph Profile。平时任务执行时由模型生成的图称为 Action Graph；当用户把这个图保存为 Workflow，或用户主动创建 Workflow，它成为 Workflow 资产。

Workflow 和任务执行生成的 Action Graph 使用同一套执行能力：

- 持久化 run state
- dependency DAG
- parallel scheduling
- pause / resume / abort
- retry / failure policy
- gate / approval / decision
- bounded loop
- Agent delegation
- human decision
- Artifact、Trace 和 Projection
- recovery / rehydration
- UI graph projection

差异体现在资产层：

| 类型 | 含义 |
|---|---|
| Action Graph | Runtime 当前接受和执行的流程图。 |
| Workflow Profile | 可保存、可命名、可复用、可由用户创建的 Action Graph Profile。 |
| Workflow Run | 从 Workflow Profile 启动的一次 Run，执行语义仍是 Action Graph。 |

## Action Graph 持久化

每个 `kind: "act"` declaration 被 Runtime 接受后，都会创建或更新持久化 Run，并写入 Action Graph record。

Runtime 持久化以下对象：

- Run record
- Action Graph record
- Action records
- dependency edges
- Assignment records
- Artifact Index
- Event Log
- Projection
- Trace
- Decision records
- Snapshot / Manifest refs

短任务可以很快完成，但它仍然是可审计、可回放、可恢复的持久化 Run。系统重启后，Runtime 根据 Event、Projection、Materialized State、Artifact Index、Snapshot 和 Manifest 判断哪些 Action 已完成、哪些仍在运行、哪些需要恢复、哪些应转为 blocked 或 waiting 状态。

## Action Graph 能力

Action Graph 是执行流程的统一语义对象。

顶层能力：

| 能力 | 说明 |
|---|---|
| `goal` / `criteria` | Run 或 graph 的目标和完成标准。 |
| `inputs` | 用户输入、参数、Artifact refs 或环境 refs。 |
| `variables` | Runtime 在执行中维护的结构化变量。 |
| `calls[]` / `nodes[]` | 可调度 Action 节点。模型侧通常使用 `calls[]`。 |
| `depends_on` | 节点依赖边。 |
| `failure` | 失败处理策略，例如 retry、block、ask_user、handoff、abort。 |
| `gate` | approval、verification、review、privacy、release 等状态迁移条件。 |
| `loop` | 有边界的重复执行语义。 |
| `budget` | cost、timeout、attempt、parallelism、token 和资源预算。 |
| `visibility` | 输出进入 model、user、logs、trace、future_runs 或 runtime_only 的规则。 |
| `artifacts` | 期望产生、读取、更新或引用的 Artifact。 |
| `handoff` | 跨 executor 或 Agent Session 的结构化交接。 |

这些能力可以来自三个来源：

- 模型在 Action Graph 中显式声明。
- Runtime 根据系统策略和当前 Projection 补齐。
- Agent metadata / Orchestration Policy 为特定 Agent Session 提供默认策略。

例如 retry、loop、verification、handoff 和 post-action review 可以由 Action Graph 字段表达，也可以由 Agent 模板上的 orchestration policy 触发。Runtime 在接受和执行前将这些来源合并为统一的 Action、Assignment 和 Gate。

## Profile 形态

模型侧保持扁平 `calls[]`。Workflow Profile 可以使用更适合 UI 和用户编辑的字段，但语义仍映射到 Action Graph。

示例：

```json
{
  "id": "wf_auth_timeout",
  "title": "Fix auth timeout handling",
  "goal": {
    "summary": "Implement typed timeout error handling for auth refresh.",
    "constraints": ["keep_public_api", "touch_auth_module_only"],
    "criteria": [
      "Typed timeout error is returned by the refresh path.",
      "Focused tests cover success and timeout cases."
    ]
  },
  "budget": {
    "cost": "medium",
    "timeout_ms": 1800000,
    "max_parallel": 2
  },
  "failure": {
    "on_node_failed": "ask_decision",
    "retry": { "max_attempts": 2 }
  },
  "nodes": [
    {
      "id": "inspect",
      "type": "agent",
      "name": "explore",
      "title": "Inspect auth refresh flow",
      "args": {
        "prompt": "Find the auth refresh timeout path and relevant tests."
      },
      "criteria": [
        "Relevant source files and tests are identified.",
        "The current timeout behavior is summarized with evidence."
      ],
      "artifacts": [
        { "name": "auth_research", "type": "research_note" }
      ]
    },
    {
      "id": "implement",
      "type": "agent",
      "name": "backend",
      "title": "Implement timeout handling",
      "args": {
        "prompt": "Apply the code change using the inspect result."
      },
      "depends_on": ["inspect"],
      "mutates": true,
      "criteria": [
        "Code implements typed timeout error behavior.",
        "Changed files are listed in the result."
      ],
      "artifacts": [
        { "name": "patch", "type": "diff" }
      ]
    },
    {
      "id": "verify",
      "type": "agent",
      "name": "verifier",
      "title": "Verify timeout handling",
      "args": {
        "prompt": "Run focused tests and typecheck for the changed behavior."
      },
      "depends_on": ["implement"],
      "criteria": [
        "Focused tests pass.",
        "Relevant package typecheck passes."
      ],
      "gate": {
        "required": true
      },
      "artifacts": [
        { "name": "test_report", "type": "verification" }
      ]
    },
    {
      "id": "review",
      "type": "agent",
      "name": "technical-reviewer",
      "title": "Review implementation",
      "args": {
        "prompt": "Review the patch for correctness, regressions and test coverage."
      },
      "depends_on": ["verify"],
      "criteria": [
        "Findings include severity and evidence.",
        "Review decision is approve, request_rework or needs_info."
      ],
      "artifacts": [
        { "name": "review_report", "type": "review" }
      ]
    }
  ]
}
```

Runtime 可以把 `nodes[]` 归一化为模型侧等价的 `calls[]`，再进入统一 Action Graph 执行路径。

## Workflow 资产

Workflow 资产记录一个可复用 Action Graph Profile 及其治理信息。

Workflow asset 字段：

| 字段 | 含义 |
|---|---|
| `id` | Workflow 稳定 id。 |
| `title` | 用户可读标题。 |
| `description` | 简要说明。 |
| `profile` | Action Graph Profile。 |
| `inputs_schema` | 用户启动时需要填写的输入。 |
| `owner` | 创建者或治理 owner。 |
| `version` | Profile 版本。 |
| `source` | `user_created`、`saved_from_run`、`imported` 或 `generated`。 |
| `visibility` | 谁可以看到、运行、编辑或复用。 |
| `created_at` / `updated_at` | 时间戳。 |

Workflow 的创建方式：

- 用户从 UI 创建 Workflow。
- 用户把一次 Action Graph 保存为 Workflow。
- Agent 生成 Action Graph 后，用户确认保存为 Workflow。
- 外部系统导入 Workflow Profile。

保存为 Workflow 不改变执行语义。它只让这份 Action Graph Profile 获得名称、版本、输入 schema、权限和 UI 管理入口。

## Loop 与 Retry

Action Graph 使用有边界策略表达重复执行。

Loop 示例：

```json
{
  "id": "stabilize",
  "type": "loop",
  "title": "Stabilize implementation",
  "depends_on": ["implement"],
  "loop": {
    "max_attempts": 3,
    "until": [
      { "type": "variable", "name": "stabilize.test", "equals": "passed" }
    ],
    "steps": [
      {
        "id": "test",
        "type": "agent",
        "name": "verifier",
        "args": {
          "prompt": "Run focused verification. Return `passed` or failure details."
        },
        "outputs": { "stabilize.test": "$result.status" }
      },
      {
        "id": "fix",
        "type": "agent",
        "name": "debugger",
        "mutates": true,
        "args": {
          "prompt": "Fix the reported failure and summarize changed files."
        },
        "context": {
          "include": ["steps.test.output", "attempts.previous.fix", "artifacts.patch"]
        }
      }
    ]
  }
}
```

Runtime 语义：

- `max_attempts` 是硬边界。
- `until` 根据 Run variables、Action output 或 Artifact summary 判断。
- 每个 loop step 归一化为 Action。
- loop attempt、child output、Artifact、failure 和 Decision 都写入 Trace。
- loop 可以由 Action Graph 显式声明，也可以由 Agent metadata 的 orchestration policy 触发。

Retry 示例：

```json
{
  "id": "run_tests",
  "type": "agent",
  "name": "verifier",
  "failure": {
    "retry": {
      "max_attempts": 2,
      "when": ["transient_failure", "tool_timeout"]
    },
    "on_exhausted": "block"
  }
}
```

## Gate、Decision 与 Handoff

Gate、Decision 和 Handoff 也是 Action Graph 能力。

常见模式：

```txt
implement -> verify -> review -> gate -> summarize
```

含义：

- `verify` 产生可引用验证证据。
- `review` 评估正确性、回归风险和测试覆盖。
- `gate` 聚合 verification、approval、budget、privacy 或 release 条件。
- `decision` 处理 blocked、retry、skip、abort、request_input 或 replan。
- `handoff` 将结果、证据、Artifact、风险和未决问题交给后续 executor。

Gate 可以由 deterministic tool、Runtime service、Agent Session 或 human executor 完成。

## Workflow Command

Workflow 相关 UI/API 操作通过 Command 进入 Runtime。

Command 类型：

- `workflow.create`：创建 Workflow asset。
- `workflow.save_from_run`：将某次 Run 的 Action Graph Profile 保存为 Workflow asset。
- `workflow.update`：更新 Workflow asset 的 profile、输入 schema、标题、说明或可见性。
- `workflow.run`：从 Workflow asset 创建新的 Run，并 materialize 出新的 Action Graph。
- `workflow.archive`：归档 Workflow asset。
- `workflow.delete`：删除或软删除 Workflow asset，按权限和审计策略执行。

这些 Command 都写入 Event、Projection 和 Trace。`workflow.run` 产生的新 Run 与任务执行生成的 Action Graph Run 使用同一套状态机。

## 执行语义

Runtime 执行 Action Graph 时遵循以下语义：

1. 接受模型 declaration、UI Command 或 Workflow Profile。
2. 创建或更新持久化 Run。
3. 写入 Action Graph record、Action records 和 dependency edges。
4. 校验 duplicate id、missing dependency、cycle、authority、budget、gate、Artifact Contract 和 side effect。
5. 计算 ready Actions，并按 policy 调度。
6. 需要 Agent 执行时创建 Assignment 和 Agent Session。
7. Executor 结果写入 Action result、Artifact、Event 和 Trace。
8. Runtime 根据 result、criteria、gate、failure 和 orchestration policy 更新状态。
9. 阻塞、审批、失败和 replan 进入 Decision 或 Handoff 流程。
10. 所有 required Actions 和 gates 满足后，Run 进入 `completed`。

并行度由 Runtime 依据 ready Actions、resource lock、budget、provider/model limit、workspace safety 和 UI policy 决定。

## Recovery 与 Rehydration

Action Graph 恢复使用统一状态模型：

- Event Log 确定 Runtime 接受过的事实。
- Projection 判断 Run 当前状态和可调度 Action。
- Materialized State 提供 Run、Action、Assignment、Decision、Workflow asset 和 Artifact 当前状态。
- Snapshot 记录 workspace、artifact index 或 executor checkpoint。
- Manifest 重建 executor 可见环境。
- Trace 解释恢复前后的证据链。

恢复流程：

1. 加载 Run record、Action Graph、Action records、Assignment records 和 Artifact Index。
2. 从 Event sequence 重建 Projection。
3. 检查 running Assignment 对应的 Agent Session 或 executor invocation。
4. 将可恢复 executor 通过 Manifest 和 Snapshot rehydrate。
5. 将缺少 owner 的 running Action 投影为 `blocked`，并创建 Decision request。
6. 重新计算 ready Actions。
7. 继续调度或等待用户、权限、Decision。

## UI 与 Agent 可读产物

Action Graph Projection、Workflow asset、Trace、Artifact summary 和 Action records 面向人类和 Agent Session 可读。

UI 展示：

- Run title、goal、status 和 progress
- Action Graph 和依赖关系
- running / blocked / failed Actions
- pending Decision 和 approval
- Artifact Index
- child Agent Session trace
- budget 和 gate 状态
- recovery / replay / export 入口
- Workflow asset 列表、版本、输入 schema 和运行历史

Agent Session 接收：

- Action / Assignment task
- Contract
- upstream Artifact refs
- criteria
- failure
- budget
- visibility
- current Projection summary
- relevant Trace summary

Runtime 通过结构化 refs 连接 UI、Trace、Artifact 和 Agent Context，避免系统产物只适合人读。
