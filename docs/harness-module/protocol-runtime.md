# Protocol Runtime Module

## LLM Request Limits

LLM request acquisition is globally coordinated inside the server process before calling the provider SDK. The runtime supports two independent provider/model gates:

- `concurrency` limits active in-flight requests.
- `rpm` limits request starts in a rolling one-minute window.

Provider-level and model-level limits are both enforced when present. A request waits if any configured gate is full. Waiting sessions are marked `rate_limited` with `scope=provider|model`; RPM waits also include `kind=rpm` and a `reset` timestamp for the next local wake-up.

RPM capacity is consumed when the request is released from the local queue, immediately before the LLM call starts. This keeps failed, short, and long streams counted consistently as upstream request attempts.

The queue has a timer for RPM waits. Unlike concurrency, RPM capacity can become available without any active request finishing, so the limiter wakes itself when the oldest start exits the minute window.

## Invalid Protocol Output Diagnostics

Protocol runner sessions use the native `AgentProtocolOutput` tool as the carrier for model output. If the provider returns malformed arguments for that tool, the LLM layer redirects the failed call to the internal `invalid` tool result.

The invalid result must preserve enough evidence for prompt and protocol debugging:

- the human-readable parser error,
- the raw protocol output fragment extracted from the parser error when present,
- metadata identifying the violation and the original tool name.

The UI can render the generic tool detail view from the result input, output, and metadata. Keeping the raw fragment in both output text and metadata makes the failure visible in the timeline and available in copied details.

The session processor also records the streamed tool-call arguments before schema parsing or repair changes the call shape. `tool-input-delta` chunks are accumulated on the pending tool part, then written to `tool.input.end` and the following `tool.start` log with `raw`, `rawBytes`, and `truncated`. The log payload is capped at 64 KiB so malformed protocol packets can be inspected without unbounded session logs.

For `ActionResult`, runtime records an explicit `tool.action_result` log for every handoff attempt. Completed tool calls are logged with `outcome=success`. Tool-call failures, including schema/parser failures, are logged with `outcome=failure` and include the bounded raw tool input captured before repair or parser text is generated. Runtime also stores a full LLM response event payload for each request attempt and links failed tool parts/logs to that `responsePayload`. Failed tool cards show a bounded response preview with total character counts and can export the full response payload. This keeps the original provider/tool-call evidence visible instead of replacing it with only the derived validation message.

The prompt loop counts consecutive failed `ActionResult` calls from persisted tool parts. More than three consecutive failed `ActionResult` attempts marks the turn blocked, emits `tool.action_result_limit`, and stops the loop. The loop also counts consecutive tool calls for the active agent and stops with `tool.loop_limit` when the count exceeds `agent.maxToolCalls`; the runtime default is `1000` when the agent has no override.

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

Manual delegation submit uses the same aggregate handoff path. The submit route accepts a parent session and run id, records current pending child statuses as synthetic results when forced, removes those children from the pending set, and sends one collected Markdown handoff to the parent. Later child completions for that run do not notify the parent again after the run has been claimed.

Delegation cancellation is a stronger manual handoff. Runtime writes a visible control message into each pending child session, cancels its active prompt, marks the child `aborted`, then force-submits the parent run through the same aggregate handoff path. This keeps the child session inspectable and makes the user cancellation explicit to both the child timeline and the parent summary.

The parent handoff prompt is Markdown prose, not JSON. It includes run counts, child session ids, action ids, agents, statuses, and summaries so the parent can continue naturally or produce the final user-facing answer.

`user_completed` is distinct from runtime `completed`. It means the user decided the session no longer needs runtime work, even if the previous state was waiting, blocked, interrupted, failed, paused, aborted, or partially complete. Runtime records it through `SessionStatus.set()` and status-change logs, but must not treat it as proof that the model or delegated task produced a normal final result. When a child session with `user_completed` is included in a forced delegation handoff, the handoff reports a partial/manual result rather than a natural completion.

## Request Turn State

Prompt requests are tracked as explicit turns on user message metadata. A turn records whether that single request is `queued`, `running`, or `done`; it does not represent the entire session lifecycle.

`waiting_user` and `waiting_child` are done outcomes for the current turn. The session status remains `waiting_user` or `waiting_child` so the title bar, session tree, and prompt dock can still show the broader wait state.

Failed assistant completion is also a done turn. If the assistant message has `time.completed` and an error, Runtime writes the user turn as `status=done`, `outcome=error`, and `reason=error`. The failure remains visible through the assistant error and session status; the prompt loop must not leave the user turn unfinished and rely on a future request to retry it implicitly.

Terminal assistant completion is also a done turn. If an assistant message has a terminal finish reason such as `stop` and no pending tool call, runtime action, compaction, user gate, or child wait remains, Runtime must finish the source user turn before evaluating later queue work. A complete text response is not a continuation signal by itself; only new tool results, runtime actions, compaction work, queued user messages, or wait states may drive another model request.

Turn completion is written by runtime boundaries:

- protocol response or final answer after `AgentProtocolOutput` is parsed and executed,
- delegated child dispatch after the run reaches a wait-for-child boundary,
- confirm/input gates after the runtime has created the user-facing request,
- accepted `ActionResult` records after delegation routing stores the result,
- assistant completion for non-protocol and legacy turns, including errored assistant messages with `time.completed`.

`ActionResult` is a terminal native tool for delegated child sessions. Its assistant message commonly finishes with `finish=tool-calls`, because the model ended the step by calling the tool. Runtime must still treat that message as a valid delegation result: store the `session.action_result`, finish the source user turn with `reason=action_result`, and stop the prompt loop instead of asking the model for another assistant step.

Delegated task prompts must include a concrete native `ActionResult` argument example. Worker task results use `action_id`, `status`, `result`, and optional `scope`, `changed_files`, `verification`, and `blockers` string fields. Verifier results use `action_id`, `target_action_id`, `status`, `result`, and optional `issues`, `evidence`, and `worker_feedback` string fields. The example is part of the runtime contract because provider tool-call behavior can degrade when the model only receives prose field descriptions.

Runtime derives the result branch from the submitted shape: verifier results include `target_action_id`, while worker results do not. Stale fields such as `role`, `result_type`, `kind`, and `summary` are ignored during input parsing rather than treated as protocol instructions; `summary` is not mapped into `result`, so a valid call still needs an explicit `result`. After a native tool call is accepted, runtime stores an internal normalized result with `kind` and `role` for routing; that storage shape is not part of the model-facing input protocol. Worker `status` is one of `success`, `failure`, `error`, or `reply`; verifier `status` is one of `pass`, `fail`, `error`, `reply`, or `skipped`. When schema parsing fails, the tool error returned to the model must restate the strict direct-argument protocol, worker/verifier required fields, valid statuses, and an example.

When a terminal delegated child already has `session.action_result`, prompt startup repairs stale source turns before accepting or resuming another request. It first uses `completed_message_id`; if that historical assistant message is unavailable, it closes unfinished user turns created before `completed_at`. This is a local turn-state repair, not a prompt rejection: users can still send explicit follow-up prompts to completed child sessions, and those prompts must not be preempted by the stale source turn.

The prompt loop consumes the earliest unfinished user-originated turn first. Runtime-generated continuation turns, such as delegation result summaries, are also queued but are processed after user-originated queued messages. This keeps user input authoritative while still allowing child-session summaries to resume the parent model automatically.

For legacy messages that predate explicit turn metadata, the fallback completion check treats any same-parent assistant with `time.completed` as handled, even when that assistant has an error. This prevents old provider failures from being selected again when a later user message starts a new request. The fallback must not apply to messages that already have explicit turn metadata; a `queued` or `running` turn remains active even if an assistant message in the turn has completed with `finish=tool-calls`.

The session UI reads the same turn metadata before falling back to legacy assistant completion. End-of-turn summaries can display runtime stats such as tool calls, protocol actions, child sessions, confirmations, and duration without guessing from assistant message shape.

## Child Session Model Binding

Protocol delegation and workflow subagent execution persist the child session execution identity when creating the child session.

Model selection uses this priority:

1. the target agent configured model,
2. the parent session model,
3. the existing prompt/runtime default fallback when neither side has a model.

The resolved model must be the same model stored on the child `session.model` and used for the initial child prompt. This keeps the UI-visible session binding aligned with the model that actually executes the child task, and lets later continuation of that child session reuse the inherited model instead of falling back to an unrelated default.

Explicit user prompt model selection is also a hot session binding, but it is not an implicit overwrite. When a prompt, command, shell, or session-tree update request includes a model, runtime compares it with the current `session.model` before creating the user message. If the session has no model or the requested model matches, runtime can bind it immediately. If the request would replace an existing bound model, runtime rejects the request with `409 Conflict` unless the caller includes `confirm: true`; only the confirmed retry updates `session.model`.

Prompt execution also treats `session.model` as the live override for queued turns. The loop refreshes the session before each turn and resolves the actual provider/model as `session.model ?? user.model`, so an older queued or internal user message cannot keep sending requests to a historical provider after the session binding changes.

Session tree projection treats `session.model` as the visible execution identity. Historical user or assistant message model fields are request audit data, not the tree node model source; using them for projection can make an updated session appear to revert to an older provider.
