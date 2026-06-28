# Protocol Runtime Module

## Protocol v2 Documentation

The current protocol documentation is being rewritten as a new version under `docs/harness-protocol-v2/`. That version treats multi-agent collaboration as the top-level frame, then defines Agent, Session, Turn, Task, Assignment, Action, Result, Event, interaction gates, model-runtime carriers, recovery, and projection.

This module document remains the implementation detail companion. When the two differ, current runtime code and this module document are the implementation authority; v2 protocol docs should be updated to match the implementation before replacing the old protocol entrypoint.

## Default Agent Routing Contract

The `default` agent is a coordinator, not an implementation worker. It must classify every request by scale, decompose work through the project/PRD, milestone, feature/capability, implementation task, and verification/review hierarchy, then declare the complete current-layer Agent Protocol graph.

User wording such as "do it all", "overall progress", or "do not handle one task at a time" changes graph completeness, not routing authority. The default agent should express that request by declaring all known graph items and dependencies in one package. It must not collapse multiple milestones, features, or implementation tasks into a single broad worker assignment.

When the next layer still needs decomposition, the graph must route that item to the matching planner (`milestone-planner` or `feature-planner`). Implementation workers are valid only for bounded implementation tasks with one objective, one main surface, and a clear verification path.

The `default` agent and planner chain carry metadata `request_footer` reminders. Runtime appends these footers to each outbound request without storing them in conversation history. The footers reinforce two contracts: understand intent and clarify important details before dispatch, then autonomously continue the confirmed graph; and call the native `AgentProtocolOutput` tool exactly once with `{ "version": "2", "items": [...] }` instead of plain text or raw JSON.

Planner confirmation depends on the task source. For a direct user task, planners clarify graph-changing details first, then emit a complete current-layer graph behind a `confirm` gate. For a parent-delegated planner task, the parent handoff is treated as authorization for that delegated scope, so the planner declares executable child items directly and does not ask the user to approve the same work again.

Planner graphs should be complete for their layer. When multiple child units are knowable, the planner emits all of them in one package and uses `depends` to encode ordering, blockers, verification waits, or required sequential handoff. A broad task should not be collapsed into one worker just to avoid declaring dependencies.

## Package Agent Catalog

Package agents should be named by their actual routing role and behavior. The runtime keeps the coarse `kind` taxonomy for collaboration semantics:

- `planner`: decomposes work and declares protocol graphs.
- `helper`: gathers context or analyzes a bounded question without writing.
- `worker`: performs a bounded implementation, migration, release, or operations task.
- `verifier`: validates or reviews without writing.
- `system`: runtime-owned internal agents such as title, summary, compaction, and protocol runners.
- `skill`: imported compatibility skill templates.

The visible package catalog is intentionally small and purpose-based: `default`, `milestone-planner`, `feature-planner`, `general-executor`, `verifier`, `technical-reviewer`, `general-investigator`, `release-runner`, `docs-maintainer`, `multimodal-looker`, and `agent-creator`.

Retired or overly specific package agents remain installed but hidden. Hidden agents can still resolve historical `session.agent` bindings, but ordinary session selection, mention autocomplete, and default delegation candidate lists must not expose them. A hidden agent should be made visible again only through explicit management action.

Agent metadata may declare `identity_name`, `persona_name`, and `subtype`. Session-facing labels prefer `identity_name-persona_name`, then fall back to the template display `name`, then the agent id. Reviewer agents are not a top-level kind; they are `kind: "verifier"` plus `subtype: "review"`.

Planner flow uses `Milestone -> Feature -> Work Task`. New session titles should preserve derivation through prefixes: `M1 ...`, `M1-F1 ...`, and work-task prefixes such as `M1-F1-DEV`, `M1-F1-TEST`, `M1-F1-REVIEW`, `M1-F1-ARCH`, `M1-F1-RESEARCH`, or `M1-F1-RELEASE`.

Planners may use managed agent tools when the visible catalog is not specific enough. `agent_query` inspects existing templates, including hidden templates when requested. `agent_create` creates hidden, protocol-delegable project or user agents with a required `kind`, optional `subtype`, `identity_name`, and `persona_name`. Planner-created agents may be `planner`, `worker`, `verifier`, or `helper`; `system` and `skill` are reserved for runtime and compatibility import paths. Dynamic `worker`, `verifier`, and `helper` agents automatically receive the `action-protocol.md` request footer so parent sessions can collect terminal `ActionResult` handoffs.

## Agent Protocol Families

Model-facing agent protocols are split by agent execution role.

Planner and coordinator agents with `runner: "protocol"` load the planner protocol. Their only native output carrier is `AgentProtocolOutput`, and they declare runtime work graphs with `agent`, `tool`, `input`, `confirm`, `answer`, and terminal result items. They do not receive the action handoff contract as their protocol document.

Worker, helper, and verifier agents that execute delegated assignments load the action protocol through their request footer when the assignment has a `result_tool`. Their preferred handoff carrier is `ActionResult`, not `AgentProtocolOutput`. These agents do not declare planner DSL packages as their completion mechanism.

The split is based on the active agent runner and delegation assignment context, not merely whether a session has a parent. A parent-delegated planner still uses the planner protocol because it is expected to declare a child work graph. A worker or verifier uses the action protocol because it is expected to return one assigned action result.

Runtime accepts delegated terminal results by semantic meaning rather than by carrier family. A delegated child can complete its handoff with either a completed `ActionResult` tool call or a completed `AgentProtocolOutput` terminal item. The agent prompt still advertises the role's native carrier, but parent delivery, result storage, and dependency checks read the submitted terminal meaning.

`reply` is terminal but non-satisfying in both protocol families. It ends the current package or action handoff with a structured response, blocker, clarification request, or reroute request, but it does not mark the assigned goal as satisfied and must not satisfy ordinary downstream dependencies.

## Answer Dependencies

Agent Protocol v2 `answer` items are response metadata, not executable actions. When an executable v2 item names a same-package `answer` id in `depends`, normalization drops that dependency and lets the executable item run as independent work. Dependencies on missing executable ids remain invalid.

## User Input Questions

Agent Protocol v2 `input` items are runtime user-choice gates. Runtime maps them to human actions, emits a `Question.ask` request, and stores a matching `protocol.inputs` record in the parent session `dsl_context` before waiting for the reply.

Live replies still resolve the in-memory `Question.ask` deferred. If the page reloads, the app reconnects, or the server loses the live pending map, `/question` restores pending `protocol.inputs` records into normal question requests. Replying to a restored input updates that record to `answered`, stores the selected answers, and sends a continuation prompt into the same session with the captured answer text. Rejecting the restored input marks it `rejected` and resumes the session with an explicit dismissal note.

Restored protocol confirmations and inputs must acknowledge the HTTP reply immediately after the persisted record is updated and the matching `question.replied` or `question.rejected` event is published. The continuation prompt runs in the background. The UI must not wait for the next model request, provider queue slot, or streamed model output before removing the pending question card and showing the next session status.

When an `input` answer resumes the model, Runtime must present a resolved-input block near the start of the next request. The block lists the input action id, original question, mode, selected option ids, labels, descriptions, custom answers, and details exactly as captured. Runtime should not infer domain meaning from the option text; it only tells the model to treat the captured values as the answer to that input action and not ask the same question again unless the answer is missing, ambiguous, or unusable.

The session UI surfaces pending questions both in the timeline context and in the composer dock. The composer dock is the stable fallback: an actionable question must remain visible even if the active message changes or the timeline filter hides the original turn.

## Assignment Confirmation

Assignment is the persisted task-management record for a session. It is not a separate Agent Protocol item kind. Model output still uses ordinary protocol items, and assignment creation or content updates are expressed as metadata on `kind: "confirm"`.

For assignment creation or update, `confirm.plan` is the complete task content approved by the user. The optional `confirm.assignment` object only describes the runtime mutation, currently `op=create|update` and `target=self|<child-session-id>`. Runtime must not require a second task-body field that duplicates `plan`.

Assignment is not a hard prerequisite for clarification or exploratory delegation. A planner may ask questions or delegate read-only exploration before a root assignment exists. After the user intent is clear and the execution plan is designed, the planner should emit a final assignment confirmation before starting execution work, for example `assignment: { op: "create", target: "self" }`. A plain plan confirmation does not create an assignment.

Confirmed assignment content is stored as a raw Storage snapshot under `session_assignment_content/<assignment_id>/rev-<n>`. SQLite `assignment` rows keep the queryable projection only: session linkage, parent assignment id, source ids, target, title, status, content reference, content hash, content version, result reference, result status, and timestamps.

Parent-to-child delegation creates the child assignment from the parent `agent` action after the child session is created. The child does not ask the user to approve the same assignment again. The child assignment points back to the parent assignment when one exists, and its content comes from the delegated action prompt.

Dependent children launched while resuming a parent run follow the same rule as initially launched children: Runtime must create both the delegation record and the child assignment before prompting the child. A resumed child with delegation context but no active assignment is invalid, because its own downstream agent work would be rejected as unassigned execution.

## LLM Request Limits

LLM request acquisition is globally coordinated inside the server process before calling the provider SDK. The runtime supports two independent provider/model gates:

- `concurrency` limits active in-flight requests.
- `rpm` limits request starts in a rolling one-minute window.

Provider-level and model-level limits are both enforced when present. A request waits if any configured gate is full. Waiting sessions are marked `rate_limited` with `scope=provider|model`; RPM waits also include `kind=rpm` and a `reset` timestamp for the next local wake-up.

RPM capacity is consumed when the request is released from the local queue, immediately before the LLM call starts. This keeps failed, short, and long streams counted consistently as upstream request attempts.

The queue has a timer for RPM waits. Unlike concurrency, RPM capacity can become available without any active request finishing, so the limiter wakes itself when the oldest start exits the minute window.

Queued LLM requests carry the instance that created the queue item. Any `rate_limited`, queued-abort cleanup, or post-acquire `running` status update must run in that originating instance, even when an unrelated request in another project releases capacity and pumps the shared queue. This prevents one project directory from retaining stale provider/model limit status for a session owned by another directory.

Agent-level concurrency is separate from provider/model request limits. Planner defaults are conservative unless agent metadata overrides them: `default` is unlimited, `milestone-planner` runs one delegated task at a time, and `feature-planner` runs five. Worker agents remain unlimited at this layer unless their metadata declares a `concurrency` value; provider/model `concurrency` and `rpm` still gate the actual LLM request stream.

## Invalid Protocol Output Diagnostics

Protocol runner sessions use the native `AgentProtocolOutput` tool as the carrier for model output. If the provider returns malformed arguments for that tool, the LLM layer redirects the failed call to the internal `invalid` tool result.

The invalid result must preserve enough evidence for prompt and protocol debugging:

- the human-readable parser error,
- the raw protocol output fragment extracted from the parser error when present,
- metadata identifying the violation and the original tool name.

The UI can render the generic tool detail view from the result input, output, and metadata. Keeping the raw fragment in both output text and metadata makes the failure visible in the timeline and available in copied details.

The session processor also records the streamed tool-call arguments before schema parsing or repair changes the call shape. `tool-input-delta` chunks are accumulated on the pending tool part, then written to `tool.input.end` and the following `tool.start` log with `raw`, `rawBytes`, and `truncated`. The log payload is capped at 64 KiB so malformed protocol packets can be inspected without unbounded session logs.

Agent Protocol DSL v2 parsing tolerates only top-level `items` entries that are whitespace-only strings, such as `"\n"` inserted between valid objects. The parser drops those empty separators before schema validation, but it still rejects non-empty string entries and never rewrites prompt or message text.

Agent Protocol terminal result items accept `changed_files` as either a string array or a delimited string. String input is split on newlines, commas, and semicolons, trimmed, and normalized to the existing internal array shape before result-message rendering. This compatibility is limited to file-list input; executable `items`, dependencies, and prompt/message fields remain strict.

The model-visible native `AgentProtocolOutput` schema exposes only the current `{ version: "2", items }` shape. Runtime still parses stored or provider-leaked legacy `kind: "act"` / `calls` packets as an internal compatibility path, but that shape is not advertised in the tool schema and history slimming does not replay legacy `calls` arrays back into model context.

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

Unavailable agent dispatch is not a wait state. If a protocol action targets an agent that is not visible from the parent, such as a removed legacy package agent, or the target is denied by permission rules, runtime marks that action and run as `failed`. It must not create a child session, must not record a pending delegation, and must not put the parent into `waiting_child` for that action.

Child result delivery has three phases:

- write the canonical `ResultRecord` and raw result file as soon as Runtime accepts the task result;
- store only result references and minimal status projection in `completed_delegations`;
- notify the parent model only after all sibling child sessions for the run have ended.

Delivery and dependency satisfaction are separate. A child result can be delivered to the parent fan-in without satisfying downstream dependencies. Worker `ActionResult.status=success` satisfies an ordinary worker dependency. Verifier `success` and policy-allowed `skipped` satisfy verifier gates. `failure`, `error`, `reply`, fallback summaries, interrupted children, aborted children, user-completed partial results, and stale terminal child statuses are delivered results, but they do not satisfy ordinary dependent actions.

After storing a child result and removing that child from the parent pending set, runtime checks the parent run graph before submitting the aggregate handoff to the parent model. If a same-run agent action is neither pending nor already delivered, and every same-run dependency has a satisfying result, runtime starts that dependent child session immediately and keeps the parent in `waiting_child`. The parent model receives the aggregate handoff only when no pending child and no newly ready dependent action remain.

Planner children use the same delivery boundary with a different preferred native carrier. A delegated planner whose agent runner is `protocol` is prompted to complete the child handoff through terminal `AgentProtocolOutput` items. Worker/helper/verifier children are prompted to use `ActionResult` through the action protocol footer. At result ingestion time, runtime accepts both structured carriers for either assignment family and maps status from the terminal semantics: `success`, `answer`, and `done` are delivered and satisfying; `reply` is delivered as `terminal_reply` and non-satisfying; `failure` and `error` are delivered and failed/non-satisfying.

`ResultRecord` is the canonical result index. The database projection stores only the minimal fields needed by Runtime: carrier, status, satisfying flag, session ids, run id, action id, target action id, raw result reference, short summary, and creation time. Full task-result payloads are stored as raw result files. Parent `completed_delegations`, child `dsl_context.result`, UI state, and dependency routing should keep `result_id` / `raw_ref` references instead of copying the full result object. The tuple `(parent_session_id, child_session_id, run_id, action_id)` is unique when all four values exist, so repeated projection of the same child handoff updates the same logical result instead of creating competing completed/blocked rows.

Accepted terminal carrier status is authoritative for the delegated child result. Message finish reasons such as `finish=tool-calls` only indicate how the assistant turn ended; they must not overwrite a parsed `ActionResult.status=reply` into `completed`. After a child handoff is stored, later idempotent completion or notification paths preserve the child `protocol.delegation` result projection fields, including `result_id`, `status`, `completed_at`, `completed_message_id`, `output_ref`, and `summary`. A later user-originated turn in the same child session is the boundary that can start a new result round.

For `ActionResult`, the raw result file stores the accepted tool input/output and trace location. For `AgentProtocolOutput`, the raw result file stores only the accepted terminal result item plus location metadata, not the full protocol `items` package. Planning, dispatch, confirmation, input, and other non-result items are not task result records.

Current `packages/opencode` implementation uses `session_result` as the normalized database projection and `session_result_raw/<result_id>.json` as the raw payload file. The store API is `SessionResult` in `src/session/result.ts`; delegation writes it before parent fan-in, dependency launch, or runtime `session_result` detail reads. It also records a deduped `session_event_outbox` `parent_handoff` event before notifying the parent, then marks that event delivered after the parent pending/completed projection is updated.

Ordinary failed worker actions do not create generic runtime repair tasks by themselves. Runtime records the failed, blocked, partial, fallback, or terminal child result, waits for already-started sibling child sessions in the same run, and then sends the aggregate handoff to the parent model. The parent model decides whether to declare a repair action, skip or reroute work, ask the user, or report failure upward. Runtime-owned automatic repair is limited to explicit mechanisms such as protocol package regeneration after dependency validation failure, malformed `ActionResult` fallback summary, and verifier-gate fix loops.

If a remaining pending child is terminal, such as `interrupted`, `aborted`, `failed`, `timeout`, `error`, or `blocked`, Runtime records a synthetic delegation result with the child session status and removes it from pending. The parent summary then mentions that status instead of waiting indefinitely.

Prompt-loop finalization also treats terminal pending children as stale wait records. Before writing `waiting_child`, runtime rechecks pending child statuses and drops terminal children from `pending_delegations`. A later turn must not inherit `waiting_child` only because an older interrupted child record remains in the parent DSL context.

Delegated child `SessionStatus` changes are also parent fan-in triggers. When a child session reaches any terminal status, Runtime looks up its delegation assignment and runs the same parent-run submit path used by manual delegation submit. This path claims the run, records synthetic ResultRecords for terminal children that never produced a native carrier, removes stale pending rows, and notifies the parent once. A terminal child status alone must not leave the parent waiting forever.

Manual delegation submit uses the same aggregate handoff path. The submit route accepts a parent session and run id, records current pending child statuses as synthetic ResultRecords when forced, removes those children from the pending set, and sends one collected Markdown handoff to the parent. Later child completions for that run do not notify the parent again after the run has been claimed.

For manual terminate-and-summarize, a child whose current session status is already `completed` keeps that status. Runtime first looks for a canonical ResultRecord. If one exists, Runtime reuses that result reference for the parent aggregate handoff without creating a summary session. If no ResultRecord exists, Runtime may run a repair path that parses terminal result carriers from the transcript or creates a transcript-based partial summary, then persists the repaired ResultRecord before fan-in. Normal runtime reads should not scan parent completed rows, child context payload copies, or transcript text as result sources.

Delegation cancellation is a stronger manual handoff. Runtime writes a visible control message into each pending child session, cancels its active prompt, marks the child `aborted`, then force-submits the parent run through the same aggregate handoff path. This keeps the child session inspectable and makes the user cancellation explicit to both the child timeline and the parent summary.

The parent handoff prompt is Markdown prose, not JSON. It includes run counts, child session ids, action ids, agents, statuses, and summaries so the parent can continue naturally or produce the final user-facing answer.

`user_completed` is distinct from runtime `completed`. It means the user decided the session no longer needs runtime work, even if the previous state was waiting, blocked, interrupted, failed, paused, aborted, or partially complete. Runtime records it through `SessionStatus.set()` and status-change logs, but must not treat it as proof that the model or delegated task produced a normal final result. When a child session with `user_completed` is included in a forced delegation handoff, the handoff reports a partial/manual result rather than a natural completion.

## Request Turn State

Prompt requests are tracked as explicit turns on user message metadata. A turn records whether that single request is `queued`, `running`, or `done`; it does not represent the entire session lifecycle.

A session may execute only one turn loop at a time. When a prompt arrives while `SessionPrompt` already owns that session, runtime creates a queued user message and attaches it to the existing loop callback queue; it must not start a second loop for the same session. Busy prompt admission must also avoid history-mutating side effects such as revert cleanup, turn repair, model binding, or permission writes, because the active processor may still be writing assistant parts that reference existing message rows.

Queued user messages can be cancelled individually only while their turn metadata remains `status=queued`. This cancellation deletes the queued user message and its parts and removes the matching in-memory loop callback. It must not stop the currently running turn, and it must reject attempts to delete running or done turns through the queued-message route.

## Session Status Authority

Runtime stores the current session lifecycle projection on the `session` row. The queryable fields are `status_class`, `status`, `status_message`, `status_recoverable`, `status_updated_at`, `status_source`, and `status_detail`. Legacy `session_status/<session_id>.json` files are not read during status restore and must not affect current state. They may remain on disk as historical artifacts, but the database is the only source for current lifecycle state.

Status classes are coarse control categories: `active`, `blocked`, `interrupted`, `terminal`, and `archived`. `active` covers queued, starting, and running work. `blocked` means the session is waiting for an external event such as user input, permission, a child result, rate-limit capacity, concurrency capacity, or a retry due time; bootstrap does not auto-run these states as if they were interrupted execution. `interrupted` means process shutdown interrupted resumable work and may be auto-continued after stale tool checks. `terminal` means the current execution round ended; `terminal_reply` is the terminal non-satisfying result used for delegated replies. `archived` is the only terminal class that forbids continuation.

Starting a new request is valid from every non-archived stopped state. A continued session may move through `queued`, `starting`, `running`, or `rate_limited` before the next provider request begins, even when the previous round ended as `failed`, `blocked`, `aborted`, `terminal_reply`, or `user_completed`. `archived` remains the only state that rejects direct continuation into active or rate-limit wait states.

Session tree resume has two modes. `restore` restarts the existing loop without adding a user message and is limited to `interrupted`, `queued`, `rate_limited`, `retry`, `running`, `starting`, and explicitly recoverable transport failures. A recoverable transport failure is a stopped `error`, `timeout`, or delegated `failed` status with `reason=transport` and `recoverable=true`, such as provider connection loss or SSE read timeout; restoring it replays the previous loop after the network recovers. Other stopped states such as ordinary `error`, ordinary `failed`, `blocked`, `paused`, and `aborted` require `message` mode so the runtime appends an explicit resume instruction and the model can decide whether to continue or report a blocker. `completed`, `terminal_reply`, and `user_completed` also require `message` mode plus `include_completed`; `archived` is skipped.

Bootstrap restores status from DB before delegation recovery runs. If memory has no entry for a session, `SessionStatus.get()` may load the DB projection once instead of inventing an `idle` state. This prevents recovery from logging misleading `idle -> blocked` or `idle -> terminal` transitions for sessions that already had persisted status. Active substatuses such as `queued`, `starting`, `running`, and `aborting` carry their structured status payload in `status_detail`; active rows without that detail are treated as legacy shadow data, not authoritative live work.

Delegated child status restore also checks `dsl_context.result` before converting stale active rows into `interrupted` or dropping idle rows. When that result is a terminal `session.action_result`, restore maps it back to the corresponding terminal session status, such as `terminal_reply`, `failed`, `blocked`, or `completed`. Restore skips this recovery if the child has a later user message than the stored result timestamp, because that later user turn represents a new execution round.

`waiting_child` is valid only while the parent DSL context still has live `protocol.pending_delegations`. Status restore and lazy status load reconcile stale DB projections: an empty pending set, or a pending set whose child rows are already terminal, is repaired to `completed`; mixed live and terminal children keep `waiting_child` with the live child count.

`waiting_user` and `waiting_child` are done outcomes for the current turn. The session status remains `waiting_user` or `waiting_child` so the title bar, session tree, and prompt dock can still show the broader wait state.

Failed assistant completion is also a done turn. If the assistant message has `time.completed` and an error, Runtime writes the user turn as `status=done`, `outcome=error`, and `reason=error`. The failure remains visible through the assistant error and session status; the prompt loop must not leave the user turn unfinished and rely on a future request to retry it implicitly.

Provider output safety failures are classified separately from protocol parser failures. When a provider stream reports a MiniMax-style error such as `output new_sensitive (1027)`, Runtime stores an `APIError` with metadata `code=ProviderOutputSafety` and sets session status to `error` with `reason=output_safety` and `recoverable=true`. This status is not auto-continued in the background, because replaying the same provider request can hit the same policy block. The session UI instead exposes a user-driven continue option that sends a shorter continuation prompt into the same session.

On process restart, persisted `running` and `starting` session statuses restore as `interrupted` with their prior active state. Bootstrap automatically continues active resumable states, including `queued`, `rate_limited`, `retry`, and `interrupted` sessions whose prior state was `running` or `starting` and whose tool parts are not stale. If recovery finds a pending or running tool part that stopped before finish or error was recorded, Runtime marks that tool part stale and leaves the session for explicit user continuation instead of replaying work automatically.

Terminal assistant completion is also a done turn. If an assistant message has a terminal finish reason such as `stop` and no pending tool call, runtime action, compaction, user gate, or child wait remains, Runtime must finish the source user turn before evaluating later queue work. A complete text response is not a continuation signal by itself; only new tool results, runtime actions, compaction work, queued user messages, or wait states may drive another model request.

Turn completion is written by runtime boundaries:

- protocol response or final answer after `AgentProtocolOutput` is parsed and executed,
- delegated child dispatch after the run reaches a wait-for-child boundary,
- confirm/input gates after the runtime has created the user-facing request,
- accepted `ActionResult` records after delegation routing stores the result,
- assistant completion for non-protocol and legacy turns, including errored assistant messages with `time.completed`.

`ActionResult` is a terminal native tool for delegated child sessions. Its assistant message commonly finishes with `finish=tool-calls`, because the model ended the step by calling the tool. Runtime must still treat that message as a valid delegation result: store the `session.action_result`, finish the source user turn with `reason=action_result`, and stop the prompt loop instead of asking the model for another assistant step.

Delegated task prompts must include a concrete native `ActionResult` argument example. Worker task results use `action_id`, `status`, `result`, and optional `scope`, `changed_files`, `verification`, and `blockers` string fields. Verifier results use `action_id`, `target_action_id`, `status`, `result`, and optional `issues`, `evidence`, and `worker_feedback` string fields. The example is part of the runtime contract because provider tool-call behavior can degrade when the model only receives prose field descriptions.

Agents can declare a per-request footer through `request_footer` metadata. The footer can be inline text or a file under the shared `config/request-footers/` directory. Runtime renders it with variables such as `session_id`, `agent`, `mode`, `action_id`, `target_action_id`, `result_tool`, and `action_result_example`, then appends it only to the outbound provider request. The rendered footer is not inserted into persisted session history. This keeps the reminder current for every retry or continuation without polluting the conversation log.

Runtime derives the result branch from the submitted shape: verifier results include `target_action_id`, while worker results do not. Stale fields such as `role`, `result_type`, `kind`, and `summary` are ignored during input parsing rather than treated as protocol instructions; `summary` is not mapped into `result`, so a valid call still needs an explicit `result`. After a native tool call is accepted, runtime stores an internal normalized result with `kind` and `role` for routing; that storage shape is not part of the model-facing input protocol. `ActionResult.status` uses one shared vocabulary for worker and verifier results: `success`, `failure`, `error`, `reply`, or `skipped`. Legacy verifier inputs using `pass` or `fail` are normalized to `success` or `failure` before storage and routing. When schema parsing fails, the tool error returned to the model must restate the strict direct-argument protocol, worker/verifier required fields, valid statuses, and an example.

Delegated sessions derive the native `ActionResult` schema from assignment context before tool execution. Worker child sessions use the worker input schema even if the model includes stray verifier-only fields such as `target_action_id`; verifier child sessions use the verifier input schema. The storage path also guards historical or already-normalized self-target verifier-shaped worker results: if a non-verifier child stores `action_id` and `target_action_id` as the same assigned action, Runtime normalizes the handoff back to a worker result before updating parent dependencies. This keeps verifier gates from being mistaken for worker completion while preventing worker retries from stranding their own action as unfinished.

Verifier child sessions may accept a retry result that omits `target_action_id` when runtime can infer the worker action from assignment metadata, dependencies, or the verifier action suffix such as `_test` / `_review`. Runtime fills that target before storage so the result is still routed as a verifier gate result, not as a worker completion.

If repeated malformed `ActionResult` attempts leave a delegated child blocked or failed, Runtime first tries to preserve the child context with an automatic fallback summary. It creates an independent child-of-child session with the hidden `summary` agent, gives that session the original assignment, terminal failure reason, and bounded transcript evidence, and asks for plain Markdown text only. The summary is stored through the normal delegation result path with metadata `source: "fallback_summary"` and `confirmed_by_user: false`. It remains a failed or partial handoff, not a native successful `ActionResult`, so verifier gates and worker-success routing must not treat it as a pass.

The user can still submit a reviewed fallback result. Runtime previews the child's latest assistant text, accepts the edited text and selected fallback status, wraps it with metadata that identifies it as a `user_confirmed_fallback`, stores it through the normal delegation result path, notifies the parent session, and marks the child `user_completed`. The parent sees that the result was user-reviewed fallback content rather than a native model tool result.

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
