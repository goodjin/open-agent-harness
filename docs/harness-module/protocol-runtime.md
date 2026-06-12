# Protocol Runtime Module

## Invalid Protocol Output Diagnostics

Protocol runner sessions use the native `AgentProtocolOutput` tool as the carrier for model output. If the provider returns malformed arguments for that tool, the LLM layer redirects the failed call to the internal `invalid` tool result.

The invalid result must preserve enough evidence for prompt and protocol debugging:

- the human-readable parser error,
- the raw protocol output fragment extracted from the parser error when present,
- metadata identifying the violation and the original tool name.

The UI can render the generic tool detail view from the result input, output, and metadata. Keeping the raw fragment in both output text and metadata makes the failure visible in the timeline and available in copied details.

The session processor also records the streamed tool-call arguments before schema parsing or repair changes the call shape. `tool-input-delta` chunks are accumulated on the pending tool part, then written to `tool.input.end` and the following `tool.start` log with `raw`, `rawBytes`, and `truncated`. The log payload is capped at 64 KiB so malformed protocol packets can be inspected without unbounded session logs.

## Nested Delegation Wait Gate

Delegated sessions can create their own child sessions. When they do, dispatching nested work is only a wait state, not a completed parent handoff.

Before `SessionDelegation.complete()` marks a delegated child as completed, it checks that child's own `dsl_context.protocol` state:

- `pending_delegations` must be empty.
- `verification_cycles` must be empty.
- the child must then submit its own final `ActionResult`.

If either pending nested children or active verifier cycles remain, Runtime emits `protocol.agent.waiting`, leaves the parent session's pending delegation record in place, and does not notify the parent model. After nested children finish, Runtime resumes the delegated child with their results; that child must synthesize the final task result through `ActionResult`, and only then can the parent receive the handoff.

## Delegation Parent Wait State

Parent sessions use `waiting_child` while delegated children for the current run are still unfinished. This state is distinct from `blocked`: `blocked` remains a terminal child outcome and can be counted as an ended child when aggregating results.

Child result delivery has two phases:

- store each child result in `completed_delegations` as soon as it arrives;
- notify the parent model only after all sibling child sessions for the run have ended.

If a remaining pending child is terminal, such as `interrupted`, `aborted`, `failed`, `timeout`, `error`, or `blocked`, Runtime records a synthetic delegation result with the child session status and removes it from pending. The parent summary then mentions that status instead of waiting indefinitely.

The parent handoff prompt is Markdown prose, not JSON. It includes run counts, child session ids, action ids, agents, statuses, and summaries so the parent can continue naturally or produce the final user-facing answer.

## Child Session Model Binding

Protocol delegation and workflow subagent execution persist the child session execution identity when creating the child session.

Model selection uses this priority:

1. the target agent configured model,
2. the parent session model,
3. the existing prompt/runtime default fallback when neither side has a model.

The resolved model must be the same model stored on the child `session.model` and used for the initial child prompt. This keeps the UI-visible session binding aligned with the model that actually executes the child task, and lets later continuation of that child session reuse the inherited model instead of falling back to an unrelated default.
