# Agent Protocol DSL v1 Execution Plan

Date: 2026-05-22
Branch: `agent-protocol-dsl-v1-spike`

## Request Type

Implementation plan for Agent Protocol DSL v1.

The goal is to implement a first usable protocol path that replaces or abstracts the current low-level `toolCall` control surface for selected agents. Existing workflow remains a reference implementation and compatibility path. It is not the only target and should not be rewritten as part of v1 unless a task explicitly says so.

## Scope

In:

- A versioned `agent.protocol` declaration schema and parser.
- One protocol-enabled runner path for selected agents.
- A minimal action graph execution model.
- Structured protocol result messages returned to the model.
- Full structured runtime logs that can be exported and compared with ordinary tool-call traces.
- UI elements that make protocol runs visible in the right side panel.
- Focused tests and typechecks from package directories.

Out:

- Upstream migration.
- Replacing the existing workflow DSL.
- Streaming protocol execution before assistant message completion.
- Arbitrary expressions, scripting, or unbounded loops.
- Automatic protocol execution for every agent.
- Full restart recovery beyond what is explicitly needed for v1 logs and projection.

## Implementation Status

Implemented in `agent-protocol-dsl-v1-spike`:

- T1/T2: versioned `agent.protocol` schema and fenced `agent-protocol` parser with section refs.
- T3: explicit `protocol` runner type and packaged `protocol-runner` agent.
- T4/T5: minimal read-only sequential executor with side-effect blocking and concise protocol result parts.
- T6: v1 agent executor selection using agent `entry` and `capability` metadata, projected as normalized protocol action results. Full child-session task delegation is intentionally left as the next hardening step.
- T7: session log events plus `GET /session/:sessionID/protocol/:runID/trace` export, with regenerated JS SDK.
- T8/T9: right-side `Protocol` tab, action/detail/comparison view, and readable protocol log timeline stats.
- T10: replay keeps concise protocol result text while app-only protocol metadata is filtered out of provider metadata.
- T11: focused backend/frontend validation scenarios cover parser, runner, logs/export, UI tab/log behavior, and package typechecks.

## Architecture Direction

Use a new protocol layer beside workflow:

```txt
assistant text
  -> protocol parser detects one ```json agent-protocol block
  -> protocol runner validates declaration
  -> protocol executor resolves semantic actions
  -> runtime executes actions through existing tools/agents/runtime ops
  -> protocol result is written as an assistant part
  -> SessionLog records full declaration/action/tool/result events
  -> UI projects concise run state and can export complete logs
```

Do not make protocol a new tool. The key experiment is whether structured model declarations can replace the need for the model to micromanage many tool calls.

Recommended new package area:

- `packages/opencode/src/protocol/schema.ts`
- `packages/opencode/src/protocol/parser.ts`
- `packages/opencode/src/protocol/executor.ts`
- `packages/opencode/src/protocol/log.ts`
- `packages/opencode/src/protocol/project.ts`

Existing integration areas:

- `packages/opencode/src/agent/schema.ts`
- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/log.ts`
- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/tool/registry.ts`
- `packages/opencode/src/server/routes/session.ts`
- `packages/app/src/pages/session/session-side-panel.tsx`
- `packages/app/src/pages/session/session-log-timeline.tsx`

## Task Plan

### T1. Define v1 Schema And Fixtures

Goal: make the protocol contract executable before wiring runtime behavior.

Likely areas:

- `packages/opencode/src/protocol/schema.ts`
- `packages/opencode/test/protocol/schema.test.ts`
- `docs/agent-rewrite/10-agent-protocol-dsl.md`

Depends on: none.

Acceptance:

- Schema accepts exactly `type: "agent.protocol"` and `version: "1"`.
- v1 supports `intent: "execute"`, `persist`, `title`, `execution.strategy`, and `payload.type: "action_graph"`.
- v1 action fields are validated: `id`, `title`, `description`, `operation`, `executor`, `depends_on`, `context_refs`, `prompt_ref`, `result_policy`.
- Executor schema supports `tool`, `agent`, `runtime`, and `human`, but marks unsupported execution as a runtime decision rather than a schema failure.
- Invalid duplicate action ids, missing dependencies, and unsupported payload types fail with clear errors.
- Tests cover valid minimal, valid full, invalid envelope, invalid action graph, and invalid dependency fixtures.

Must not:

- Add execution behavior.
- Add database migrations.
- Infer workflow-specific fields into the core schema.

### T2. Parse Protocol Blocks From Assistant Output

Goal: reliably detect and parse one explicit protocol declaration from an assistant response.

Likely areas:

- `packages/opencode/src/protocol/parser.ts`
- `packages/opencode/src/session/runner.ts`
- `packages/opencode/test/protocol/parser.test.ts`

Depends on: T1.

Acceptance:

- Parser recognizes only fenced blocks with info string containing `agent-protocol`.
- Parser rejects multiple protocol blocks in one assistant response.
- Parser ignores protocol-looking JSON in ordinary text when the fence marker is absent.
- Parser returns markdown sections by id for `md:` references.
- Parser returns structured errors with machine-readable code and user-safe text.
- Tests prove parser does not accidentally execute current workflow JSON blocks.

Must not:

- Treat arbitrary JSON as protocol.
- Parse protocol for agents that are not protocol-enabled.

### T3. Add Protocol Runner Eligibility

Goal: enable protocol only for explicitly configured agents.

Likely areas:

- `packages/opencode/src/agent/schema.ts`
- `packages/opencode/src/agent/loader.ts`
- `packages/opencode/src/agent/agent.ts`
- `packages/opencode/src/session/runner.ts`
- `packages/opencode/config/agents/protocol-runner/*`
- `packages/opencode/test/agent/schema.test.ts`
- `packages/opencode/test/agent/loader.test.ts`

Depends on: T1, T2.

Acceptance:

- Agent runner enum includes a new explicit value, preferably `protocol`.
- A packaged `protocol-runner` agent exists and is hidden or opt-in by default if needed.
- `SessionRunner.select()` can return `chat`, `workflow`, or `protocol`.
- Ordinary chat and workflow agents keep current behavior.
- Tests show protocol blocks emitted by chat agents are treated as text.
- Tests show protocol blocks emitted by `protocol-runner` are routed to the protocol path.

Must not:

- Change workflow-runner behavior.
- Make protocol the default runner.

### T4. Build Read-Only Executor Registry

Goal: expose a constrained v1 executor registry that can map semantic protocol actions to existing capabilities without giving the model raw authority.

Likely areas:

- `packages/opencode/src/protocol/executor.ts`
- `packages/opencode/src/tool/registry.ts`
- `packages/opencode/src/agent/registry.ts`
- `packages/opencode/test/protocol/executor.test.ts`

Depends on: T1.

Acceptance:

- Registry can describe available executors with `type`, `target`, `capabilities`, `description`, `side_effects`, and `requires_approval`.
- v1 implements safe read-only runtime actions first, such as:
  - `search` through grep/glob style tool execution
  - `read` through read tool execution
  - `summarize` through runtime-only aggregation
- Agent executor selection can resolve `target: "auto"` using agent capability metadata, but may return `unsupported` until T6.
- Write/edit/bash/publish/external side effects are rejected or blocked by policy in v1 unless explicitly added later.
- Tests show unsupported executors produce protocol result status `blocked` rather than falling back to raw tool calls.

Must not:

- Let protocol bypass existing tool permissions.
- Register protocol as a normal model-callable tool.

### T5. Implement Ephemeral Sequential Protocol Runs

Goal: execute a minimal action graph and return a structured result to the model.

Likely areas:

- `packages/opencode/src/protocol/executor.ts`
- `packages/opencode/src/protocol/project.ts`
- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/test/protocol/executor.test.ts`
- `packages/opencode/test/session/protocol-runner.test.ts`

Depends on: T2, T3, T4.

Acceptance:

- v1 supports one assistant protocol declaration per assistant message.
- v1 supports `execution.strategy: "sequential"` and action `depends_on`.
- Runtime writes an assistant text part with metadata `{ kind: "protocol", action: "completed" | "blocked" | "failed", protocol: ... }`.
- Runtime result wrapper has `type: "agent.protocol.result"`, `version: "1"`, `run_id`, action statuses, summaries, artifact refs, and failure/block reason when applicable.
- Model-visible result is concise and does not include every raw tool output by default.
- Full action output is available through logs/export, not stuffed into the next model prompt unless policy asks for it.
- Tests compare a protocol run with equivalent direct tool calls and assert fewer or more structured model-visible parts.

Must not:

- Persist durable runs by default.
- Execute writes or shell commands in v1 unless a later task explicitly expands scope.

### T6. Add Agent Delegation As A Protocol Executor

Goal: support semantic agent actions without exposing them as raw task tool calls.

Likely areas:

- `packages/opencode/src/protocol/executor.ts`
- `packages/opencode/src/tool/task.ts`
- `packages/opencode/src/tool/agent.ts`
- `packages/opencode/src/agent/registry.ts`
- `packages/opencode/test/protocol/agent-executor.test.ts`

Depends on: T4, T5.

Acceptance:

- Protocol can run an action with `executor.type: "agent"` and `target: "auto"` or a concrete agent id.
- Auto-selection uses existing `capability.purpose`, `tags`, `cost`, and `writes`.
- Delegated agent result is normalized into protocol action result fields: `summary`, `status`, `artifacts`, `logs_ref`.
- Full child session/tool trace is linked in exportable logs.
- Tests cover successful delegation, no matching agent, hidden/non-delegable agent, and child failure.

Must not:

- Reimplement the task tool wholesale.
- Let protocol agent delegation bypass agent entry/permission rules.

### T7. Add Protocol Logs And ToolCall Comparison Export

Goal: make complete runtime traces extractable and comparable with ordinary toolCall traces.

Likely areas:

- `packages/opencode/src/protocol/log.ts`
- `packages/opencode/src/session/log.ts`
- `packages/opencode/src/server/routes/session.ts`
- SDK generation after API shape changes
- `packages/opencode/test/session/log.test.ts`
- `packages/opencode/test/server/session-messages.test.ts`

Depends on: T5.

Acceptance:

- SessionLog emits protocol events:
  - `protocol.detected`
  - `protocol.validated`
  - `protocol.started`
  - `protocol.action.started`
  - `protocol.action.tool_call`
  - `protocol.action.completed`
  - `protocol.action.blocked`
  - `protocol.action.failed`
  - `protocol.completed`
  - `protocol.failed`
- Each protocol action log includes `runID`, `actionID`, semantic `operation`, executor info, status, duration, and `toolCallIDs` when underlying tools were used.
- Existing `tool.start` / `tool.finish` logs remain unchanged for direct tool calls.
- New export endpoint or existing log endpoint can return a complete JSON trace for one session/run.
- Export shape includes enough data to compare:
  - number of model-visible tool calls
  - number of runtime-internal tool calls
  - input/output token totals when available
  - raw tool output bytes
  - model-visible result bytes
  - duration per action/tool
  - failure/block reasons
- Tests create one protocol run and one direct tool-call run fixture and verify comparison metrics are computed deterministically.

Must not:

- Remove existing session log retention behavior.
- Store secrets or full sensitive outputs without the same redaction policy as existing logs.

### T8. UI Protocol Run Panel

Goal: make protocol runs visible and inspectable without exposing raw logs by default.

Likely areas:

- `packages/app/src/pages/session/session-side-panel.tsx`
- new `packages/app/src/pages/session/protocol-panel.tsx`
- `packages/app/src/pages/session/helpers.ts`
- `packages/app/src/pages/session/helpers.test.ts`
- `packages/app/src/i18n/en.ts`
- `packages/app/src/i18n/zh.ts`

Depends on: T5, T7.

Acceptance:

- Right side panel gets a `Protocol` tab when session has protocol run metadata or protocol logs.
- Tab trigger shows compact run status, for example `Protocol 3/5`.
- Panel shows:
  - run title and status badge
  - action graph list with status icons
  - selected action detail
  - executor type/target/capabilities
  - summary/result
  - artifact/log refs
  - blocked/failure reason
- UI has a clear control to view/copy/export the full protocol trace JSON.
- UI has a comparison section that shows protocol metrics next to underlying toolCall metrics.
- Existing `Review`, `Logs`, `Workflow`, file tabs, and context tab behavior remains unchanged.
- Tests show `Protocol` tab is not treated as a sortable file tab and falls back correctly when hidden.

Must not:

- Put protocol UI inside the workflow panel.
- Display raw protocol JSON as the primary experience.

### T9. UI Log Timeline Enhancements

Goal: make protocol events readable in the existing Logs tab.

Likely areas:

- `packages/app/src/pages/session/session-log-timeline.tsx`
- `packages/app/src/pages/session/session-log-timeline.test.ts`
- `packages/app/src/i18n/en.ts`
- `packages/app/src/i18n/zh.ts`

Depends on: T7.

Acceptance:

- `describeLog()` maps protocol events to readable labels.
- Log stats distinguish direct tool calls from protocol-internal tool calls.
- Details view can expand protocol declaration/result data.
- Timeline keeps existing merge and scroll behavior.
- Tests cover each protocol event summary and stats aggregation.

Must not:

- Break existing workflow, LLM, permission, memory, or tool log descriptions.

### T10. Protocol Prompt And Result Replay Policy

Goal: make the model see the right amount of protocol history.

Likely areas:

- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/config/agents/protocol-runner/rules.md`
- `packages/opencode/test/session/message-v2.test.ts`
- `packages/opencode/test/agent/prompt-integration.test.ts`

Depends on: T5, T7.

Acceptance:

- Protocol runner prompt explains when to emit protocol and when to answer normally.
- Model replay includes concise protocol result wrappers.
- Full raw logs are omitted from normal model replay unless explicitly requested through a protocol reference.
- Provider metadata filtering remains safe and does not leak app-only protocol metadata into AI SDK provider metadata.
- Tests assert protocol metadata is preserved for UI/log use but not sent as provider metadata.

Must not:

- Increase prompt noise by replaying every runtime-internal tool call to the model.
- Change normal chat replay behavior for non-protocol agents.

### T11. End-To-End Validation Scenario

Goal: prove v1 works on a realistic read-only task and can be compared against direct toolCall behavior.

Likely areas:

- `packages/opencode/test/protocol/e2e.test.ts`
- `packages/app/e2e` or focused component tests if available
- docs under `docs/agent-rewrite/`

Depends on: T5, T7, T8, T9, T10.

Acceptance:

- Scenario A: direct toolCall agent performs a small repo-inspection task.
- Scenario B: protocol-runner performs the same task using protocol action graph.
- Exported comparison shows direct model-visible tool calls versus protocol-internal action/tool records.
- Protocol UI displays the run and allows exporting/copying the full trace.
- Final assistant answer is grounded in protocol result summaries.
- Focused package checks pass:
  - from `packages/opencode`: `bun typecheck`
  - from `packages/opencode`: focused protocol/session tests
  - from `packages/app`: `bun typecheck`
  - from `packages/app`: focused session panel/log tests
- If SDK API changed, JS SDK is regenerated with `./packages/sdk/js/script/build.ts`.

Must not:

- Depend on external network.
- Require running tests from repo root.

## Suggested Sequencing

Milestone 1: Contract only

- T1 Schema
- T2 Parser
- T3 Runner eligibility

Milestone 2: Minimal useful runtime

- T4 Executor registry
- T5 Ephemeral sequential protocol runs
- T10 Replay policy first pass

Milestone 3: Observability and comparison

- T7 Protocol logs and export
- T9 Logs tab enhancements

Milestone 4: Product visibility

- T8 Protocol panel
- T11 End-to-end validation

T6 agent delegation can be done after T5 or postponed until after T7 if logs/comparison are more important for the first demo.

## UI Design Requirements

Protocol tab:

- Use the existing right side panel tab system.
- Add a `Protocol` tab only when protocol runs exist.
- Keep it distinct from `Workflow`; do not reuse workflow labels for protocol concepts.
- Default content should show a scan-friendly action list, not raw JSON.

Suggested visual structure:

```txt
Protocol
Run: Review Toolbar             completed
3 / 3 actions                   4 internal tool calls

[completed] Inspect files       tool:auto
[completed] Review controls     agent:auto
[completed] Summarize           runtime:summarize

Action detail
Title
Operation / Executor / Duration
Summary
Artifacts
Internal tool calls

[Export trace] [Copy comparison]
```

Comparison widget:

- Direct toolCalls: count, model-visible bytes, raw output bytes.
- Protocol: action count, internal tool call count, model-visible result bytes, raw output bytes.
- Delta: model-visible trace reduction and duration.

Logs tab:

- Keep chronological detail.
- Add readable protocol event names.
- Allow expanded JSON details per event.

## Log And Export Contract

Minimum export shape:

```json
{
  "session_id": "ses_x",
  "run_id": "apr_x",
  "type": "agent.protocol.trace",
  "version": "1",
  "declaration": {},
  "result": {},
  "actions": [
    {
      "id": "inspect",
      "operation": "search",
      "executor": { "type": "tool", "target": "grep" },
      "status": "completed",
      "summary": "...",
      "tool_call_ids": ["call_x"],
      "duration_ms": 123
    }
  ],
  "tool_calls": [
    {
      "call_id": "call_x",
      "tool": "grep",
      "status": "completed",
      "input": {},
      "output_ref": "log://...",
      "output_bytes": 1000
    }
  ],
  "metrics": {
    "actions": 3,
    "internal_tool_calls": 4,
    "direct_model_tool_calls": 0,
    "model_visible_bytes": 1200,
    "raw_output_bytes": 9000,
    "duration_ms": 2000
  }
}
```

The comparison baseline for direct toolCall sessions can be computed from existing `tool.start`, `tool.finish`, `llm.start`, and `step.finish` logs.

## Acceptance Summary

v1 is accepted when:

- A protocol-enabled agent can emit one explicit `agent-protocol` block.
- Runtime validates it, executes at least a read-only sequential action graph, and returns a concise protocol result.
- Existing direct tool calls still work unchanged.
- Full protocol logs can be exported from the session.
- UI shows a protocol run as a first-class visual object.
- UI/export can compare protocol execution with normal toolCall traces.
- Focused backend and frontend tests pass from package directories.

## Risks

- Tool execution is currently tied to AI SDK tool-call flow; calling tools internally from protocol executor may require a small adapter to reuse permission, truncation, and metadata behavior.
- If protocol results are stored as normal text parts, replay filtering must be precise or model context noise will return through the back door.
- UI can become crowded if protocol, workflow, logs, review, and files are all visible. The protocol tab should appear only when useful.
- Full logs may contain sensitive raw outputs. Export must respect the existing log and redaction posture.
- Agent delegation may be larger than expected because task tool behavior, child sessions, and permission inheritance need to stay intact.

## Open Decisions

- Should v1 implement only `tool` and `runtime` executors first, postponing `agent` executor to v1.1?
- Should protocol run state live only in `SessionLog` plus assistant part metadata for v1, or also in `session.dsl_context`?
- Should export be a new route like `/session/:id/protocol/:runID/trace` or a filtered extension of session logs?
- Should the comparison baseline require running the same task twice, or should UI compare protocol-internal calls against what the model would have seen in the same session?
- Which operations are allowed in the first demo: only `search/read/summarize`, or also `run_tests` through bash with approval?

## Immediate Next Step

Start with T1 and T2. They are small, testable, and will force the protocol grammar to become concrete before runtime wiring begins.
