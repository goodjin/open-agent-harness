# Agent Protocol DSL：模型与 Runtime 交互协议

## 协议目标

Agent Protocol DSL 是 Open Agent Harness 中模型与 Runtime 的交互协议。模型用结构化对象声明要做什么，Runtime 负责解析、校验、路由、执行、记录、投影、恢复和上下文构造。

协议表达模型意图，并把底层执行交给 Runtime。模型声明 semantic actions、`depends_on`、`criteria`、`failure`、`result`、context references、artifact expectation、handoff intent、recovery intent 和用户可见说明；Runtime 将这些声明归一化为 Harness Action Graph，并通过权限、预算、门禁、状态、Trace 和审计模型执行。

该协议覆盖以下场景：

- tool orchestration
- Agent delegation
- Runtime internal action
- human decision 或 approval
- context request 和 reference expansion
- structured observation
- artifact production 和 evidence collection
- handoff 或 downstream assignment
- user-visible progress
- final answer handoff

## 设计原则

### 1. 声明意图

模型声明目标、动作、依赖和结果偏好。Runtime 判断是否允许执行、由谁执行、如何执行、如何记录结果。

```txt
Model declares:
- read these sources
- run these calls in parallel
- use one result before another call
- return summary unless details are needed
- store full output as artifacts

Runtime decides:
- whether the declaration is valid
- which executor handles each call
- what authority applies
- what result is returned to the model
- what trace and projection are written
```

### 2. 协议结构保持扁平

模型更擅长生成少量顶层字段和短数组，不擅长稳定生成多层嵌套 JSON。嵌套越深，越容易出现字段遗漏、结构漂移、括号错误和语义重复。

因此，模型侧协议使用扁平 JSON shape：

- `kind`
- `message`
- `calls`
- 图级治理字段

Action Graph 通过 `calls[]` 表达 node，通过 `depends_on` 表达 dependency edge。Runtime 可以在内部把扁平 carrier 归一化为更丰富的 Action、dependency、policy、projection 和 trace records。

图级治理字段是可选字段，用于描述整个 Action Graph 的目标、约束和执行策略，例如 `title`、`goal`、`criteria`、`failure`、`budget`、`gate`、`loop`、`visibility`、`artifacts`、`handoff` 和 `context`。这些字段保持在顶层，不再包多层 envelope。

### 3. Tool Call 作为稳定承载方式

模型通过 Runtime 自有 toolCall entrypoint `AgentProtocolOutput` 提交协议对象。这个 toolCall 是承载方式，协议语义由 `kind`、`message` 和 `calls` 定义。

使用 toolCall 承载协议有两个目的：

- 利用模型对 tool/function calling 的稳定训练能力。
- 让 Runtime 可以在同一个入口处做 schema validation、permission check、logging、projection 和 recovery。

当模型输出直接 tool request 或 delegation request 时，Runtime 可以在安全条件下恢复为同一协议 shape，再进入相同的 validation 和 execution path。

## 协议输出

模型到 Runtime 的输出有三种顶层 `kind`：

```ts
type ProtocolOutput =
  | Act
  | Answer
  | Done
```

### Act

`act` 请求 Runtime 执行一个或多个 call。

```json
{
  "kind": "act",
  "message": "I will inspect the toolbar source and tests, then review the behavior.",
  "calls": [
    {
      "id": "inspect_sources",
      "type": "tool",
      "name": "glob",
      "title": "Inspect Sources",
      "args": {
        "pattern": "src/**/*toolbar*"
      },
      "result": "summary"
    },
    {
      "id": "read_toolbar",
      "type": "tool",
      "name": "read",
      "title": "Read Toolbar Code",
      "args": {
        "filePath": "src/toolbar.ts"
      },
      "depends_on": "inspect_sources",
      "result": "summary"
    },
    {
      "id": "read_tests",
      "type": "tool",
      "name": "read",
      "title": "Read Related Tests",
      "args": {
        "filePath": "src/toolbar.test.ts"
      },
      "depends_on": "inspect_sources",
      "result": "summary"
    },
    {
      "id": "review_toolbar",
      "type": "agent",
      "name": "auto",
      "title": "Review Toolbar",
      "args": {
        "description": "Review toolbar button implementation and interaction boundaries.",
        "capabilities": ["code_review", "frontend"]
      },
      "depends_on": ["read_toolbar", "read_tests"],
      "result": "structured"
    }
  ]
}
```

### Answer

`answer` 在不需要 Runtime 执行更多工作时返回用户可见 Markdown。

```json
{
  "kind": "answer",
  "message": "This project is a VS Code extension for visual HTML editing."
}
```

### Done

`done` 结束当前 turn，可以包含用户可见 closing message。

```json
{
  "kind": "done",
  "message": "The requested check is complete."
}
```

## 字段定义

字段名沿用总纲的统一字段。模型侧协议保持扁平，Runtime 归一化时补齐对象形态和默认值。

### 顶层字段

- `kind`：必填。取值为 `act`、`answer` 或 `done`。
- `message`：可选。用户可见 Markdown、进度说明或最终回答。`answer` 应提供 `message`。
- `calls`：`act` 必填。`answer` 和 `done` 省略。
- `title`：可选。Action Graph 的短标题，用于 Run、UI graph 和 Trace。
- `goal`：可选。Run 或 Action Graph 的目标摘要、约束和完成标准。
- `criteria`：可选 string array。整个 Action Graph 的完成标准。
- `failure`：可选 object。整个 Action Graph 的失败处理偏好，例如 retry、block、ask_user、handoff 或 abort。
- `budget`：可选 object。整个 Action Graph 的成本、时间、token、attempt、parallelism、缓存或外部资源约束。
- `gate`：可选 object。整个 Action Graph 的 approval、verification、review、privacy 或 release gate。
- `loop`：可选 object。有边界的重复执行语义。Runtime 根据 `max_attempts`、`until`、预算和状态证据控制执行边界。
- `visibility`：可选 object。Action Graph 结果进入 model、user、logs、trace、future_runs 的可见性偏好。
- `artifacts`：可选 array 或 object。整个 Action Graph 期望产生、读取或更新的 Artifact。
- `handoff`：可选 object。Action Graph 终态或下游交接目标、约束、依赖、证据、风险和未决问题。
- `context`：可选 object。整个 Action Graph 需要 Runtime 展开的 context refs、memory refs、artifact refs 或 projection refs。

### Call 字段

- `id`：必填。稳定 call id，用于 logs、graph nodes、result references 和 dependencies。
- `type`：必填。executor class，支持 `tool`、`agent`、`runtime`、`human`、`pipeline` 或 `service`。
- `name`：必填。具体 executor target。对 `tool` 来说是 tool id；对 `agent` 来说是 Agent id 或 `auto`；对 `runtime` 来说是 Runtime 内部操作名。
- `title`：可选。短标签，用于 UI display 和 transcript heading。
- `args`：可选 object。必须匹配目标 executor 的 input schema 或 delegation contract。
- `depends_on`：可选 string 或 string array。声明该 call 必须等待哪些 call 完成。
- `result`：可选。Result return policy。可以使用 string 简写，也可以使用 object。string 允许值为 `summary`、`full`、`structured`、`on_failure`、`on_demand` 或 `adaptive`，默认 `summary`。
- `criteria`：可选 string array。声明该 call 的成功标准，用于 Runtime 构造 Action / Assignment Contract。
- `failure`：可选 object。声明失败偏好，例如 retry、block、ask_user、handoff 或 abort。Runtime 根据全局 policy 和 gate 解释。
- `budget`：可选 object。声明成本、时间、token、并行度或重试预算偏好。
- `visibility`：可选 object。声明结果进入 model、user、logs、trace、future_runs 的可见性偏好。
- `artifacts`：可选 array 或 object。声明期望产生、读取或更新的 Artifact，Runtime 会归一化为 Artifact Contract。
- `handoff`：可选 object。声明下游交接目标、约束、依赖、证据、风险和未决问题。
- `context`：可选 object。声明需要 Runtime 展开的 context refs、memory refs、artifact refs 或 projection refs。
- `gate`：可选 object。声明需要满足的 approval、verification、review、privacy 或 release gate。

## Action Graph

`calls[]` 是模型侧 Action Graph 表达：

- 每个 `calls[]` item 是一个 graph node。
- `depends_on` 定义 node 之间的 dependency edge。
- Runtime 接受 `act` declaration 后会创建或更新持久化 Run 和 Action Graph record。
- 没有 `depends_on` 的 call 可以在 declaration 被接受后进入 ready 状态。
- 多个互不依赖的 ready call 可以并行调度。
- 具体调度受 Runtime policy、executor availability、budget、resource lock 和 permission 约束。
- Runtime 校验 missing node、duplicate id、cycle、不可满足依赖、无权限 executor 和不安全 side effect。

上面的 toolbar 示例会被 Runtime 投影为：

```json
{
  "graph": {
    "nodes": [
      { "id": "inspect_sources", "operation": "inspect_sources", "executor": "tool:glob" },
      { "id": "read_toolbar", "operation": "read", "executor": "tool:read" },
      { "id": "read_tests", "operation": "read", "executor": "tool:read" },
      { "id": "review_toolbar", "operation": "review_code", "executor": "agent:auto" }
    ],
    "edges": [
      { "from": "inspect_sources", "to": "read_toolbar", "type": "depends_on" },
      { "from": "inspect_sources", "to": "read_tests", "type": "depends_on" },
      { "from": "read_toolbar", "to": "review_toolbar", "type": "depends_on" },
      { "from": "read_tests", "to": "review_toolbar", "type": "depends_on" }
    ]
  }
}
```

Action Graph 的调度基础是依赖图。Retry、loop、gate、decision、handoff、pause、resume 和恢复都归属于 Action Graph / Runtime 执行能力。

Loop 必须有边界，例如 `max_attempts`、预算、时间限制、人工 Decision 或明确 `until` 条件。Retry、loop、verification、handoff 和 post-action review 可以由模型在 Action Graph 中声明，也可以由 Agent metadata 的 Orchestration Policy 或 Runtime policy 补齐。Runtime 在执行前将这些来源归一化为统一 Action、Assignment、Gate、Event 和 Projection。

## 通用 Action 语义

模型侧 `calls[]` 保持扁平，Runtime 在归一化阶段补齐更完整的治理对象。

映射关系：

| 模型侧字段 | Runtime 内部对象 | 语义 |
|---|---|---|
| `id` | Action id | 稳定引用、依赖和 Trace 关联。 |
| `type` + `name` | Executor selector | 选择 tool、Agent Session、Runtime service、human、pipeline 或 service。 |
| `args` | Action input / Contract input | 传给 executor 的结构化输入。 |
| `depends_on` | Action Graph edge | 调度、阻塞、恢复和 fan-in 的依赖边。 |
| `criteria` | Success Criteria / Contract acceptance | Runtime、Agent Session、Gate 和 UI 判断完成的依据。 |
| `failure` | Failure Policy | retry、block、ask_user、handoff、abort 等失败处理偏好。 |
| `budget` | Budget Policy | cost、timeout、tokens、attempts、parallelism 等资源约束。 |
| `visibility` | Visibility Policy | 控制结果如何进入模型上下文、用户界面、日志、Trace 和未来运行。 |
| `artifacts` | Artifact Contract | 声明输出产物、证据、索引和引用方式。 |
| `handoff` | Handoff Contract | 将结果、约束、证据、风险和未决问题交给后续 executor。 |
| `context` | Context Bundle request | 请求 Runtime 选择、展开或摘要上下文。 |
| `gate` | Gate Policy | approval、verification、review、privacy、release gate 等状态迁移条件。 |

这些字段都是意图声明。Runtime 根据权限、当前 Projection、Executor Registry、Adapter Policy 和安全策略决定最终执行形态。

示例：

```json
{
  "id": "implement_timeout",
  "type": "agent",
  "name": "auto",
  "title": "Implement Timeout Handling",
  "args": {
    "description": "Implement typed timeout error handling for the auth refresh path.",
    "capabilities": ["implementation", "testing"]
  },
  "depends_on": ["inspect_auth"],
  "criteria": [
    "Typed timeout error is returned by the auth refresh path.",
    "Focused tests cover success and timeout cases."
  ],
  "failure": {
    "on_failure": "block",
    "retry": { "max_attempts": 1 }
  },
  "budget": {
    "timeout_ms": 900000,
    "cost": "medium"
  },
  "artifacts": [
    { "name": "patch", "type": "diff" },
    { "name": "test_report", "type": "verification" }
  ],
  "handoff": {
    "target": { "type": "agent", "capability": "code_review" },
    "constraints": ["review_changed_files_only"],
    "risks": ["auth regression"],
    "unresolved": []
  },
  "result": "structured"
}
```

## Runtime 归一化

Runtime 将模型侧协议对象归一化为内部执行表示：

- `kind: "act"` 映射到 execute declaration。
- 顶层 `title`、`goal`、`criteria`、`failure`、`budget`、`gate`、`loop`、`visibility`、`artifacts`、`handoff` 和 `context` 映射到 Action Graph policy、Run Contract 和 Projection。
- `calls[]` 映射到内部 Action Graph records。
- 每个 call 映射到 internal action。
- `calls[].type` 映射到 executor type。
- `calls[].name` 映射到 executor target。
- `calls[].args` 映射到 action input。
- `calls[].depends_on` 映射到 dependency edges。
- `calls[].result` 映射到 Result Policy。
- `calls[].criteria` 映射到 Success Criteria 和 Contract acceptance。
- `calls[].failure` 映射到 Failure Policy。
- `calls[].budget` 映射到 Budget Policy。
- `calls[].visibility` 映射到 Visibility Policy。
- `calls[].artifacts` 映射到 Artifact Contract。
- `calls[].handoff` 映射到 Handoff Contract。
- `calls[].context` 映射到 Context Bundle request。
- `calls[].gate` 映射到 Gate policy。
- `kind: "answer"` 映射到 response message。
- `kind: "done"` 映射到 stopped turn。

Runtime 归一化后再执行 schema validation、permission check、持久化、routing、executor invocation、event append、projection update 和 trace recording。

## 直接请求恢复

Runtime 可以在安全时把直接 tool request、delegation request 或文本 invocation 恢复为协议对象。

恢复条件：

- target executor 明确。
- arguments 能通过 schema 校验。
- side effects 可判断。
- permission boundary 可推导。
- 依赖关系明确。
- 执行不会绕过 approval gate。

恢复后的对象等价于显式 `AgentProtocolOutput` declaration，并进入相同的 validation、permission、logging 和 projection path。Runtime 应记录 recovery event，用于观察模型协议遵循情况。

不安全或模糊的请求会关闭执行路径，并返回 protocol error 或要求模型用协议格式重试。

## Runtime 到模型：Request Transcript

Runtime-to-model request 使用模型可读 transcript。Runtime 可以在内部使用 provider messages、tool schemas 和 tool results；模型可见历史展示为简洁任务历史。

当 provider 返回 reasoning items 时，Runtime 按 provider 协议在下一次模型请求中回传这些 items，用于保持模型在 tool calling 或多步执行中的推理连续性。Reasoning items 作为 provider continuation state 传递，模型可读 transcript 仍按本节的 Markdown 结构组织。

Transcript 包含：

- user request
- assistant protocol declaration summary
- concrete calls
- runtime observations
- artifact refs
- protocol capabilities
- next instruction

示例：

````markdown
<turn index="1">
## User request

当前插件各个按钮点了都没效果，你进行一次 code review，定位问题，然后修复
</turn>

<turn index="2">
## Assistant protocol request and runtime observations

run_id: `apr_abc123`
Purpose: Inspect extension wiring
Status: completed

### Call read_extension

Tool: `read`

```shell
tool read <<'JSON'
{
  "filePath": "src/extension/extension.ts"
}
JSON
```

### Result for read_extension

Status: completed
Artifacts: artifact://call_read_extension

```md
extension.ts registers the custom editor provider and command handlers.
```
</turn>

Based on all turns above, decide the next step.
Strictly follow the Agent Protocol output requirements for this request.
````

Transcript 规则：

- 每个历史 turn 都应像简短 transcript 一样易读。
- Runtime turn 使用 Markdown headings 描述发生了什么。
- 每个 call 应紧邻对应 result，降低模型配对歧义。
- Result section 包含 status、artifact refs 和 result content，不重复完整 arguments。
- `run_id` 关联 logs、UI projection、hidden context 和 artifacts。
- Provider reasoning items 按 provider 协议随下一次模型请求回传。

## Runtime Observation

Runtime Observation 是执行结果的模型可见表示。它出现在下一次 Runtime-to-model request transcript 中。

Observation 包含：

- run id
- call ids
- titles 或 descriptions
- status
- summaries
- artifact refs
- failure 或 blocked reason
- next instruction

Runtime-to-model 内容分为两类：

- **Assignment Brief**：Runtime 分派任务时使用，说明目标、边界、验收、依赖、权限和最小上下文 refs。
- **Result Observation / Result Handoff**：Runtime 回复执行结果、汇总 child session 或交给下游 executor 时使用，说明结果含义、证据强度、风险、未决项和按需展开路径。

分派格式不应携带大量历史结果；结果格式不应伪装成新的任务指令。Runtime 在构造 Result Observation 时应加入少量语义提示，帮助模型区分事实、推断、风险、未决项和原始证据引用。

示例：

````markdown
<turn index="2">
## Assistant protocol request and runtime observations

run_id: `run_123`
Purpose: Toolbar Button Review
Status: completed

### Call inspect_code

Executor: `tool:auto`
Operation: `inspect_sources`

### Result for inspect_code

Status: completed
Artifacts: artifact://run_123/inspect_code

```md
Found Toolbar.vue, ToolbarButton.vue, toolbarConfig.ts, useToolbar.ts, useEditor.ts, and related tests.
```

### Call review_toolbar

Executor: `agent:auto`
Operation: `review_code`
Depends: `inspect_code`

### Result for review_toolbar

Status: completed
Artifacts: artifact://run_123/review_toolbar

```md
Found two issues: undo/redo state is not wired through, and the table dropdown can be hidden by a higher layer.
```
</turn>
````

Runtime 也会为 logs、UI、trace export、recovery 和程序化处理存储 machine-checkable JSON records。模型可见 transcript 面向理解和下一步生成优化。

### Result Observation 压缩规则

Runtime 默认把大内容保存在 Artifact、raw record 或 runtime ref 中，只把可推理所需的摘要和引用放入模型上下文。

默认返回：

- status、goal 和一句到三句 summary。
- evidenced facts，每条带 `Ref:` 或 artifact ref。
- artifact refs 和简短说明。
- risks、unresolved、blocked reason 和 next instruction。
- guidance：哪些内容可当作证据，哪些需要展开 ref 后再判断。

默认不返回：

- full transcript。
- full stdout/stderr。
- full file content。
- long diff。
- 重复失败尝试。
- 与当前决策无关的 child session 细节。

模型需要精确细节时，应声明 `expand_ref`、`context` 或读取类 call。Runtime 决定是否展开、展开多少、是否只返回 excerpt，以及是否需要 permission 或 budget gate。

## 词汇与抽象边界

### Declaration

模型生成的协议对象。`act` declaration 请求 Runtime 执行 calls；`answer` declaration 返回用户可见回答；`done` declaration 结束 turn。

### Action Graph

由 call nodes 和 dependency edges 组成的执行声明。模型用 `calls[]` 定义 nodes，用 `depends_on` 定义 edges。

### Call

模型侧的执行声明单元。Call 会被 Runtime 归一化为内部 Action。

### Action

Runtime 接受后的可执行语义单元。Action 记录 operation、executor、input、dependency、authority、side effect、`result` 和 trace refs。

### Operation

Action 试图完成的语义工作，回答“要做什么”。示例：`search`、`read`、`review_code`、`run_tests`、`edit`、`summarize`、`ask_user`、`expand_reference`。

### Executor

执行 Action 的能力类别和目标，回答“由谁或什么执行”。示例：`tool`、`agent`、`runtime`、`human`、`pipeline`、`service`。

Operation 和 Executor 是两个维度。相同 operation 可以由不同 executor 执行，例如 `review_code` 可以路由给 `agent:auto`、`agent:technical_reviewer` 或 review service；相同 executor 也可以支持多个 operation，例如 `tool` executor 可以执行 `search`、`read` 和 `run_tests`。

### Target

具体 executor name 或 `auto`。示例：`read_file`、`technical_reviewer`、`ask_user`、`test_pipeline`、`auto`。

### Capability

用于 routing 和 matching 的能力标签。示例：`filesystem.read`、`code_review`、`frontend`、`testing`、`approval`、`summarization`、`external.search`。

### Assignment

Runtime 将 Action 绑定到 Agent Session 时创建的执行边界。Assignment 记录谁执行、授予什么 authority、提供什么 Context Bundle、期望什么结果、产生哪些 artifacts 和 trace refs。

### Handoff

Assignment 或 executor 之间的结构化转移边界。Handoff 把前一个执行结果、证据、artifact refs、风险和未决问题，与下一个目标、约束、依赖和预算一起打包。

### Reference

指向 Markdown sections、先前 Action outputs、Runtime records 或 artifacts 的指针。示例：`md:review.prompt`、`action:inspect.summary`、`artifact:test_report`、`runtime://runs/run_123`、`input:user.goal`。

### Result

Runtime 产生的 Action outcome。示例：`status: "completed"`、changed file list、test report summary、review findings、artifact references、failure reason。

## 内部 Action 字段

Runtime 将扁平 `calls[]` 归一化为内部 Action records。内部 Action 可以拥有比模型侧 call 更丰富的字段，用于 validation、routing、UI projection 和 trace。

示例：

```json
{
  "type": "action",
  "id": "review_toolbar",
  "title": "Review Toolbar",
  "description": "Review toolbar button behavior and edge cases.",
  "reason": "The user asked for per-button review.",
  "operation": "review_code",
  "executor": {
    "type": "agent",
    "target": "auto",
    "capabilities": ["code_review", "frontend"]
  },
  "depends_on": ["inspect_code"],
  "criteria": [
    "Find correctness and regression risks in toolbar behavior.",
    "Return findings with evidence and severity."
  ],
  "failure": {
    "on_failure": "block",
    "retry": { "max_attempts": 1 }
  },
  "context_refs": ["action:inspect_code.summary"],
  "artifacts": {
    "expected": [
      { "name": "review_report", "type": "review" }
    ]
  },
  "handoff": {
    "target": { "type": "agent", "capability": "implementation" },
    "constraints": ["only rework findings with evidence"],
    "depends_on": ["artifact:review_report"],
    "evidence": ["action:inspect_code.summary"],
    "risks": ["UI regression"],
    "unresolved": []
  },
  "budget": {
    "timeout_ms": 600000,
    "cost": "medium"
  },
  "gate": {
    "verification": ["evidence_present"]
  },
  "result": {
    "return_to_model": "structured",
    "store_full": true
  }
}
```

内部 Action 字段由 Runtime 生成或补全，不要求模型逐项输出。

## Reference 与 Context

模型可以通过 references 表示需要的上下文材料。Runtime 负责解析 references，并在 executor invocation 或后续模型 request 中构造合适的 Context Bundle。

Reference types：

- `md:<section_id>`：当前 Markdown content 中的 section。
- `action:<action_id>.summary`：当前 run 中先前 Action 的 summary。
- `action:<action_id>.output`：当前 run 中先前 Action 的 output。
- `input:user.goal`：原始用户目标。
- `runtime://...`：已持久化 Runtime artifact 或 record。
- `artifact:<name>`：run 产生的命名 artifact。

Runtime 直接解析 `md:` references。对 `runtime://` references，Runtime 可以自动展开，也可以允许模型声明 `expand_ref` action。

引用展开示例：

```json
{
  "kind": "act",
  "message": "I need the exact evidence for the undo/redo finding.",
  "calls": [
    {
      "id": "expand_review_evidence",
      "type": "runtime",
      "name": "expand_ref",
      "args": {
        "ref": "runtime://run_123/actions/review_toolbar/output",
        "range": {
          "around_matches": true,
          "context_lines": 20
        },
        "reason": "Need exact evidence for the undo/redo finding."
      },
      "result": "excerpt"
    }
  ]
}
```

## Result Policy

`result` 控制执行后返回给模型的内容。

允许值：

- `summary`：返回简洁 summary。
- `structured`：返回结构化 result fields。
- `full`：请求完整返回；Runtime 可根据预算、安全和权限限制。
- `on_failure`：只在失败时返回 detail。
- `on_demand`：返回 ref 和 summary，细节按需展开。
- `adaptive`：模型声明偏好，Runtime 在预算内选择。

Runtime 拥有最终 authority。Result policy 受 safety、privacy、permission 和 context budget 约束。

建议默认：

- 分派给 Agent Session 的 call 使用 `result: "structured"` 或 `result: "summary"`，让 Runtime 生成 Result Observation。
- 文件、日志、测试和长输出类 call 使用 `result: "on_demand"` 或 `result: "adaptive"`，避免把完整内容塞回上下文。
- 只有短输出、失败排查或用户明确要求原文时才请求 `full`。

## Executor Registry

协议把可执行对象视为 Runtime 注册的 executors。

Executor types：

- `tool`：确定性或有边界的系统函数。
- `agent`：由 LLM 驱动、带 reasoning 和局部自主性的 executor。
- `runtime`：Runtime 自有控制操作，例如 wait、merge、checkpoint、summarize 或 expand references。
- `human`：用户或 human operator decision。
- `pipeline`：预定义多步确定性过程。
- `service`：外部服务或集成。

暴露给 protocol-enabled Agent 的 registry information：

```json
{
  "executors": [
    {
      "name": "read_file",
      "type": "tool",
      "description": "Read a file from the current workspace.",
      "capabilities": ["filesystem", "read"]
    },
    {
      "name": "technical_reviewer",
      "type": "agent",
      "description": "Reviews code changes and reports correctness, regression, and test risks.",
      "capabilities": ["code_review", "testing", "risk_analysis"],
      "can_execute": true
    },
    {
      "name": "ask_user",
      "type": "human",
      "description": "Request clarification, approval, or a decision from the user.",
      "capabilities": ["clarification", "approval"]
    }
  ]
}
```

Runtime routing 根据 call type、name、args、capabilities、task description、availability、authority、resource scope、side effect 和 cost 选择具体 executor。

## Streaming

模型输出可能逐 token streaming。Runtime 只执行完整、已校验的 declaration。

规则：

- 收集完整 assistant message。
- 使用完整 `AgentProtocolOutput` toolCall arguments。
- 在 message completion 后解析并校验 arguments。
- 对文本形式的直接请求，只在目标、参数和权限边界明确时恢复。
- 执行已校验 declaration。

Runtime execution 可以 streaming progress。Progress 默认服务 UI 和 logs。模型可见 observation 只在决策点返回：

- completed
- failed
- blocked
- permission needed
- user input needed
- model decision needed

## XML、JSON 与 Markdown

根据方向和用途选择格式。

### Runtime 到模型

Runtime-to-model request 使用 Markdown transcript。Markdown 适合组织用户请求、执行摘要、observation、artifact refs 和下一步指令。

XML-like tags 可以作为 transcript 分组边界，例如 `<turn>`。它们用于帮助模型理解结构，语义归属于 Runtime-to-model transcript。

### 模型到 Runtime

模型到 Runtime 使用 `AgentProtocolOutput` toolCall 和扁平 JSON shape。JSON 适合 schema validation、arrays、objects、primitive data types 和 tool/function calling training patterns。

### Runtime 记录

Runtime logs、UI projection、trace export、recovery 和程序化处理可以使用 machine-checkable JSON records。它们属于 Runtime 记录层，模型侧输出协议仍使用 `AgentProtocolOutput`。

### 模型到用户

最终回答使用普通 Markdown。

## 持久化

Runtime 接受 `kind: "act"` declaration 后，都会创建或更新持久化 Run 和 Action Graph。

短任务可以很快完成，但仍然通过同一套 Run、Action Graph、Action、Assignment、Event、Projection、Trace、Artifact Index、Manifest 和 Snapshot 记录执行过程。系统重启后，Runtime 根据这些记录判断哪些 Action 已完成、哪些仍在运行、哪些需要恢复、哪些应转为 `blocked`、`waiting_user` 或 `waiting_permission`。

## Safety 与 Validation

Runtime 执行前校验：

- enabled Agent 才能输出可执行 protocol declaration。
- declaration 必须来自 `AgentProtocolOutput` 或可安全恢复的直接请求。
- `kind`、`message` 和 `calls` 符合 schema。
- call ids 唯一。
- dependency graph 无缺失、无环、可满足。
- executor target 可用。
- tool、file、network、service 或 external side effect 有权限。
- approval gate 被满足。
- `result` 不覆盖 safety、privacy 或 context budget。
- criteria、failure、budget、artifacts、handoff 和 gate 可以被 Runtime 解释和执行。
- Handoff 不绕过目标 executor 的 authority、budget、visibility 和 gate。

## 用户体验契约

Runtime 应为协议执行提供 user-facing projection：

- run title 或 purpose
- `message`
- call title
- call status
- progress
- result summary
- artifact refs
- blocker 或 failure reason
- trace export

UI 的常规展示从 message、titles、statuses 和 summaries 派生。Raw protocol record 可用于 inspection、debugging 和 advanced use。

## 协议边界

协议保持以下边界：

- 模型声明 intent；Runtime 拥有 execution authority。
- 模型声明 result preference；Runtime 决定实际返回粒度。
- 模型声明 dependencies；Runtime 决定 scheduling 和 concurrency。
- 模型可以请求 executor；Runtime 做最终 routing。
- 模型可请求 reference expansion；Runtime 决定展开范围。
- Harness 状态变更通过 Runtime 接受的 Action、Event 和 Projection 发生。

## 与 Workflow 的关系

Agent Protocol DSL 支持模型用 `calls[]` 和 `depends_on` 声明 DAG，并用 criteria、failure、budget、artifacts、handoff、gate 和 visibility 表达通用治理语义。

Workflow 是用户创建、保存或命名后的 Action Graph Profile。任务执行时模型生成的 `calls[]` 进入持久化 Action Graph；用户把这份图保存为 Workflow，或用户主动创建 Workflow 后，它成为可管理、可复用的 Workflow 资产。

Workflow Profile 可以使用更适合 UI 和用户编辑的 `nodes[]`、输入 schema、版本和可见性字段。Runtime 接受 Workflow Profile 后，会 materialize 出新的 Action Graph，并使用与模型 `act` declaration 相同的 Action、Assignment、Event、Projection、Trace、Artifact、Gate 和恢复模型执行。
