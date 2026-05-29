# Agent Protocol DSL：模型与 Runtime 交互协议

## 目的

Agent Protocol DSL 是 Open Agent Harness 中模型到 Runtime 的交互协议。

目标形态是一套通用 DSL：模型声明 semantic actions、dependencies、context references、result policy、persistence policy 和 recovery intent；Runtime 通过 Harness 治理机制校验并执行这些声明。

该协议可以表达短生命周期 tool orchestration、Agent task delegation、context requests、reference expansion、UI 可见结构化结果、recovery decisions 和 final reports。Durable workflow 风格执行可以后续基于该协议实现，但 workflow 不是协议边界。

目标不是用模型写出的编程语言替代 Runtime。目标是让模型用结构化方式声明意图，而 Runtime 负责解析、校验、执行、权限、调度、存储、恢复和上下文构造。

## 协议 Carrier 与恢复

协议目标是一套通用 DSL。面向模型的 carrier 可以随 Runtime 版本和 provider 能力变化。

第一版中，协议声明可以通过 Runtime 自有 toolCall entrypoint 承载，例如 `AgentProtocolOutput`。这个 toolCall 是协议边界的 carrier，不是协议边界本身。

Runtime 应将所有接受的执行请求归一化为同一种内部 Action 表示：

- Harness DSL declaration
- `AgentProtocolOutput` toolCall carrier
- 从直接 tool request 安全恢复
- 从 task/delegation request 安全恢复

只有当意图明确且策略允许执行时才允许恢复。如果 Runtime 无法确定 executor、arguments、side effects、dependencies 或 permissions，就不应执行，而应返回协议违规，或要求模型用协议格式重试。

## 核心判断

Agent Protocol DSL 是声明式的：

```txt
Model declares an action graph:
- inspect these sources
- run these actions in parallel
- use one result as input to the next action
- return only summaries unless details are needed
- persist this run only when durable recovery matters
```

Runtime 解释这个声明并执行。模型专注于目标、计划、判断和最终解释，而不是管理每个低层 tool operation。

## 为什么协议使用 Action Graph

Agent Protocol DSL 可以表达更高层的 Action Graph：

- semantic actions，而不是 raw tool invocations
- actions 之间的依赖
- 条件执行
- 有边界的循环
- result return policy
- persistence policy
- failure policy
- permission requirements
- model-visible summary policy
- runtime-visible full artifact storage

DSL 的优势不是完全没有噪声，而是 Runtime 可以把多个低层 tool operations 压缩成更少的 semantic actions，并只把有用的结果层返回给模型。

示例：

```json
{
  "id": "review_toolbar",
  "title": "Review Toolbar",
  "description": "Review toolbar button implementation and interaction boundaries.",
  "reason": "The user asked for per-button review across behavior, display, focus, undo/redo, and edge cases.",
  "operation": "review_code",
  "executor": {
    "type": "agent",
    "target": "auto",
    "capabilities": ["code_review", "frontend"]
  }
}
```

模型之后收到：

```json
{
  "id": "review_toolbar",
  "title": "Review Toolbar",
  "description": "Review toolbar button implementation and interaction boundaries.",
  "status": "completed",
  "summary": "Found two issues: undo/redo state is not wired through, and the table dropdown can be hidden by a higher layer."
}
```

这里仍然包含 `id`，但除非模型需要细节，否则不会暴露每一次 grep、read、edit、test、retry 和 raw stdout record。

## 上下文噪声策略

Provider 侧 cache 可以降低重复 prompt prefix 的成本和延迟，但不能消除语义噪声。

如果 stale traces、failed attempts、long raw outputs 和 superseded plans 仍在模型上下文中，模型依然可能关注它们。Cached tokens 处理成本可能更低，但仍然是 prompt 的一部分。噪声关乎注意力、显著性、歧义和过时信息，不只是 token 计算。

因此，Agent Protocol DSL 应将上下文构造视为 Runtime 的一等责任。

## 适用范围

该协议面向显式配置为使用它的 Agent，例如未来的 protocol runner、planner、controller 或其他 orchestration agents。

Workflow 使用自己的 durable orchestration adapter，并应通过明确 adapter boundary 连接。

普通聊天 Agent 不需要输出该 DSL。

Agent prompt 应清晰说明该 Agent 是否可以输出 Agent Protocol DSL。如果 Agent 未配置该协议，Runtime 应忽略看起来像协议的文本，或将其视为 assistant content。

## 第一版 Carrier 语法

第一版使用简化的模型侧语法。

本文后面描述的完整 Agent Protocol DSL 有意保持丰富表达力。它可以表示 Action Graph、typed executors、context references、persistence policies、result policies、recovery policies 和 UI projection metadata。第一版 carrier 让模型侧表面保持小，同时保留同一个 Runtime-owned protocol boundary。

第一版使用小型 carrier 语法：

- 模型可以调用一个协议 entrypoint：`AgentProtocolOutput`，作为稳定 carrier。
- Runtime 仍负责校验、记录日志、执行、投影 UI 状态并返回 protocol observations。
- Tool 和 Agent 执行仍表示为 protocol calls，而不是不受约束的 raw assistant text。
- 如果模型输出可恢复的直接 tool request，Runtime 可以将其标记为协议违规，并在安全时恢复为同一简化协议形态。
- 完整 Action Graph DSL 仍是规范内部目标；第一版 carrier 映射到该目标。

### 顶层形态

面向模型的输出有三种顶层 kind：

```ts
type ProtocolOutput =
  | Act
  | Answer
  | Done
```

`act` 请求 Runtime 执行一个或多个 call：

```json
{
  "kind": "act",
  "message": "I will inspect the package files first.",
  "calls": [
    {
      "id": "read_package",
      "type": "tool",
      "name": "read",
      "args": {
        "filePath": "package.json"
      },
      "result": "summary"
    }
  ]
}
```

`answer` 在不需要更多 Runtime 工作时返回用户可见 Markdown：

```json
{
  "kind": "answer",
  "message": "This project is a VS Code extension for visual HTML editing."
}
```

`done` 结束当前 turn，不执行额外工作。它仍可以包含用户可见 closing message：

```json
{
  "kind": "done",
  "message": "The requested check is complete."
}
```

### 字段

顶层字段：

- `kind`：必填。取值为 `act`、`answer` 或 `done`。
- `message`：`act` 和 `done` 可选，`answer` 实践中必填。用户可见 Markdown 或短进度说明。
- `calls`：`act` 必填；`answer` 和 `done` 省略。

Call 字段：

- `id`：必填。稳定 call id，用于 logs、graph nodes、result references 和 dependencies。
- `type`：必填。`tool` 或 `agent`。
- `name`：必填。对 `tool` 来说，是 Runtime tool catalog 中的具体 tool id。对 `agent` 来说，是具体 Agent id 或 `auto`。
- `args`：可选 object。对 `tool` 来说，必须匹配所选 tool 的 input schema。对 `agent` 来说，是 delegation input。
- `depends`：可选 string 或 string array。必须先完成的 call ids。
- `result`：可选。Result return policy。允许值：`summary`、`full`、`structured`、`on_failure`、`on_demand` 或 `adaptive`。默认 `summary`。
- `title`：可选短标签，用于 UI display。

### 批量 Calls

所有 Runtime 执行都使用 `calls`，即使只有一个 call。这样避免同一概念出现两套等价语法。

简单依赖示例：

```json
{
  "kind": "act",
  "message": "I will find project manifests, then read the package manifest.",
  "calls": [
    {
      "id": "find_manifests",
      "type": "tool",
      "name": "glob",
      "args": {
        "pattern": "*.json"
      }
    },
    {
      "id": "read_package",
      "type": "tool",
      "name": "read",
      "args": {
        "filePath": "package.json"
      },
      "depends": "find_manifests",
      "result": "summary"
    }
  ]
}
```

Agent delegation 示例：

```json
{
  "kind": "act",
  "message": "I will delegate a focused code review.",
  "calls": [
    {
      "id": "review_changes",
      "type": "agent",
      "name": "auto",
      "args": {
        "description": "Review the changed protocol schema and prompt behavior."
      },
      "result": "summary"
    }
  ]
}
```

### Runtime 归一化

Runtime 应将简化第一版语法归一化为执行、日志和 UI projection 使用的内部 Action 表示：

- `kind: "act"` 映射到 `intent: "execute"`。
- 每个 `calls[]` item 映射到一个 internal action。
- `calls[].type` 映射到内部 executor type。
- `calls[].name` 映射到内部 executor target。
- `calls[].args` 映射到内部 action input。
- `calls[].depends` 映射到内部 dependencies。
- `calls[].result` 映射到内部 result policy。
- `kind: "answer"` 映射到 response message。
- `kind: "done"` 映射到停止的 turn，可选带 visible message。

简化语法是模型侧 carrier。Runtime 将它映射到更丰富的内部协议表示，用于 execution、logging、UI projection 和 full-DSL 演进。

### Runtime 到模型：请求 Transcript

第一版输出契约是结构化的：模型通过原生 tool-call channel 提交 `AgentProtocolOutput`。

第一版输入契约不同：Runtime 不应将 provider API objects、raw `tools` declarations、`toolChoice` 或 raw `AgentProtocolOutput` arguments 原样回放为模型可见历史。这些是实现细节。下一次 request 应用模型可读 transcript 展示发生了什么。

Protocol Agent 使用模型可见 transcript 格式，它不同于 provider request JSON。Runtime 可以在内部使用 provider tool schemas，但回放给模型时应保持协议形态和可读性。

这个 transcript 是第一版 carrier surface 的规范 Runtime-to-model request 格式。它包含用户请求、先前 assistant protocol declarations、runtime observations、protocol capabilities，以及下一次模型调用的即时输出指令。

当前第一版应使用 Markdown-oriented turns：

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

规则：

- 每个历史 turn 都应像简短 transcript 一样易读，而不是 provider request JSON。
- 第一版 turn tags 不编码 provider message identity。使用 `## User request`、`## Assistant protocol request and runtime observations` 和 `## Assistant answer` 等 Markdown heading 描述发生了什么。
- Protocol runtime turn 应让每个 call 紧邻它对应的 result。避免先列出所有 calls 再列出所有 results，因为这会增加模型配对歧义。
- Call section 包含所选 tool 或 agent 以及 arguments。Result section 不应重复同一 arguments。它应包含 status、可用 artifact references 和 result content。
- `run_id` 是 Runtime execution id，用于关联 logs、UI projection、hidden context 和 artifacts。
- `Purpose` 是模型提供的简短原因或标题，用来说明这一组 calls 为什么被请求。保持展示标签中性可读即可，不需要是严格的 `operation_reason` 字段。
- `Status` 是 Runtime 计算的 run 聚合结果：`completed`、`blocked` 或 `failed`。
- turns 之后的 final instruction 不属于任何历史 turn。它是每次 request 的提醒，要求模型决定下一步并遵守输出格式。
- Model reasoning 或 private thinking 不应作为模型可见历史回放。回放用户可见 assistant text、显式 protocol requests 和 runtime observations。

### 直接请求恢复

Runtime 可以在安全时恢复直接 tool 或 delegation request：

- 模型对已知 Runtime tool 的直接请求可以转换为带一个 `calls[]` item 的 `kind: "act"`。
- 文本 invocation block 可以被标记为协议违规，并且只有当目标 tool name 和 arguments 明确时才恢复。
- 恢复得到的 calls 必须在 logs 中可见，以便衡量 protocol adherence 和 recovery rate。
- 不安全或模糊的恢复必须关闭执行路径。Runtime 应要求模型用简化协议形态重试，或暴露清晰的 protocol error。

恢复请求不定义协议。它们只是 Runtime normalization 的输入；归一化后的 actions 与显式协议声明走同样的 validation、permission、logging 和 projection 路径。

## 词汇与抽象边界

协议应让核心词汇保持足够抽象，以描述多个执行领域，同时又足够具体，可以用于 validation 和 UI display。

推荐核心概念：

- `Protocol`：模型与 Runtime 的契约和 versioned grammar。示例：`agent.protocol` version `1`、`agent.protocol.result` version `1`、`agent-protocol` fenced JSON block。
- `Declaration`：一个由模型生成的协议 block。示例：带 Action Graph 的 `execute` declaration、请求更多细节的 `expand_ref` declaration、失败 Action 后的 `revise` declaration。
- `Envelope`：declaration 的顶层 routing metadata。示例：`type`、`version`、`intent`、`persist`、`title`、`execution`、`payload`。
- `Payload`：declaration 的结构化主体。示例：`action_graph` payload、`expand_ref` payload、`decision` payload。
- `Action`：预期工作的语义单元。示例：检查相关文件、审查一个模块、运行测试命令、请求用户批准高风险变更、汇总结果。
- `Operation`：Action 试图做什么。示例：`search`、`read`、`review_code`、`run_tests`、`edit`、`summarize`、`ask_user`、`expand_reference`。
- `Executor`：可以执行 Action 的 Runtime capability class。示例：读取文件的 `tool`、审查代码的 `agent`、合并 summary 的 `runtime` operation、人工审批请求、运行 lint 和 tests 的 `pipeline`。
- `Assignment`：Runtime 将 Action 绑定到 Agent Session 时创建的执行边界。它记录谁执行该 Action、授予什么 authority、提供什么 Context Bundle、期望什么结果，以及产生哪些 artifacts 和 trace refs。
- `Handoff`：assignment 或 executor 之间的结构化转移边界。Handoff 不只是执行结果。它将前一个 assignment 的 result summary、evidence、artifact refs、risks 和 unresolved issues，与下一个 Agent Session、human 或 executor 的 next goal、constraints 和 dependencies 一起打包。
- `Target`：具体 executor name 或 `auto`。示例：`read_file`、`code-reviewer`、`ask_user`、`test_pipeline`、`auto`。
- `Capability`：用于匹配的可复用能力标签。示例：`filesystem.read`、`code_review`、`frontend`、`testing`、`approval`、`summarization`、`external.search`。
- `Resource`：Action 可能读取或写入的数据、文件、服务、artifact 或 context。示例：`repo://current`、`file:src/toolbar.ts`、`artifact:source_index`、`runtime://runs/run_123/actions/review/output`、`input:user.goal`。
- `Policy`：关于执行、失败处理、结果返回、持久化、权限和预算的约束与偏好。示例：`persist: true`、`return_to_model: "summary"`、`max_tokens: 6000`、`requires_approval: true`、`on_failure: "ask_model"`、`store_full: true`。
- `Result`：Runtime 产生的 declaration 或 Action outcome。示例：`status: "completed"`、changed file list、test report summary、review findings、artifact references、failure reason。
- `Reference`：指向 Markdown sections、先前 Action outputs、Runtime records 或 artifacts 的指针。示例：`md:review.prompt`、`action:inspect.summary`、`artifact:test_report`、`runtime://runs/run_123`、`input:user.goal`。
- `User Visible Note`：可选的人类可见进度与信任说明。示例："I will inspect the toolbar code and then return a per-button review."、"This may run tests and take a few minutes."、"I need your approval before publishing."

这些概念刻意保持抽象。协议应避免把 `workflow`、`code_review`、`toolbar`、`test` 或 `agent_task` 这类领域对象变成核心协议类别。它们可以作为示例、operation、capability 或 executor target 出现，但不应成为固定协议边界。

使用 `type` 表示对象分类，使用 `operation` 表示 Action 的语义意图。

示例：

```json
{
  "type": "action",
  "id": "review_toolbar",
  "operation": "review_code",
  "executor": {
    "type": "agent",
    "target": "auto",
    "capabilities": ["code_review", "frontend"]
  }
}
```

在这个示例中，`type: "action"` 说明对象是什么。`operation: "review_code"` 说明它试图做什么。`executor.type: "agent"` 说明由哪一类 executor 处理。

## 消息类型

协议应为不同方向定义不同格式。它们相关，但不相同。

### Runtime 到模型：Request

Runtime request 告诉模型当前处理什么任务、有哪些 protocol capabilities、先前 actions 产生了什么、期望什么输出形态。

对第一版 carrier surface，Runtime-to-model request 使用上文定义的 request transcript。该 transcript 针对模型理解优化，应像简短任务历史一样可读，而不是 provider request JSON。

Runtime 内部仍可以使用 provider tool schemas，但模型可见 request 应在一个连贯 transcript 中描述先前用户请求、assistant protocol requests、concrete calls、runtime observations、protocol capabilities 和 output rules。

### 模型到 Runtime：Declaration

模型 declaration 针对程序解析和校验优化。结构化 metadata 和 Action Graph data 使用 JSON fenced block，长文本使用 Markdown sections。

第一版中，declaration 通过 `AgentProtocolOutput` carrier 提交，使用上文描述的扁平 `{ kind, message, calls }` 形态。下面的 JSON fenced block 是 carrier 映射到的完整 DSL shape。

推荐完整 DSL shape：

````markdown
```json agent-protocol
{
  "type": "agent.protocol",
  "version": "1",
  "intent": "execute",
  "persist": false,
  "title": "Toolbar Button Review",
  "payload": {
    "type": "action_graph",
    "actions": [
      {
        "type": "action",
        "id": "inspect_code",
        "title": "Inspect Code",
        "description": "Find toolbar components, editor integration, styles, and tests.",
        "reason": "Review needs source locations before judging behavior.",
        "operation": "inspect_sources",
        "executor": {
          "type": "tool",
          "target": "auto",
          "capabilities": ["filesystem", "search"]
        },
        "prompt_ref": "md:inspect_code.prompt",
        "result_policy": {
          "return_to_model": "summary",
          "store_full": true
        }
      },
      {
        "type": "action",
        "id": "review_toolbar",
        "title": "Review Toolbar",
        "description": "Review toolbar button behavior, display layering, focus, undo/redo, and selection edge cases.",
        "reason": "This is the main user-requested review.",
        "operation": "review_code",
        "executor": {
          "type": "agent",
          "target": "auto",
          "capabilities": ["code_review", "frontend"]
        },
        "depends_on": ["inspect_code"],
        "context_refs": ["action:inspect_code.summary"],
        "prompt_ref": "md:review_toolbar.prompt",
        "result_policy": {
          "return_to_model": "structured",
          "store_full": true
        }
      }
    ]
  }
}
```

## inspect_code.prompt

Locate toolbar-related components, composables, styles, editor integration, and tests.

## review_toolbar.prompt

Review each toolbar button. Check click handlers, selection behavior, focus behavior, undo/redo state, dropdown z-index, and test coverage. Return findings with severity and evidence.
````

### Runtime Observation：执行结果

Runtime Observation 是执行结果的模型可见表示。它是下一次 Runtime-to-model request transcript 内的一个 content block，不是独立于 Runtime-to-model communication 的另一个方向。

Runtime Observation 通常应包含 semantic action ids、titles 或 descriptions、statuses、summaries 和 artifact refs。默认不应包含每个 raw tool call 或完整 output。

第一版中，Observation 作为 Markdown transcript entry 返回，每个 call 后立即跟随它的 result。结构化 records 保存在 Runtime storage 和 metadata 中，供 logs、UI 和 recovery 使用；模型可见文本则为理解而组织。

模型可见 Observation 示例：

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

Runtime 也可以为 logs、UI、trace export、recovery 或程序化再处理存储 machine-checkable JSON record。该 JSON record 不是默认模型可见 transcript：

```json
{
  "type": "agent.protocol.result",
  "version": "1",
  "run_id": "run_123",
  "status": "completed",
  "actions": [
    {
      "id": "inspect_code",
      "title": "Inspect Code",
      "description": "Find toolbar components, editor integration, styles, and tests.",
      "status": "completed",
      "summary": "Found Toolbar.vue, ToolbarButton.vue, toolbarConfig.ts, useToolbar.ts, useEditor.ts, and related tests."
    },
    {
      "id": "review_toolbar",
      "title": "Review Toolbar",
      "description": "Review toolbar button behavior, display layering, focus, undo/redo, and selection edge cases.",
      "status": "completed",
      "summary": "Found two issues: undo/redo state is not wired through, and the table dropdown can be hidden by a higher layer."
    }
  ],
  "next": "final_answer"
}
```

### 模型到用户：Final Answer

最终面向用户的 response 是普通 assistant text。它应把 Runtime Observations 综合成用户需要的答案。

除非用户要求，否则不应暴露 raw protocol details。

### 模型到用户：Visible Note

当模型输出可执行协议时，也可以输出一段简短用户可见说明，解释它将要做什么。

这段 note 不是执行的一部分。它用于用户信任、进度可见性和 UI display。

推荐规则：

- 对简单或快速的 protocol declaration，省略 visible note。
- 对 long-running、multi-agent、durable、risky 或 user-visible execution，包含 visible note。
- 保持简短。不要重复完整 DSL。
- 不包含只对 Runtime 有用的实现细节。

示例：

````markdown
```json agent-protocol
{
  "type": "agent.protocol",
  "version": "1",
  "intent": "execute",
  "persist": true,
  "title": "Toolbar Button Review",
  "payload": {
    "type": "action_graph",
    "actions": []
  }
}
```

## user.visible

I will inspect the toolbar implementation, review each button's behavior, and then return a concise issue report with evidence.
````

Runtime 可以在协议执行期间立即展示 `user.visible`。如果 UI 已经清晰渲染解析后的 Action Graph，可以省略该 section。

## Envelope 信封

Envelope 标识一个协议 declaration，并告诉 Runtime 如何路由它。

Envelope fields 位于 JSON block 顶层：

```json
{
  "type": "agent.protocol",
  "version": "1",
  "intent": "execute",
  "persist": false,
  "title": "Toolbar Button Review",
  "payload": {}
}
```

推荐 envelope fields：

- `type`：必填。必须是 `agent.protocol`。
- `version`：必填。协议版本字符串。
- `intent`：必填。示例：`execute`、`plan`、`expand_ref`、`cancel`、`revise`、`decide`。
- `persist`：可选 boolean。Runtime 是否应在执行前持久化 durable state。
- `title`：可选人类可读标题。
- `response_policy`：可选模型可见 response preferences。
- `payload`：必填。typed declaration body。

Envelope 在逻辑上与 plan/action layer 分离，但物理上可以是同一个 JSON object。放在同一个 JSON block 中会让解析和校验更简单。

## Payload 类型

第一批支持的 payload type 应保持有限：

- `action_graph`：短生命周期或 durable 的 semantic actions graph。
- `expand_ref`：请求展开已存储 runtime references。
- `decision`：模型对 blocked 或 failed run 的决策。
- `final_report_spec`：final report 的结构化指令。

避免把协议做成通用编程语言。第一版不支持任意表达式或无边界循环。

Durable workflow 行为应表示为 `action_graph` 上的 execution policy，而不是单独顶层 DSL type：

```json
{
  "type": "agent.protocol",
  "version": "1",
  "intent": "execute",
  "persist": true,
  "execution": {
    "mode": "durable",
    "strategy": "dag"
  },
  "payload": {
    "type": "action_graph",
    "actions": []
  }
}
```

这让协议保持通用，同时允许 Runtime 实现调度、持久化、恢复和展示 long-running graphs。

## Action 字段

推荐 Action 字段：

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
  "context_refs": ["action:inspect_code.summary"],
  "prompt_ref": "md:review_toolbar.prompt",
  "result_policy": {
    "return_to_model": "structured",
    "store_full": true
  }
}
```

字段说明：

- `id`：必填。稳定 semantic id。它类似低噪声的 `tool_call_id` 对齐键，但粒度是 semantic action。
- `type`：必填。必须是 `action`。
- `title`：推荐。简短展示名称。
- `description`：推荐。说明 Action 做什么。Runtime 应将它包含在模型可见结果中。
- `reason`：推荐。说明 Action 为什么存在。结果稍后返回时很有用。
- `operation`：推荐。领域层动词，例如 `search`、`review_code`、`run_tests`、`summarize`、`ask_user` 或 `edit`。
- `executor`：可选。请求的 executor class、target 和 capability hints。如果省略，由 Runtime 选择。
- `depends_on`：可选。必须先完成的 Action ids。
- `context_refs`：可选。指向 context material 的 references。
- `prompt_ref`：可选。指向长任务指令 Markdown payload 的 reference。
- `result_policy`：可选。模型可见返回策略。
- `persist`：可选。Action-level durability override。
- `failure_policy`：可选。Retry、abort、continue 或 ask-model policy。

## Markdown 引用

长文本不应作为 escaped JSON strings 嵌入，除非它很短。

使用 `md:` reference 从 JSON 指向同一模型输出中的 Markdown sections。

示例：

```json
{
  "prompt_ref": "md:review_toolbar.prompt",
  "context_refs": ["md:shared.context"]
}
```

对应 Markdown：

```markdown
## shared.context

Project context and constraints.

## review_toolbar.prompt

Detailed task instructions.
```

Reference 规则：

- `md:<section_id>` 解析到 normalized heading text 等于 `<section_id>` 的 Markdown heading。
- 使用稳定 semantic section ids，不使用数字 id。
- Runtime 在执行前解析 `md:` references。
- 执行 Agent 应接收展开后的文本，而不是未解析的 `md:` references。
- Runtime 应存储原始 DSL、已解析 Markdown sections、prompt hashes 和内部 parsed representation。

## Context 与 Prompt

`context` 与 `prompt` 承担不同角色。

- `prompt`：这个 Action 必须做什么。
- `context`：完成它所需的背景、约束、先前发现或支撑信息。
- `input`：结构化值。
- `result`：执行输出。

示例：

```json
{
  "id": "review_toolbar",
  "context_refs": ["md:shared.context", "action:inspect_code.summary"],
  "prompt_ref": "md:review_toolbar.prompt"
}
```

Runtime 应将其展开为类似这样的 node request：

```xml
<node-request run_id="run_123" action_id="review_toolbar">
  <context>
    Expanded shared context.
    Expanded inspect_code summary.
  </context>
  <task>
    Expanded review_toolbar prompt.
  </task>
</node-request>
```

## Reference 类型

推荐 reference types：

- `md:<section_id>`：当前 Markdown payload 中的 section。
- `action:<action_id>.summary`：当前 run 中先前 Action 的 summary。
- `action:<action_id>.output`：当前 run 中先前 Action 的 output。
- `input:user.goal`：原始用户目标。
- `runtime://...`：已持久化 Runtime artifact 或 record。
- `artifact:<name>`：run 产生的命名 artifact。

模型不应需要传统 tool 来读取 `md:` references。Runtime 会直接解析它们。对 `runtime://` references，Runtime 可以自动展开，也可以允许模型声明 `expand_ref` intent。

## 结果策略

Result policy 控制执行后返回给模型的内容。

`return_to_model` 推荐值：

- `none`：不返回内容，只返回 status。
- `summary`：返回简洁 summary。
- `structured`：返回结构化 result fields。
- `excerpt`：返回选定 excerpts。
- `full`：请求完整返回；Runtime 仍可限制或拒绝。
- `on_failure`：只在失败时返回 detail。
- `on_demand`：返回 ref 和 summary；只有被请求时才展开。
- `adaptive`：模型声明优先级；Runtime 在预算内选择。

示例：

```json
{
  "result_policy": {
    "return_to_model": "adaptive",
    "priority": ["errors", "matching_lines", "file_paths", "diff"],
    "max_tokens": 6000,
    "store_full": true,
    "if_truncated": "provide_ref_and_summary"
  }
}
```

模型可以声明偏好，但 Runtime 拥有最终 authority。Runtime 必须 enforcement context budget、security、permissions 和 safety。

## 完整 DSL 与上下文回放

模型在当前 request 之外没有记忆。除非 Runtime 将先前 assistant output 放入下一次 request，否则模型无法记住它。

因此，Observation replay 有三种有效模式。

Replay 不是单独的 XML 协议对象，而是 Runtime-to-model request transcript 内部的分组规则。Runtime 应把模型 declaration、declaration summary 或 reference、action ids、runtime observations、artifact refs 和 next instruction 放在一起，让模型能够判断某个 observation 属于哪个 declaration。

### 完整回放

Runtime 包含先前模型 declaration，包括 JSON 和 Markdown payload，然后追加 runtime observation。

在该模式下，observation 不需要重复完整 prompts，但仍应包含 action ids 和 summaries。

### 压缩回放

Runtime 不包含完整先前 declaration，而是包含 declaration summary 和 observation。

在该模式下，observation 必须包含足够任务描述，让模型理解每个 Action 的含义。

### 混合回放

Runtime 只在 declaration 小且较新时包含精确 declaration。对很长或过时 declaration，Runtime 用 summary 加 `runtime://` refs 替代。

这应是长期默认策略。

## Observation 分组

使用 observation group 让模型 declaration 与 runtime observation 保持逻辑连接。

这种分组帮助模型理解 observation 属于哪个 declaration。当周围对话包含多个 run 时尤其有用。

推荐 grouping fields：

- `run_id`
- declaration summary 或 declaration ref
- action ids 和 action titles
- action status
- result summary
- artifact refs
- failure 或 block reason
- next instruction

在模型可见 transcript 中，这些字段作为 Markdown headings 和简短结构化行出现在 Runtime observation turn 内。

## Streaming

模型输出可能逐 token streaming。Runtime 不应执行 partial JSON block。

第一版规则：

- 收集完整 assistant message
- 简化第一版优先使用一个完整 native `AgentProtocolOutput` call
- 在 message completion 后解析并校验 native tool arguments
- 只把完整 `agent-protocol` fenced blocks 作为 alternate carrier 恢复
- 只执行已校验 declaration

未来可以优化为在完整 assistant message 结束前解析并执行已完成 fenced block，但这是可选且风险更高的优化。

Runtime execution 也可以 streaming progress。默认不要把每个 progress chunk 都回传给模型。Progress 用于 UI 和 logs。只在决策点返回模型可见 observations：

- completed
- failed
- blocked
- permission needed
- user input needed
- model decision needed

不要把 private model reasoning 作为 runtime observation 回放。Reasoning traces 在允许时对 debugging 和 UI display 有用，但它们不是未来模型 turn 的可靠事实来源。未来 turn 应接收用户可见 assistant messages、显式 protocol declarations 和 Runtime 产生的 observations。

## XML、JSON 与 Markdown

根据方向和用途选择格式。

### XML-like 章节

适合模型可读输入和分组上下文：

- 边界清晰
- 长文本不需要 JSON string escaping
- 适合 nested context sections
- 对 LLM attention 友好

XML-like text 可以解析，但 schema 和 data typing 不如 JSON 直接。XML 也有多个等价形态：attributes、child elements、text nodes、CDATA、namespaces 和 whitespace rules。

### JSON

适合程序必须解析的模型输出：

- 直接 schema validation
- 显式 arrays 和 objects
- 清晰 primitive data types
- JSON Schema 和 Zod 等成熟工具
- 符合常见 tool/function calling training patterns

JSON 不太适合长自然语言 payload，因为长字符串需要 escaping。

### Markdown

适合长的人类/模型可读 payload：

- task instructions
- context paragraphs
- report templates
- examples

推荐约定：

- Runtime to model request：Markdown transcript sections。
- Model to runtime declaration：简化第一版使用 native `AgentProtocolOutput` tool call；未来完整 DSL 使用 JSON fenced block 加 Markdown payload。
- Runtime observation：模型可见回放使用 Markdown transcript；logs、UI、trace export、recovery 或程序化再处理使用 JSON records。
- Model to user final answer：普通 Markdown。

## 持久化

并非每个 protocol declaration 都应持久化。

对可以在当前 turn 内运行的短生命周期 Action orchestration，使用 `persist: false`。

以下情况使用 `persist: true`：

- execution 必须跨 restart 存活
- run 跨 turns 或 sessions 持续
- 涉及多个 Agent
- progress 必须展示在 UI 中
- audit 或 recovery 很重要
- 用户明确要求 workflow、plan 或 long-running execution

Durable workflow-like behavior 应视为 `persist: true` 加 execution policy，而不是单独协议族。短 tool orchestration 可以是 `persist: false`。

## Executor Registry

协议应把可执行对象视为 Runtime 注册的 executors。

Tool 和 Agent 是重要 executor types，但不是唯一可能类型。从模型角度看，以下对象都可以通过同一 Action grammar 声明：

- 调用普通 tool
- 将任务分配给 Agent
- 要求 Runtime 执行内部 control action
- 请求人工决策或审批
- 调用预定义 pipeline 或 external service

这不意味着每种 executor 内部完全相同。它表示模型可以使用同一种声明式 Action grammar，而 Runtime 选择具体执行路径。

推荐 executor types：

- `tool`：确定性或有边界的系统函数。
- `agent`：由 LLM 驱动、带 reasoning 和局部自主性的 executor。
- `runtime`：Runtime 自有控制操作，例如 wait、merge、checkpoint、summarize 或 expand references。
- `human`：用户或 human operator decision。
- `pipeline`：预定义多步确定性过程。
- `service`：外部服务或集成。

暴露给已启用 protocol agents 的推荐 registry information：

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
      "name": "code-reviewer",
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

Action 选择规则：

- 如果 `executor.target` 命名具体 executor，Runtime 可在 validation 后使用它。
- 如果 `executor.target` 是 `auto` 或省略，Runtime 根据 `executor.type`、`capabilities`、task description、availability、policy 和 cost 选择。
- `executor.type` 对 executor 分类，不应为 `auto`。
- Runtime 拥有最终 authority，可以拒绝或覆盖不安全或不可用的选择。
- 模型应描述所需 capabilities，而不是硬编码实现假设。

示例：

```json
{
  "type": "action",
  "id": "review_toolbar",
  "title": "Review Toolbar Buttons",
  "operation": "review_code",
  "executor": {
    "type": "agent",
    "target": "auto",
    "capabilities": ["code_review", "frontend", "ui_action"]
  },
  "description": "Review every toolbar button implementation and report issues.",
  "reason": "The task requires source inspection and judgment across multiple UI behaviors.",
  "prompt_ref": "md:review_toolbar.prompt"
}
```

## Summary 来源

Summary 可以来自多个层：

1. Tool-native structured summary，例如 match counts、file lists、exit codes 或 changed file paths。
2. Runtime mechanical summary，例如 status counts、artifact refs、truncation markers 和 errors。
3. Executor final output，当 Action 由 Agent、tool、human、pipeline、runtime operation 或 service 处理时。
4. 面向长 raw outputs 的专用 summarizer model 或 summary Agent。

除非策略要求更多内容，Runtime 应单独存储 full outputs，并返回 summaries 加 references。

## 引用展开

当模型需要更多细节时，可以输出 expansion declaration：

```json
{
  "type": "agent.protocol",
  "version": "1",
  "intent": "expand_ref",
  "payload": {
    "refs": [
      {
        "ref": "runtime://run_123/actions/review_toolbar/output",
        "reason": "Need exact evidence for the undo/redo finding.",
        "range": {
          "around_matches": true,
          "context_lines": 20
        }
      }
    ]
  }
}
```

Runtime 决定展开多少，并返回另一个 protocol result。

## Safety 与 Validation

Runtime 必须 enforcement：

- 只有 enabled agents 可以输出可执行 protocol declarations
- 第一版只解析 complete assistant messages
- 只识别带 `type: "agent.protocol"` 的显式 fenced blocks
- 执行前进行 schema validation
- tool 或 file operations 前进行 permission checks
- context budget limits
- durable execution 前持久化
- result policy 不能覆盖 safety 或 privacy constraints
- DSL 中没有任意 scripting language

## 用户体验契约

协议不只是模型与 Runtime 的契约，也影响用户能理解什么、信任什么、打断什么、检查什么。

Runtime 应为可执行 declaration 提供 user-facing projection：

- `title`：简短 run label。
- `user.visible`：执行前或执行中展示的可选说明。
- `actions[].title`：每个 Action 的 display label。
- `actions[].description`：每个 Action 的简洁说明。
- `status`：pending、running、completed、failed、canceled、blocked 或 waiting。
- `progress`：可选 counts 或 phase descriptions。
- `result_summary`：完成后的用户可见 outcome。
- `details_ref`：可选 reference，指向 raw protocol、logs、artifacts 或 execution details。

用户不应需要阅读 JSON 才能理解发生了什么。UI 可以暴露 raw DSL 供 inspection、debugging 和 advanced use，但常规展示应从 titles、descriptions、statuses 和 summaries 派生。

## 后续版本待补充设计

第一版应保持小，但协议需要为这些主题明确设计空间：

- `permission_policy`：哪些 actions 执行前需要用户审批。
- `budget_policy`：tokens、time、cost、retries 和 parallelism 的限制。
- `cancellation_policy`：用户取消或 Runtime abort 如何影响 running actions。
- `idempotency`：Action 是否可以安全 retry 或 resume。
- `side_effects`：Action 是否 read、write、send、delete、purchase、publish 或改变外部状态。
- `data_visibility`：结果是否对 model、user、logs、future runs 可见，或只对 Runtime 可见。
- `privacy`：哪些 artifacts 或 outputs 不能回放到模型上下文。
- `conflict_resolution`：两个 actions 要执行不兼容写入时如何处理。
- `schema_evolution`：schema 变化后，versioned declarations 如何继续解析。
- `partial_results`：graph 中途失败时 Runtime 返回什么。
- `approval_gates`：模型如何在高风险或不可逆 Action 前询问用户。
- `result_granularity`：如何选择 summaries、structured fields、excerpts 和 full artifacts。
- `ui_projection`：哪些 protocol fields 足够稳定，可供 frontend rendering。

这些应是 policies 或 projections，而不是领域特定 Action types。

实际优先级：

- 实现前必须定义：`permission_policy`、`budget_policy`、`cancellation_policy`、`side_effects`、`data_visibility`、`partial_results`、`result_granularity` 和 `ui_projection`。
- 第一版可用后应尽快定义：`idempotency`、`privacy`、`approval_gates` 和 `schema_evolution`。
- 可等真实使用暴露需求后再定义：`conflict_resolution`、advanced resume semantics 和 richer adaptive result shaping。

第一版实现不需要完全解决每个边界，但需要清晰默认值，因为不清晰的默认值会变成模型、用户和开发者都无法推理的隐藏 Runtime 行为。

## 开发就绪检查表

实现第一个 protocol Agent 前，定义最小 Runtime contract：

- Enabled agent name 和 prompt rules：哪个 Agent 可以输出 protocol，什么时候应输出普通文本，什么时候应输出 declaration。
- Parser contract：如何检测 `agent-protocol` fenced block，允许多少个 block，解析失败时如何处理。
- JSON schema：envelope fields、payload fields、action fields、executor fields、result policy 和 validation errors。
- Markdown resolver：如何 normalize、resolve、store `md:` section ids，以及缺失时如何报告。
- Executor registry shape：可用 executor types、names、descriptions、capabilities，以及各自是否可自动执行。
- Selection rules：Runtime 如何处理 `executor.target: "auto"`、missing executor、unavailable executor 或 unsafe executor。
- Execution model：sequential 与 DAG、dependency handling、status transitions，以及是否需要 persistence。
- Result contract：success、failure、partial completion、cancellation 或 blocked execution 后返回给模型什么。
- User projection：执行前、执行中、执行后 UI 展示什么。
- Safety defaults：哪些 operations 需要审批，第一版哪些 side effects 被禁止，budget limits 如何 enforcement。
- Storage model：declarations、resolved Markdown、runtime observations、artifacts 和 UI projections 存在哪里。
- Recovery minimum：第一版是否支持 restart recovery，或明确只处理 current-turn runs。

推荐第一版边界：

- 每个 assistant message 支持一个 declaration
- 仅支持 `payload.type: "action_graph"`
- 先支持 `execution.strategy: "sequential"`，再增加 `dag`
- schema 中支持 executors `tool`、`agent`、`runtime` 和 `human`，但只实现当前 Runtime 可用子集
- write、delete、publish、send、purchase 或 external side-effect actions 要求显式审批
- 默认向模型返回 summaries，并单独存储 full artifacts
- 根据 `title`、`user.visible`、Action titles、statuses 和 result summaries 展示用户可见 progress

## 最小第一版

第一版应支持：

- 每个 assistant response 一个 `agent-protocol` JSON block
- 通过 `md:` 引用 Markdown payload sections
- `action_graph` payload
- Action 字段：`type`、`id`、`title`、`description`、`reason`、`operation`、`executor`、`depends_on`、`context_refs`、`prompt_ref`、`result_policy`
- Result policies：`summary`、`structured`、`full`、`on_failure`、`on_demand`、`adaptive`
- Observation grouping
- 短且近期 declaration 的 full replay
- 长或过时 declaration 的 compressed replay
- `persist: false` ephemeral runs
- `persist: true` durable Action Graph runs
- executor registry exposure
- 用于 Action 选择的 `executor.type`、`executor.target` 和 `executor.capabilities`
- 可选 `user.visible` Markdown section，用于用户可见 progress explanation

暂缓：

- assistant message completion 前的 streaming partial execution
- arbitrary nested expressions
- unbounded loops
- user-defined scripting
- 一个 response 中多个 protocol blocks
- 非 protocol Agent 的自动执行

## 第一版实现计划

第一版为显式配置的 Agent 实现一条可用 protocol path。它保持目标抽象为 Harness DSL，同时允许 `AgentProtocolOutput` 成为稳定的模型侧 carrier。

执行路径：

```txt
assistant output
  -> AgentProtocolOutput carrier OR fenced agent-protocol JSON block
  -> optional direct request recovery when safe
  -> protocol runner validates declaration
  -> protocol executor resolves semantic actions
  -> runtime executes through tools, agents, and runtime ops
  -> protocol result is written as an assistant part
  -> logs/projectors expose run state to UI and export
```

实现区域：

- `packages/opencode/src/protocol/schema.ts`
- `packages/opencode/src/protocol/parser.ts`
- `packages/opencode/src/protocol/executor.ts`
- `packages/opencode/src/protocol/log.ts`
- `packages/opencode/src/protocol/project.ts`
- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/session/log.ts`
- `packages/opencode/src/tool/registry.ts`
- `packages/opencode/src/agent/registry.ts`
- `packages/app/src/pages/session/session-side-panel.tsx`
- `packages/app/src/pages/session/session-log-timeline.tsx`

推荐任务顺序：

1. 定义第一版 schema 和 fixtures。
2. 每个 assistant response 解析一个显式 protocol declaration。
3. 只为带 `runner: "protocol"` 或等价显式资格的 Agent 启用 protocol。
4. 为 read/search/summarize 风格 Action 构建受限 executor registry。
5. 执行 ephemeral sequential protocol runs，并返回简洁模型可见结果。
6. entry/capability routing 稳定后，将 Agent delegation 加为 protocol executor。
7. 输出 protocol logs 并导出完整 traces。
8. 在 session side panel 和 Logs timeline 中投影 protocol runs。
9. 应用 replay policy，让未来模型 turn 看到简洁 protocol observations，而不是 raw internal traces。
10. 用端到端 read-only scenario 与 direct toolCall execution 对比验证。

第一版验收：

- Protocol-enabled Agent 可以通过 carrier 或 fenced block 输出一个 protocol declaration。
- Runtime 至少可以校验、执行、记录和投影一个只读 sequential Action Graph。
- Direct tool requests 只有在明确且 policy-safe 时才能恢复。
- 模型可见 result 简洁；完整 output 位于 logs/artifacts。
- Protocol trace export 包含 declaration、result、actions、tool calls、metrics 和 failure/block reasons。
- UI 展示 protocol run status、action details、artifacts 和 trace export，并且不把 raw JSON 作为主要体验。
- 聚焦 backend/frontend checks 从 package directories 运行；如果 API shapes 改变，重新生成 SDK。

## 与 Workflow Adapter 的关系

Workflow 是 Harness durable orchestration adapter，不是协议边界。

模型-Runtime 协议与 workflow adapter 共享治理对象，但保持独立执行契约。Workflow state、recovery 和 UI projection behavior 可以影响协议设计，但不会让 workflow execution 变成隐式协议执行。

关系如下：

```txt
Workflow adapter:
  - specialized durable orchestration implementation
  - owns workflow DAG, node state, artifacts, and recovery decisions
  - exposes durable run behavior through explicit adapter boundaries

Agent Protocol DSL:
  - general model-runtime protocol target
  - supports tool actions and agent actions
  - uses action_graph plus execution policy
  - may later express workflow adapter runs through durable action_graph policy
```

如果 workflow adapter 通过 Agent Protocol DSL 表示，它应映射为带 `persist: true` 和 `execution.strategy: "dag"` 的 `action_graph`。该映射是显式 adapter contract。
