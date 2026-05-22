# Agent Protocol DSL

## Purpose

Agent Protocol DSL is a future-facing text protocol between an agent runtime and a language model.

It is a new protocol line and should not change the existing `workflow-runner` agent or existing workflow DSL implementation.

The protocol can express short-lived tool orchestration, agent task delegation, context requests, reference expansion, UI-visible structured results, recovery decisions, and final reports. Durable workflow-style execution can be implemented on top of the protocol later, but workflow is not the protocol boundary.

The goal is not to replace the runtime with a model-written programming language. The goal is to let the model declare intent in a structured way while the runtime owns parsing, validation, execution, permissions, scheduling, storage, recovery, and context shaping.

## Core Thesis

Traditional tool calling is imperative:

```txt
Model calls tool A.
Runtime returns result A.
Model calls tool B.
Runtime returns result B.
Model calls tool C.
```

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

## Why This Can Be Better Than Tool Calls

Traditional tool calls can already emit multiple calls in one assistant response. That supports simple parallel execution, but it usually represents only the current step.

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

## Cache Does Not Remove Context Noise

Provider-side cache can reduce cost and latency for repeated prompt prefixes, but it does not remove semantic noise.

If old tool traces, failed attempts, long raw outputs, and obsolete plans are present in the model context, the model can still attend to them. Cached tokens may be cheaper to process, but they are still part of the prompt. Noise is about attention, salience, ambiguity, and stale information, not only token computation.

Agent Protocol DSL should therefore treat context shaping as a first-class runtime responsibility.

## Scope

This protocol is intended for agents that are explicitly configured to use it, such as a future protocol runner, planner, controller, or other orchestration agents.

Existing workflow agents and workflow DSL should remain unchanged unless a separate migration is explicitly designed.

Ordinary chat agents do not need to emit this DSL.

The agent prompt should clearly say whether the agent may emit Agent Protocol DSL. If the agent is not configured for this protocol, the runtime should ignore protocol-looking text or treat it as ordinary content.

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

Recommended shape:

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

Runtime includes exact declarations only while small and recent. For long or old declarations, runtime replaces them with a summary plus `runtime://` refs.

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
- extract complete `agent-protocol` fenced blocks
- parse and validate after message completion
- execute only validated declarations

Future optimization can parse and execute a complete fenced block before the whole assistant message ends, but this is optional and riskier.

Runtime execution may also stream progress. Do not feed every progress chunk back to the model by default. Progress is for UI and logs. Return model-visible results only at decision points:

- completed
- failed
- blocked
- permission needed
- user input needed
- model decision needed

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

- Runtime to model request: XML-like or Markdown sections.
- Model to runtime declaration: JSON fenced block plus Markdown payload.
- Runtime to model result: XML-like when mostly for model reading; JSON when programmatic reprocessing is needed.
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
- `schema_evolution`: how older declarations continue to parse after version changes.
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
- compressed replay for long or old declarations
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
- automatic execution for ordinary agents

## Relationship To Existing Workflow DSL

Existing workflow DSL should remain a separate implementation.

This new protocol should not rename, rewrite, or implicitly replace `workflow-runner` or the current workflow DSL. The new protocol can learn from that implementation, but it should be developed as a new runner and a new runtime path.

The relationship is:

```txt
Existing workflow DSL:
  - current specialized implementation
  - durable workflow oriented
  - keep stable until explicitly migrated

Agent Protocol DSL:
  - future general model-runtime protocol
  - supports tool actions and agent actions
  - uses action_graph plus execution policy
  - may later support durable workflow-style execution
```

If migration ever happens, workflow DSL can be mapped into Agent Protocol DSL as an `action_graph` with `persist: true` and `execution.strategy: "dag"`. That migration should be explicit, not assumed.
