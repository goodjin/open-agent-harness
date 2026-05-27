# Agent Protocol DSL

## Purpose

Agent Protocol DSL is the model-to-runtime protocol for Open Agent Harness.

The target shape is a general DSL: the model declares semantic actions, dependencies, context references, result policy, persistence policy, and recovery intent; the runtime validates and executes those declarations through Harness governance.

The protocol can express short-lived tool orchestration, agent task delegation, context requests, reference expansion, UI-visible structured results, recovery decisions, and final reports. Durable workflow-style execution can be implemented on top of the protocol later, but workflow is not the protocol boundary.

The goal is not to replace the runtime with a model-written programming language. The goal is to let the model declare intent in a structured way while the runtime owns parsing, validation, execution, permissions, scheduling, storage, recovery, and context shaping.

## Protocol Carriers And Recovery

The protocol target is a general DSL. The model-facing carrier can vary by runtime version and provider capability.

For v1, a protocol declaration may be carried through a runtime-owned toolCall entrypoint, such as `AgentProtocolOutput`. That toolCall is a carrier for the protocol boundary, not the protocol boundary itself.

Runtime should normalize all accepted execution requests into the same internal action representation:

- Harness DSL declaration
- `AgentProtocolOutput` toolCall carrier
- safe recovery from direct tool requests
- safe recovery from task/delegation requests

Recovery is allowed only when intent is unambiguous and policy permits execution. If the runtime cannot determine executor, arguments, side effects, dependencies, or permissions, it should not execute. It should return a protocol violation or ask the model to retry in protocol format.

## Core Thesis

Agent Protocol DSL is declarative:

```txt
Model declares an action graph:
- inspect these sources
- run these actions in parallel
- use one result as input to the next action
- return only summaries unless details are needed
- persist this run only when durable recovery matters
```

The runtime interprets this declaration and executes it. The model stays focused on goals, plans, judgment, and final explanation instead of managing every low-level tool operation.

## Why The Protocol Uses Action Graphs

Agent Protocol DSL can represent a higher-level action graph:

- semantic actions rather than raw tool invocations
- dependencies between actions
- conditional execution
- bounded loops
- result return policy
- persistence policy
- failure policy
- permission requirements
- model-visible summary policy
- runtime-visible full artifact storage

The advantage is not that DSL has zero noise. The advantage is that runtime can compress many low-level tool operations into fewer semantic actions and return only the useful result layer to the model.

Example:

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

The model later receives:

```json
{
  "id": "review_toolbar",
  "title": "Review Toolbar",
  "description": "Review toolbar button implementation and interaction boundaries.",
  "status": "completed",
  "summary": "Found two issues: undo/redo state is not wired through, and the table dropdown can be hidden by a higher layer."
}
```

This still contains an `id`, but it avoids exposing every grep, read, edit, test, retry, and raw stdout record unless the model needs details.

## Context Noise Policy

Provider-side cache can reduce cost and latency for repeated prompt prefixes, but it does not remove semantic noise.

If stale traces, failed attempts, long raw outputs, and superseded plans are present in the model context, the model can still attend to them. Cached tokens may be cheaper to process, but they are still part of the prompt. Noise is about attention, salience, ambiguity, and stale information, not only token computation.

Agent Protocol DSL should therefore treat context shaping as a first-class runtime responsibility.

## Scope

This protocol is intended for agents that are explicitly configured to use it, such as a future protocol runner, planner, controller, or other orchestration agents.

Workflow uses its own durable orchestration adapter and should be connected through explicit adapter boundaries.

Ordinary chat agents do not need to emit this DSL.

The agent prompt should clearly say whether the agent may emit Agent Protocol DSL. If the agent is not configured for this protocol, the runtime should ignore protocol-looking text or treat it as assistant content.

## V1 Carrier Syntax

V1 uses a simplified model-facing syntax.

The full Agent Protocol DSL described later in this document is intentionally rich. It can represent action graphs, typed executors, context references, persistence policies, result policies, recovery policies, and UI projection metadata. The v1 carrier keeps the model-facing surface small while preserving the same Runtime-owned protocol boundary.

V1 uses a small carrier syntax:

- The model may call one protocol entrypoint, `AgentProtocolOutput`, as a stable carrier.
- Runtime still validates, logs, executes, projects UI state, and returns protocol observations.
- Tool and agent execution are still represented as protocol calls, not raw unconstrained assistant text.
- If the model emits a recoverable direct tool request, runtime may mark it as a protocol violation and recover it into the same simplified protocol shape when safe.
- The full action-graph DSL remains the canonical internal target; the v1 carrier maps into it.

### Top-Level Shape

The model-facing output has three top-level kinds:

```ts
type ProtocolOutput =
  | Act
  | Answer
  | Done
```

`act` asks runtime to execute one or more calls:

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

`answer` returns user-visible Markdown when no more runtime work is needed:

```json
{
  "kind": "answer",
  "message": "This project is a VS Code extension for visual HTML editing."
}
```

`done` ends the turn without additional work. It may still include a user-visible closing message:

```json
{
  "kind": "done",
  "message": "The requested check is complete."
}
```

### Fields

Top-level fields:

- `kind`: required. One of `act`, `answer`, or `done`.
- `message`: optional for `act` and `done`, required in practice for `answer`. User-visible Markdown or a short progress note.
- `calls`: required for `act`; omitted for `answer` and `done`.

Call fields:

- `id`: required. Stable call id used by logs, graph nodes, result references, and dependencies.
- `type`: required. `tool` or `agent`.
- `name`: required. For `tool`, this is a concrete tool id from the runtime tool catalog. For `agent`, this is a concrete agent id or `auto`.
- `args`: optional object. For `tool`, this must match the selected tool's input schema. For `agent`, this is the delegation input.
- `depends`: optional string or string array. Call ids that must complete before this call starts.
- `result`: optional. Result return policy. Allowed values: `summary`, `full`, `structured`, `on_failure`, `on_demand`, or `adaptive`. Default is `summary`.
- `title`: optional short label for UI display.

### Batch Calls

All runtime execution uses `calls`, even when there is only one call. This avoids two equivalent syntaxes for the same concept.

Example with simple dependency:

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

Example with agent delegation:

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

### Runtime Normalization

Runtime should normalize simplified v1 syntax into the internal action representation used by execution, logging, and UI projection:

- `kind: "act"` maps to `intent: "execute"`.
- Each `calls[]` item maps to one internal action.
- `calls[].type` maps to internal executor type.
- `calls[].name` maps to internal executor target.
- `calls[].args` maps to internal action input.
- `calls[].depends` maps to internal dependencies.
- `calls[].result` maps to internal result policy.
- `kind: "answer"` maps to a response message.
- `kind: "done"` maps to a stopped turn, optionally with a visible message.

The simplified syntax is a model-facing carrier. Runtime maps it into the richer internal protocol representation used for execution, logging, UI projection, and full-DSL evolution.

### Model-Visible Input Transcript

The v1 output contract is structured: the model submits `AgentProtocolOutput` through the native tool-call channel.

The v1 input contract is different: runtime should not replay provider API objects, raw `tools` declarations, `toolChoice`, or raw `AgentProtocolOutput` arguments as the model-visible history. Those are implementation details. The next request should show what happened in a model-readable transcript.

Protocol agents use a model-visible transcript format that is distinct from provider request JSON. Runtime may use provider tool schemas internally, but replay to the model should remain protocol-shaped and readable.

Current v1 should use Markdown-oriented turns:

````markdown
<turn index="1">
## User request

当前插件各个按钮点了都没效果，你进行一次 code review，定位问题，然后修复
</turn>

<turn index="2">
## Assistant protocol request and runtime results

run_id: `apr_abc123`
Purpose: Inspect extension wiring
Status: completed

### Call read_extension

Tool: `read`

```shell
tool read <<'JSON'
{
  "filePath": "/Users/jin/github/htmly/src/extension/extension.ts"
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

Rules:

- Each historical turn should be easy to read as a short transcript, not as provider request JSON.
- Do not use `role="..."` attributes in v1 turn tags. Use Markdown headings such as `## User request`, `## Assistant protocol request and runtime results`, and `## Assistant answer` to describe what happened.
- A protocol runtime turn should keep each call immediately next to its corresponding result. Avoid listing all calls first and all results later, because that increases pairing ambiguity for the model.
- The call section includes the selected tool or agent and the arguments. The result section should not repeat the same arguments. It should contain status, artifact references when available, and the result content.
- `run_id` is the runtime execution id used to correlate logs, UI projection, hidden context, and artifacts.
- `Purpose` is the model-provided short reason or title for why the group of calls was requested. Keep the display label neutral and readable; it does not need to be a strict `operation_reason` field.
- `Status` is the runtime-computed aggregate result for the run: `completed`, `blocked`, or `failed`.
- The final instruction after the turns is not part of any historical turn. It is a per-request reminder that asks the model to decide the next step and obey the output format.
- Model reasoning or private thinking should not be replayed as model-visible history. Replay user-visible assistant text, explicit protocol requests, and runtime observations instead.

### Direct Request Recovery

Runtime may recover direct tool or delegation requests when safe:

- A direct model request to a known runtime tool can be converted into `kind: "act"` with one `calls[]` item.
- A textual invocation block can be marked as a protocol violation and recovered only if the intended tool name and arguments are unambiguous.
- Recovered calls must be visible in logs so protocol adherence and recovery rate can be measured.
- Unsafe or ambiguous recovery must fail closed. Runtime should ask the model to retry with the simplified protocol shape or surface a clear protocol error.

Recovered requests do not define the protocol. They are accepted only as inputs to Runtime normalization, and normalized actions then follow the same validation, permission, logging, and projection path as explicit protocol declarations.

## Vocabulary And Abstraction Boundaries

The protocol should keep its core vocabulary abstract enough to describe many execution domains, while still being concrete enough for validation and UI display.

Recommended core concepts:

- `Protocol`: the model-runtime contract and versioned grammar.
  Examples: `agent.protocol` version `1`, `agent.protocol.result` version `1`, an `agent-protocol` fenced JSON block.
- `Declaration`: one model-authored protocol block.
  Examples: an `execute` declaration with an action graph, an `expand_ref` declaration asking for more detail, a `revise` declaration after a failed action.
- `Envelope`: top-level routing metadata for a declaration.
  Examples: `type`, `version`, `intent`, `persist`, `title`, `execution`, `payload`.
- `Payload`: the structured body of a declaration.
  Examples: an `action_graph` payload, an `expand_ref` payload, a `decision` payload.
- `Action`: a semantic unit of intended work.
  Examples: inspect relevant files, review one module, run a test command, ask the user to approve a risky change, summarize results.
- `Operation`: what an action is trying to do.
  Examples: `search`, `read`, `review_code`, `run_tests`, `edit`, `summarize`, `ask_user`, `expand_reference`.
- `Executor`: the runtime capability class that may execute an action.
  Examples: a `tool` that reads files, an `agent` that reviews code, a `runtime` operation that merges summaries, a `human` approval request, a `pipeline` that runs lint and tests.
- `Target`: a concrete executor name or `auto`.
  Examples: `read_file`, `code-reviewer`, `ask_user`, `test_pipeline`, `auto`.
- `Capability`: a reusable ability label used for matching.
  Examples: `filesystem.read`, `code_review`, `frontend`, `testing`, `approval`, `summarization`, `external.search`.
- `Resource`: data, files, services, artifacts, or context that an action may read or write.
  Examples: `repo://current`, `file:packages/app/src/toolbar.ts`, `artifact:source_index`, `runtime://runs/run_123/actions/review/output`, `input:user.goal`.
- `Policy`: constraints and preferences for execution, failure handling, result return, persistence, permissions, and budget.
  Examples: `persist: true`, `return_to_model: "summary"`, `max_tokens: 6000`, `requires_approval: true`, `on_failure: "ask_model"`, `store_full: true`.
- `Result`: runtime-produced outcome of a declaration or action.
  Examples: `status: "completed"`, changed file list, test report summary, review findings, artifact references, failure reason.
- `Reference`: a pointer to Markdown sections, prior action outputs, runtime records, or artifacts.
  Examples: `md:review.prompt`, `action:inspect.summary`, `artifact:test_report`, `runtime://runs/run_123`, `input:user.goal`.
- `User Visible Note`: optional human-facing explanation for progress and trust.
  Examples: "I will inspect the toolbar code and then return a per-button review.", "This may run tests and take a few minutes.", "I need your approval before publishing."

These concepts are intentionally abstract. The protocol should avoid making domain objects such as `workflow`, `code_review`, `toolbar`, `test`, or `agent_task` into core protocol categories. They can appear as examples, operations, capabilities, or executor targets, but not as fixed protocol boundaries.

Use `type` for object classification and `operation` for the action's semantic intent.

Example:

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

In this example, `type: "action"` says what the object is. `operation: "review_code"` says what it is trying to do. `executor.type: "agent"` says what class of executor should handle it.

## Message Types

The protocol should define separate formats for different directions. They are related but not identical.

### Runtime To Model: Request

The runtime request tells the model what task is being handled, what protocol capabilities are available, and what output shape is expected.

This input is optimized for model comprehension. XML-like or Markdown sections are acceptable because they handle long text naturally.

For the v1 carrier surface, prefer the Markdown transcript described above over raw provider request JSON. The runtime may still use provider tool schemas internally, but the model-visible conversation history should describe prior user requests, assistant protocol requests, concrete calls, and runtime results in readable turns.

Example:

```xml
<agent-request>
  <protocol>
    <type>agent.protocol.request</type>
    <version>1</version>
    <allowed-output>assistant_text</allowed-output>
    <allowed-output>agent_protocol</allowed-output>
  </protocol>

  <agent>
    <name>protocol-runner</name>
    <role>orchestration</role>
  </agent>

  <user-goal>
    Review every toolbar button implementation and report issues.
  </user-goal>

  <capabilities>
    <capability>action_graph</capability>
    <capability>executor_registry</capability>
    <capability>executor_auto_selection</capability>
    <capability>markdown_payload</capability>
    <capability>result_policy</capability>
    <capability>persistence</capability>
  </capabilities>

  <output-rules>
    If the task benefits from structured execution, emit one agent-protocol declaration.
    If the task is simple, answer normally.
  </output-rules>
</agent-request>
```

### Model To Runtime: Declaration

The model declaration is optimized for program parsing and validation. Use a JSON fenced block for structured metadata and action graph data, with Markdown sections for long text.

For v1, the declaration is submitted through the `AgentProtocolOutput` carrier using the flat `{ kind, message, calls }` shape described above. The JSON fenced block below is the full DSL shape that the carrier maps into.

Recommended full DSL shape:

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

### Runtime To Model: Result

Runtime result is the execution outcome that the model should use for the next decision or final user answer.

The result should normally include semantic action ids, titles or descriptions, statuses, and summaries. It should not include every raw tool call or full output by default.

In v1, return results as Markdown transcript entries where each call is immediately followed by its result. Keep structured records in runtime storage and metadata for logs, UI, and recovery, but shape the model-visible text for comprehension.

Example:

```xml
<protocol-exchange id="run_123" type="action_graph">
  <declaration-summary>
    The model declared two actions:
    - inspect_code: find toolbar source files and tests.
    - review_toolbar: review behavior, display, focus, undo/redo, and edge cases.
  </declaration-summary>

  <runtime-result status="completed">
    <action id="inspect_code" status="completed">
      <title>Inspect Code</title>
      <description>Find toolbar components, editor integration, styles, and tests.</description>
      <summary>Found Toolbar.vue, ToolbarButton.vue, toolbarConfig.ts, useToolbar.ts, useEditor.ts, and related tests.</summary>
    </action>
    <action id="review_toolbar" status="completed">
      <title>Review Toolbar</title>
      <description>Review toolbar button behavior, display layering, focus, undo/redo, and selection edge cases.</description>
      <summary>Found two issues: undo/redo state is not wired through, and the table dropdown can be hidden by a higher layer.</summary>
    </action>
  </runtime-result>

  <next>final_answer</next>
</protocol-exchange>
```

JSON is also valid when the runtime or model needs a more machine-checkable result:

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

### Model To User: Final Answer

The final user-facing response is normal assistant text. It should synthesize runtime results into the answer the user needs.

It should not expose raw protocol details unless the user asks for them.

### Model To User: Visible Note

When the model emits executable protocol, it may also emit a short user-visible note that explains what it is about to do.

This note is not part of execution. It is for user trust, progress visibility, and UI display.

Recommended rule:

- For simple or fast protocol declarations, omit the visible note.
- For long-running, multi-agent, durable, risky, or user-visible execution, include it.
- Keep it short. Do not duplicate the full DSL.
- Do not include implementation details that are only useful to the runtime.

Example:

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

The runtime may display `user.visible` immediately while the protocol executes. If the UI already renders the parsed action graph clearly, this section can be omitted.

## Envelope

The envelope identifies a protocol declaration and tells the runtime how to route it.

Envelope fields live at the top level of the JSON block:

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

Recommended envelope fields:

- `type`: required. Must be `agent.protocol`.
- `version`: required. Protocol version string.
- `intent`: required. Examples: `execute`, `plan`, `expand_ref`, `cancel`, `revise`, `decide`.
- `persist`: optional boolean. Whether the runtime should persist durable state before execution.
- `title`: optional human-readable title.
- `response_policy`: optional model-visible response preferences.
- `payload`: required. The typed declaration body.

The envelope is logically separate from the plan/action layer, but physically it can be one JSON object. Keeping it in the same JSON block makes parsing and validation simpler.

## Payload Types

The first supported payload types should be limited:

- `action_graph`: short-lived or durable graph of semantic actions.
- `expand_ref`: request to expand stored runtime references.
- `decision`: model decision for a blocked or failed run.
- `final_report_spec`: structured instructions for a final report.

Avoid making the protocol a general programming language. Do not support arbitrary expressions or unbounded loops in the first version.

Durable workflow behavior should be represented as execution policy on an `action_graph`, not as a separate top-level DSL type:

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

This keeps the protocol general while allowing runtime implementations to schedule, persist, recover, and display long-running graphs.

## Action Fields

Recommended action fields:

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

Field guidance:

- `id`: required. Stable semantic id. This is a low-noise alignment key similar to `tool_call_id`, but at semantic-action granularity.
- `type`: required. Must be `action`.
- `title`: recommended. Short display name.
- `description`: recommended. What the action does. Runtime should include this in model-visible results.
- `reason`: recommended. Why the action exists. Helpful when the result is returned later.
- `operation`: recommended. Domain-level verb such as `search`, `review_code`, `run_tests`, `summarize`, `ask_user`, or `edit`.
- `executor`: optional. Requested executor class, target, and capability hints. If omitted, runtime chooses.
- `depends_on`: optional. Action ids that must complete first.
- `context_refs`: optional. References to context material.
- `prompt_ref`: optional. Reference to Markdown payload for long task instructions.
- `result_policy`: optional. Model-visible return policy.
- `persist`: optional override for action-level durability.
- `failure_policy`: optional. Retry, abort, continue, or ask-model policy.

## Markdown References

Long text should not be embedded as escaped JSON strings unless it is short.

Use `md:` references to point from JSON to Markdown sections in the same model output.

Example:

```json
{
  "prompt_ref": "md:review_toolbar.prompt",
  "context_refs": ["md:shared.context"]
}
```

Corresponding Markdown:

```markdown
## shared.context

Project context and constraints.

## review_toolbar.prompt

Detailed task instructions.
```

Reference rules:

- `md:<section_id>` resolves to the Markdown heading whose normalized text equals `<section_id>`.
- Use stable semantic section ids, not numeric ids.
- Runtime resolves `md:` references before execution.
- Execution agents should receive expanded text, not unresolved `md:` references.
- Runtime should store the original DSL, resolved Markdown sections, prompt hashes, and the internal parsed representation.

## Context Versus Prompt

`context` and `prompt` have different roles.

- `prompt`: what this action must do.
- `context`: background, constraints, previous discoveries, or supporting information needed to do it.
- `input`: structured values.
- `result`: execution output.

Example:

```json
{
  "id": "review_toolbar",
  "context_refs": ["md:shared.context", "action:inspect_code.summary"],
  "prompt_ref": "md:review_toolbar.prompt"
}
```

Runtime should expand this into a node request such as:

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

## Reference Types

Recommended reference types:

- `md:<section_id>`: section in the current Markdown payload.
- `action:<action_id>.summary`: prior action summary in the current run.
- `action:<action_id>.output`: prior action output in the current run.
- `input:user.goal`: original user goal.
- `runtime://...`: persisted runtime artifact or record.
- `artifact:<name>`: named artifact produced by the run.

The model should not need traditional tools to read `md:` references. Runtime resolves them directly. For `runtime://` references, runtime can expand them automatically or allow the model to declare an `expand_ref` intent.

## Result Policy

Result policy controls what returns to the model after execution.

Recommended values for `return_to_model`:

- `none`: do not return content, only status.
- `summary`: return concise summary.
- `structured`: return structured result fields.
- `excerpt`: return selected excerpts.
- `full`: request full return; runtime may still cap or reject.
- `on_failure`: return detail only when failed.
- `on_demand`: return ref and summary; expand only if requested.
- `adaptive`: model declares priorities; runtime chooses within budget.

Example:

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

The model can declare preferences, but runtime has final authority. Runtime must enforce context budget, security, permissions, and safety.

## Full DSL And Context Replay

The model has no memory outside the current request. It cannot remember a previous assistant output unless runtime includes that output in the next request.

Therefore result replay has two valid modes.

### Full Replay

Runtime includes the previous model declaration, including JSON and Markdown payload, then appends the execution result.

In this mode, the result does not need to repeat full prompts. It should still include action ids and summaries.

Example:

```xml
<protocol-exchange id="run_123">
  <model-declaration>
    Original protocol declaration or exact assistant output.
  </model-declaration>
  <runtime-result>
    <action id="review_toolbar" status="completed">
      <summary>Found two issues.</summary>
    </action>
  </runtime-result>
</protocol-exchange>
```

### Compressed Replay

Runtime does not include the full previous declaration. It includes a declaration summary plus result.

In this mode, the result must include enough task description for the model to understand what each action means.

Example:

```xml
<protocol-exchange id="run_123">
  <declaration-summary>
    The model declared inspect_code and review_toolbar for a toolbar button review.
  </declaration-summary>
  <runtime-result>
    <action id="review_toolbar" status="completed">
      <description>Review toolbar button behavior and edge cases.</description>
      <summary>Found two issues.</summary>
    </action>
  </runtime-result>
</protocol-exchange>
```

### Hybrid Replay

Runtime includes exact declarations only while small and recent. For long or stale declarations, runtime replaces them with a summary plus `runtime://` refs.

This should be the default long-term strategy.

## Protocol Exchange Unit

Use a protocol exchange to keep a model declaration and runtime result logically grouped.

This grouping helps the model understand that a result belongs to a declaration. It is especially useful when the surrounding conversation contains multiple runs.

Recommended model-facing structure:

```xml
<protocol-exchange id="run_123" type="action_graph">
  <model-declaration-summary>
    The model declared three actions: inspect_code, review_toolbar, and final_report.
  </model-declaration-summary>

  <runtime-result status="completed">
    <action id="inspect_code" status="completed">
      <description>Find toolbar-related source files and tests.</description>
      <summary>Found six relevant files.</summary>
    </action>
    <action id="review_toolbar" status="completed">
      <description>Review toolbar button implementation and interaction boundaries.</description>
      <summary>Found two issues.</summary>
    </action>
  </runtime-result>

  <next>final_answer</next>
</protocol-exchange>
```

The exchange may contain the full declaration or only a declaration summary, depending on context budget and recency.

## Streaming

Model output may stream token by token. Runtime should not execute a partial JSON block.

First version rule:

- collect the full assistant message
- prefer one complete native `AgentProtocolOutput` call for simplified v1
- parse and validate the native tool arguments after message completion
- recover complete `agent-protocol` fenced blocks only as an alternate carrier
- execute only validated declarations

Future optimization can parse and execute a complete fenced block before the whole assistant message ends, but this is optional and riskier.

Runtime execution may also stream progress. Do not feed every progress chunk back to the model by default. Progress is for UI and logs. Return model-visible results only at decision points:

- completed
- failed
- blocked
- permission needed
- user input needed
- model decision needed

Do not replay private model reasoning as a runtime result. Reasoning traces are useful for debugging and UI display when allowed, but they are not a reliable source of truth for future model turns. Future turns should receive user-visible assistant messages, explicit protocol declarations, and runtime-produced observations.

## XML, JSON, And Markdown

Use the format that fits the direction and purpose.

### XML-like Sections

Best for model-readable input and grouped context:

- clear boundaries
- no JSON string escaping for long text
- good for nested context sections
- friendly for LLM attention

XML-like text can be parsed, but schema and data typing are less straightforward than JSON. XML also has multiple equivalent shapes: attributes, child elements, text nodes, CDATA, namespaces, and whitespace rules.

### JSON

Best for model output that the program must parse:

- direct schema validation
- explicit arrays and objects
- clear primitive data types
- mature tooling with JSON Schema and Zod
- matches common tool/function calling training patterns

JSON is less comfortable for long natural-language payloads because long strings require escaping.

### Markdown

Best for long human/model-readable payloads:

- task instructions
- context paragraphs
- report templates
- examples

Recommended convention:

- Runtime to model request: Markdown transcript sections for simplified v1; XML-like or Markdown sections for full DSL experiments.
- Model to runtime declaration: native `AgentProtocolOutput` tool call for simplified v1; JSON fenced block plus Markdown payload for the future full DSL.
- Runtime to model result: Markdown transcript for simplified v1; XML-like when mostly for model reading or JSON when programmatic reprocessing is needed in full DSL flows.
- Model to user final answer: normal Markdown.

## Persistence

Not every protocol declaration should be durable.

Use `persist: false` for short-lived action orchestration that can run within the current turn.

Use `persist: true` when:

- execution must survive restart
- run lasts across turns or sessions
- multiple agents are involved
- progress must be shown in UI
- audit or recovery matters
- user explicitly asks for a workflow, plan, or long-running execution

Durable workflow-like behavior should be treated as `persist: true` plus an execution policy, not as a separate protocol family. Short tool orchestration can be `persist: false`.

## Executor Registry

The protocol should treat executable objects as runtime-registered executors.

Tools and agents are important executor types, but they are not the only possible types. From the model's point of view, all of these can be declared through the same action grammar:

- call a normal tool
- assign a task to an agent
- ask the runtime to perform an internal control action
- request a human decision or approval
- invoke a predefined pipeline or external service

This does not mean every executor is identical internally. It means the model can use one declarative action grammar while the runtime chooses the concrete execution path.

Recommended executor types:

- `tool`: deterministic or bounded system function.
- `agent`: LLM-driven executor with reasoning and local autonomy.
- `runtime`: runtime-owned control operation, such as wait, merge, checkpoint, summarize, or expand references.
- `human`: user or human operator decision.
- `pipeline`: predefined multi-step deterministic procedure.
- `service`: external service or integration.

Recommended registry information exposed to enabled protocol agents:

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

Action selection rules:

- If `executor.target` names a concrete executor, runtime may use it after validation.
- If `executor.target` is `auto` or omitted, runtime chooses using `executor.type`, `capabilities`, task description, availability, policy, and cost.
- `executor.type` classifies the executor. It should not be `auto`.
- Runtime has final authority to reject or override unsafe or unavailable choices.
- The model should describe required capabilities, not hard-code implementation assumptions.

Example:

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

## Summaries

Summaries can come from several layers:

1. Tool-native structured summary, such as match counts, file lists, exit codes, or changed file paths.
2. Runtime mechanical summary, such as status counts, artifact refs, truncation markers, and errors.
3. Executor final output, when the action is handled by an agent, tool, human, pipeline, runtime operation, or service.
4. Dedicated summarizer model or summary agent for long raw outputs.

Runtime should store full outputs separately and return summaries plus references unless policy requires more.

## Expansion

When the model needs more detail, it can emit an expansion declaration:

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

Runtime decides how much to expand and returns another protocol result.

## Safety And Validation

Runtime must enforce:

- only enabled agents can emit executable protocol declarations
- only complete assistant messages are parsed in the first version
- only explicit fenced blocks with `type: "agent.protocol"` are recognized
- schema validation before execution
- permission checks before tool or file operations
- context budget limits
- persistence before durable execution
- result policy cannot override safety or privacy constraints
- no arbitrary scripting language in the DSL

## User Experience Contract

The protocol is not only a model-runtime contract. It also affects what the user can understand, trust, interrupt, and inspect.

Runtime should provide a user-facing projection for executable declarations:

- `title`: short run label.
- `user.visible`: optional explanation shown before or during execution.
- `actions[].title`: display label for each action.
- `actions[].description`: concise explanation of each action.
- `status`: pending, running, completed, failed, canceled, blocked, or waiting.
- `progress`: optional counts or phase descriptions.
- `result_summary`: user-facing outcome after completion.
- `details_ref`: optional reference for raw protocol, logs, artifacts, or execution details.

The user should not need to read JSON to understand what is happening. The UI can expose the raw DSL for inspection, debugging, and advanced use, but the normal display should be derived from titles, descriptions, statuses, and summaries.

## Missing Considerations For Later Versions

The first version should stay small, but the protocol needs explicit design space for these topics:

- `permission_policy`: which actions require user approval before execution.
- `budget_policy`: limits for tokens, time, cost, retries, and parallelism.
- `cancellation_policy`: how user cancellation or runtime abort affects running actions.
- `idempotency`: whether an action can be safely retried or resumed.
- `side_effects`: whether an action reads, writes, sends, deletes, purchases, publishes, or changes external state.
- `data_visibility`: whether results are visible to the model, user, logs, future runs, or only the runtime.
- `privacy`: which artifacts or outputs must not be replayed into model context.
- `conflict_resolution`: what happens when two actions want incompatible writes.
- `schema_evolution`: how versioned declarations continue to parse after schema changes.
- `partial_results`: what the runtime returns when a graph fails halfway through.
- `approval_gates`: how the model asks the user before risky or irreversible actions.
- `result_granularity`: how summaries, structured fields, excerpts, and full artifacts are chosen.
- `ui_projection`: which protocol fields are stable enough for frontend rendering.

These should be policies or projections, not domain-specific action types.

Practical priority:

- Must define before implementation: `permission_policy`, `budget_policy`, `cancellation_policy`, `side_effects`, `data_visibility`, `partial_results`, `result_granularity`, and `ui_projection`.
- Should define soon after the first working version: `idempotency`, `privacy`, `approval_gates`, and `schema_evolution`.
- Can wait until real use exposes the need: `conflict_resolution`, advanced resume semantics, and richer adaptive result shaping.

The first implementation does not need to solve every boundary completely. It does need clear defaults, because unclear defaults become hidden runtime behavior that the model, user, and developer cannot reason about.

## Development Readiness Checklist

Before implementing the first protocol agent, define the minimum runtime contract:

- Enabled agent name and prompt rules: which agent may emit protocol, when it should emit normal text, and when it should emit a declaration.
- Parser contract: how to detect an `agent-protocol` fenced block, how many blocks are allowed, and what happens when parsing fails.
- JSON schema: envelope fields, payload fields, action fields, executor fields, result policy, and validation errors.
- Markdown resolver: how `md:` section ids are normalized, resolved, stored, and reported when missing.
- Executor registry shape: available executor types, names, descriptions, capabilities, and whether each can execute automatically.
- Selection rules: how runtime handles `executor.target: "auto"`, missing executor, unavailable executor, or unsafe executor.
- Execution model: sequential versus DAG, dependency handling, status transitions, and whether persistence is required.
- Result contract: what returns to the model after success, failure, partial completion, cancellation, or blocked execution.
- User projection: what is shown in the UI before, during, and after execution.
- Safety defaults: which operations require approval, which side effects are disallowed in v1, and how budget limits are enforced.
- Storage model: where declarations, resolved Markdown, runtime results, artifacts, and UI projections are stored.
- Recovery minimum: whether v1 supports restart recovery or explicitly treats runs as current-turn only.

Recommended v1 boundary:

- support one declaration per assistant message
- support only `payload.type: "action_graph"`
- support `execution.strategy: "sequential"` first, then add `dag`
- support executors `tool`, `agent`, `runtime`, and `human` in schema, but implement only the subset available in the current runtime
- require explicit approval for write, delete, publish, send, purchase, or external side-effect actions
- return summaries to the model by default and store full artifacts separately
- show user-facing progress from `title`, `user.visible`, action titles, statuses, and result summaries

## Minimal First Version

First version should support:

- one `agent-protocol` JSON block per assistant response
- Markdown payload sections referenced by `md:`
- `action_graph` payload
- action fields: `type`, `id`, `title`, `description`, `reason`, `operation`, `executor`, `depends_on`, `context_refs`, `prompt_ref`, `result_policy`
- result policies: `summary`, `structured`, `full`, `on_failure`, `on_demand`, `adaptive`
- protocol exchange result wrapper
- full replay for short recent declarations
- compressed replay for long or stale declarations
- `persist: false` ephemeral runs
- `persist: true` durable action graph runs
- executor registry exposure
- `executor.type`, `executor.target`, and `executor.capabilities` for action selection
- optional `user.visible` Markdown section for user-facing progress explanation

Defer:

- streaming partial execution before assistant message completion
- arbitrary nested expressions
- unbounded loops
- user-defined scripting
- multiple protocol blocks in one response
- automatic execution for non-protocol agents

## V1 Implementation Plan

V1 implements a usable protocol path for explicitly configured agents. It keeps the target abstraction as Harness DSL while allowing `AgentProtocolOutput` to be the stable model-facing carrier.

Execution path:

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

Implementation areas:

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

Recommended task sequence:

1. Define the v1 schema and fixtures.
2. Parse one explicit protocol declaration per assistant response.
3. Enable protocol only for agents with `runner: "protocol"` or equivalent explicit eligibility.
4. Build a constrained executor registry for read/search/summarize style actions.
5. Execute ephemeral sequential protocol runs and return concise model-visible results.
6. Add agent delegation as a protocol executor after entry/capability routing is stable.
7. Emit protocol logs and export complete traces.
8. Project protocol runs in the session side panel and Logs timeline.
9. Apply replay policy so future model turns see concise protocol observations, not raw internal traces.
10. Validate with an end-to-end read-only scenario compared against direct toolCall execution.

V1 acceptance:

- A protocol-enabled agent can emit one protocol declaration through the carrier or fenced block.
- Runtime validates, executes, logs, and projects at least a read-only sequential action graph.
- Direct tool requests can be recovered only when unambiguous and policy-safe.
- Model-visible result is concise; full output lives in logs/artifacts.
- Protocol trace export includes declaration, result, actions, tool calls, metrics, and failure/block reasons.
- UI shows protocol run status, action details, artifacts, and trace export without making raw JSON the primary experience.
- Focused backend/frontend checks run from package directories; SDK is regenerated if API shapes change.

## Relationship To Workflow Adapter

Workflow is a Harness durable orchestration adapter, not the protocol boundary.

The model-runtime protocol and workflow adapter share governance objects but keep separate execution contracts. Workflow state, recovery, and UI projection behavior can inform protocol design without making workflow execution implicit.

The relationship is:

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

If the workflow adapter is represented through Agent Protocol DSL, it should map into an `action_graph` with `persist: true` and `execution.strategy: "dag"`. That mapping is an explicit adapter contract.
