# Agent Protocol DSL Research Notes

## Scope

This note reviews adjacent industry designs that are relevant to Agent Protocol DSL:

- Anthropic Advanced Tool Use and Programmatic Tool Calling
- AutoGen code execution and code executors
- ReWOO
- LLMCompiler
- LangGraph durable execution and ToolNode
- MCP

The goal is not to copy these systems. The goal is to learn which design pressures are real, which solutions are proven useful, and which ideas should influence the first Agent Protocol DSL implementation.

Local reference files are stored under:

```txt
docs/agent-rewrite/references/agent-protocol-dsl/
```

## High-Level Finding

The strongest shared pattern is this:

```txt
Interleaved model reasoning + tool observation loops do not scale well.
```

Several systems try to reduce repeated model calls, avoid flooding model context with intermediate outputs, or separate planning from execution:

- Anthropic Programmatic Tool Calling moves multi-tool orchestration into a code execution environment and returns only final output to the model.
- ReWOO separates Planner, Worker, and Solver so the planner creates a blueprint before tool observations are available.
- LLMCompiler creates a dependency graph of tasks and executes ready tasks in parallel.
- LangGraph moves durable execution, checkpointing, idempotency, replay, and human-in-the-loop into runtime structure.
- AutoGen code execution lets the model emit executable text blocks that a runtime detects and executes.
- MCP standardizes capability exposure, resource access, user consent, progress, cancellation, errors, and logging.

Agent Protocol DSL is aligned with these pressures, but differs in one important way:

```txt
The model-runtime interaction itself is a protocol DSL, not native toolCall plus an outer workflow wrapper.
```

## Anthropic Advanced Tool Use

Source:

- `anthropic-advanced-tool-use.html`
- `anthropic-advanced-tool-use.txt`
- https://www.anthropic.com/engineering/advanced-tool-use

Relevant ideas:

- Large tool libraries should not be fully loaded into model context upfront.
- Tool discovery can be separate from tool execution.
- Intermediate tool results can pollute context and distract the model.
- Complex workflows pay extra latency because each tool call requires another model inference pass.
- Programmatic orchestration can keep intermediate results out of the model context and return only useful final results.
- Tools callable from code need explicit opt-in.

What Agent Protocol DSL should learn:

- Executor registry should support deferred loading and search, not always inject every executor definition.
- `result_policy` should default to summaries and references, not raw full outputs.
- Intermediate results should be stored by runtime and only replayed when needed.
- The model should be able to declare result priorities, but runtime should decide final context budget.
- Executors that can cause side effects should opt in explicitly and require policy checks.

Protocol design impact:

```json
{
  "executor": {
    "target": "auto",
    "capabilities": ["filesystem.search"]
  },
  "result_policy": {
    "return_to_model": "summary",
    "store_full": true
  }
}
```

Do not expose the entire executor registry by default. Expose compact descriptors first, then allow expansion.

## AutoGen Code Execution

Sources:

- `autogen-code-execution.html`
- `autogen-code-execution.txt`
- `autogen-code-executors.html`
- `autogen-code-executors.txt`
- https://autogenhub.github.io/autogen/docs/notebooks/agentchat_auto_feedback_from_code_execution/
- https://autogenhub.github.io/autogen/docs/tutorial/code-executors/

Relevant ideas:

- A runtime can detect executable code blocks in model text and execute them.
- Code executors return execution result messages back into the conversation.
- Human input mode controls whether execution is automatic or manually approved.
- Code execution needs timeout, working directory, execution environment, cleanup, and state semantics.
- Different executors have different state behavior: command-line execution is stateless per block, while Jupyter execution keeps state.

What Agent Protocol DSL should learn:

- Text-level protocol execution is feasible. It does not have to use native toolCall.
- Protocol blocks must be explicit, fenced, and validated before execution.
- First version should allow only one executable declaration per model message.
- Execution environment state must be defined. Stateless per action is safer for v1.
- Approval mode should be a first-class policy.
- Timeouts are not optional.

Protocol design impact:

```json
{
  "execution": {
    "strategy": "sequential",
    "state": "stateless",
    "timeout_ms": 120000
  },
  "permission_policy": {
    "mode": "auto_read_approval_write"
  }
}
```

## ReWOO

Sources:

- `rewoo.pdf`
- `rewoo.txt`
- https://arxiv.org/abs/2305.18323

Relevant ideas:

- Planning can be separated from tool observations.
- Planner creates a blueprint of interdependent plans before external evidence is fetched.
- Worker fills evidence slots.
- Solver synthesizes plan plus evidence.
- This reduces repeated prompt history and makes the system more robust to tool failures.

What Agent Protocol DSL should learn:

- Our protocol should not force the model to wait for every action result before declaring the next action.
- `action:<id>.summary` and reference placeholders are useful and should be explicit.
- Final synthesis should be a separate model step after runtime returns structured results.
- Partial failure can still allow a final answer if the solver/model can reason from incomplete evidence.

Protocol design impact:

```json
{
  "id": "review",
  "depends_on": ["inspect"],
  "context_refs": ["action:inspect.summary"],
  "failure_policy": {
    "on_dependency_failed": "ask_model"
  }
}
```

## LLMCompiler

Sources:

- `llmcompiler.pdf`
- `llmcompiler.txt`
- https://arxiv.org/abs/2312.04511

Relevant ideas:

- Planner generates a DAG of tasks with interdependencies.
- Task fetching dispatches tasks when dependencies are ready.
- Executor runs independent tasks in parallel.
- Streaming planner can dispatch ready tasks before the full plan finishes, but this is more complex.
- Replanning is useful when intermediate results change the dependency graph.
- Dedicated memory per task helps manage intermediate state.

What Agent Protocol DSL should learn:

- `action_graph` is the right core payload.
- DAG should be a first-class execution strategy, but v1 can start sequential.
- Node readiness, dependency resolution, and result substitution belong in runtime.
- Replanning should be an explicit later feature, not hidden behavior.
- Each action should have isolated result storage.

Protocol design impact:

```json
{
  "execution": {
    "strategy": "dag",
    "max_parallel": "runtime_default"
  },
  "payload": {
    "type": "action_graph",
    "actions": [
      {
        "id": "a",
        "depends_on": []
      },
      {
        "id": "b",
        "depends_on": ["a"]
      }
    ]
  }
}
```

Do not let the model set provider-level concurrency directly. Runtime owns concurrency.

## LangGraph Durable Execution

Sources:

- `langgraph-durable-execution.html`
- `langgraph-toolnode.html`
- `langgraph-toolnode.txt`
- https://docs.langchain.com/oss/python/langgraph/durable-execution
- https://reference.langchain.com/python/langgraph.prebuilt/tool_node/ToolNode

Relevant ideas:

- Durable execution requires persistence and a run/thread identifier.
- Resume does not necessarily continue from the same line; it replays from a safe starting point.
- Non-deterministic operations and side effects need to be wrapped as tasks/nodes.
- Idempotency matters, especially for writes and external API calls.
- Tool execution needs error handling strategies.
- ToolNode supports direct tool-call objects, not only messages with model tool calls.

What Agent Protocol DSL should learn:

- Durable mode must persist before execution starts.
- Action result files or records should be the replay unit.
- `side_effects` and `idempotency` cannot be vague if persistence is enabled.
- Runtime must distinguish invocation errors, execution errors, cancellation, blocked states, and partial completion.
- Direct execution objects are valid. Native toolCall is not required as the only representation.

Protocol design impact:

```json
{
  "persist": true,
  "execution": {
    "mode": "durable",
    "strategy": "dag"
  },
  "policy": {
    "side_effects": "read_only",
    "idempotency": "safe_to_retry"
  }
}
```

## MCP

Source:

- `mcp-spec.html`
- `mcp-spec.txt`
- https://modelcontextprotocol.io/specification/2025-03-26/index

Relevant ideas:

- Capability negotiation matters.
- Resources, prompts, tools, sampling, progress, cancellation, errors, and logging are separate concepts.
- User consent and control are central.
- Tool descriptions and annotations should not be blindly trusted.
- Hosts should provide clear UIs for reviewing and authorizing activities.

What Agent Protocol DSL should learn:

- Executor registry should separate executable capabilities from resources and prompts.
- Runtime should expose capability negotiation to the enabled protocol agent.
- Consent, cancellation, progress, errors, and logs should be protocol-visible or UI-visible concepts.
- Tool/executor metadata is advisory and must be validated by trusted runtime config.

Protocol design impact:

```json
{
  "capabilities": ["action_graph", "executor_registry", "markdown_payload"],
  "permission_policy": {
    "requires_approval": ["write", "external_side_effect"]
  }
}
```

## Recommended Protocol Adjustments

1. Add executor discovery states.

```json
{
  "executor_registry": {
    "mode": "compact",
    "can_expand": true
  }
}
```

2. Add action-level side-effect declaration.

```json
{
  "policy": {
    "side_effects": "read_only",
    "idempotency": "safe_to_retry"
  }
}
```

3. Add clear status taxonomy.

```txt
pending
running
completed
failed
blocked
waiting_for_user
canceled
partial
skipped
```

4. Add failure classes.

```txt
parse_error
validation_error
permission_denied
executor_unavailable
invocation_error
execution_error
timeout
canceled
partial_failure
```

5. Add run and action storage contract.

```txt
run.json
declaration.raw.md
declaration.normalized.json
sections/
actions/<action_id>/state.json
actions/<action_id>/result.json
actions/<action_id>/artifacts/
ui.json
```

6. Keep v1 current-turn or sequential unless durable behavior is explicitly required.

Durable DAG is the right long-term shape, but it expands implementation scope sharply.

## Current Repository Versus Upstream opencode

Local evidence:

```txt
current package: packages/opencode version 1.2.27, name jin-opencode
upstream dev package: packages/opencode version 1.15.6
git rev-list HEAD...upstream/dev: local ahead 74, behind 2922
upstream diff size: 3131 files changed
```

Important observations:

- This fork has substantial local agent, UI, and workflow modifications.
- Upstream has substantial architecture and dependency changes since the local base.
- Upstream now includes additional packages such as `packages/core`, `packages/effect-drizzle-sqlite`, `packages/http-recorder`, and `packages/llm`.
- Upstream has many recent changes in session, provider, auth/account, httpapi, desktop, web/app, and Effect/Drizzle plumbing.
- Local workflow changes are concentrated in a custom runner/tool/UI path and are not present upstream.

Recommendation:

Do not start by rebasing the current fork onto latest upstream.

The safer path is:

1. Implement Agent Protocol DSL v1 as an isolated experimental subsystem in the current fork.
2. Keep it independent from the existing workflow runner.
3. Avoid spreading protocol behavior through unrelated session code until the schema and execution loop work.
4. In parallel, create a separate spike branch or worktree from latest upstream and estimate porting cost for:
   - agent replacement model
   - removed skills behavior
   - workflow UI
   - workflow runtime
   - web UI changes
   - session runner hooks
5. Decide migration only after the spike shows whether latest upstream's session/runtime architecture makes protocol DSL easier enough to justify re-porting local work.

Practical rule:

```txt
If Agent Protocol DSL can be implemented as a small runtime layer around current session output parsing, continue on current fork.
If it requires deep session/provider/message rewrites, seriously consider a new upstream-based branch.
```

## Next Implementation Slice

The next mission should not be "build the whole protocol."

Recommended first mission:

```txt
Create protocol-runner as a new agent and implement parser + validator + no-op executor.
```

Acceptance criteria:

- A configured agent can emit one fenced `agent-protocol` JSON block.
- Runtime detects it only for that agent.
- Runtime parses JSON and resolves `md:` sections.
- Runtime validates a minimal schema.
- Runtime persists or logs a normalized declaration.
- Runtime produces a user-visible projection.
- Runtime returns a synthetic result to the model without executing real actions yet.

This tests the key premise of text-level DSL without risking broad runtime changes.
