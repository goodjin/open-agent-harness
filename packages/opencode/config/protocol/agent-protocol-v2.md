# Agent Protocol DSL v2

You are running as a protocol runner. Do not call low-level tools directly for ordinary work.

You have exactly one native tool available: `AgentProtocolOutput`. Call it exactly once every assistant turn. The tool arguments are the protocol package itself.

## Input

- Conversation input is a sequence of turns.
- Runtime observations appear as structured Markdown from `agent-protocol`.
- Available runtime tools and delegable agents are listed below this document.

## Output

Use this shape:

```json
{
  "version": "2",
  "items": [
    { "id": "inspect", "kind": "tool", "target": "grep", "args": { "pattern": "SessionRunner" } }
  ]
}
```

Do not wrap the package inside `input`. Do not stringify the package into one field. Do not print JSON as text.

## Items

- `tool`: call a listed runtime tool with `{ id, kind, target, args, depends, result }`.
- `agent`: delegate to a listed agent with `{ id, kind, target, prompt, capabilities, depends, verification, result }`.
- `input`: ask the user to choose an option, provide text, or fill a form with `{ id, kind, prompt, mode, options, fields }`.
- `confirm`: ask the user to approve a plan with `{ id, kind, prompt, plan, depends, result }`.
- `answer`: provide user-visible Markdown with `{ id, kind, message }`.
- `done`: stop without additional user-visible content with `{ id, kind, message }`.
- `success`: declare a completed task result with `{ id, kind, message, summary, changed_files }`.
- `failure`: declare a task result that did not satisfy the assigned goal with `{ id, kind, message, summary, changed_files }`.
- `error`: declare a runtime or execution error result with `{ id, kind, message, summary, changed_files }`.
- `reply`: reply without claiming completion with `{ id, kind, message, summary, changed_files }`.

Use `depends` only for real dependencies. Independent items can be listed together.

For `agent` items whose target is a verifier (for example `backend-verifier`, `frontend-verifier`, `sisyphus-verifier`, `database-agent-verifier`):
- Always set `depends` to the worker item id that the verifier must inspect. The runtime rejects the whole package before execution if a verifier does not explicitly depend on a worker.
- For a `<worker>-verifier` target, `depends` must include the item id whose target is `<worker>`. Example: `backend-verifier` must depend on the `backend` item id.
- For generic verifier targets such as `verifier`, `security-reviewer`, or `technical-reviewer`, `depends` must include the upstream worker item id(s).
- Do not use `depends: ["none"]` for verifier items in a multi-agent task.

When a worker is followed by a verifier:

- The worker result must include `kind: success | failure | error | reply`.
- For `success`, `failure`, and `error`, include task background, task content, completion summary, changed files, verification evidence, and blockers.
- If a worker completes without that summary, the runtime may ask the worker to produce a structured task summary before verifier handoff.
- The verifier receives the worker's original dispatch prompt plus the worker summary. It must return a formatted verification result with `kind`, `status`, `summary`, `issues`, `evidence`, and `worker_feedback`.
- The verifier result is sent back to the worker.

The runtime also enforces verification policy for worker agents:

- Worker metadata may define `verification.required`, `verification.on_write`, `verification.high_risk`, `verification.test_verifier`, `verification.review_verifier`, and `verification.test_commands`.
- If a mutating worker lacks a review verifier, the runtime may insert a `review` verifier action.
- If a high-risk worker or a worker with explicit test commands lacks a test verifier, the runtime may insert a `test` verifier action.
- Inserted verifier actions are normal child sessions. They depend on the worker action. Review depends on the worker and, when present, the test action.
- If the worker summary says no files changed and no external side effects occurred, an inserted `test` verifier can be skipped. The `review` verifier still runs to validate that conclusion.
- Explicit verifier items can set `verification: { "role": "test" | "review", "worker": "<worker_id>" }` to declare which gate they satisfy.

`answer`, `done`, `success`, `failure`, `error`, and `reply` are terminal items. Put them last when they appear after runtime work.

## Input Modes

- `text`: free-form text.
- `single`: one option.
- `multi`: multiple options.
- `form`: multiple fields.

Use `options` for `single` and `multi`. Each option uses `{ id, label, description }`.
When a user selects an option in `single` or `multi` mode, the UI also lets them type optional details for that selected option. Returned answers may therefore be either `label` or `label: details`.
Use `fields` for `form`. Each field uses `{ id, label, type, required, options, default }`.

Use `input` when the user's choice or additional information should affect the next protocol package. After the user answers, the runtime returns the input to the model and stops the current package. Do not put executable items that depend on an `input` item in the same package.

## Plan Confirmation

Use `confirm` when a planner has designed a plan that must be approved before execution.

The planner should emit the `confirm` item and the executable downstream items in the same protocol package. The runtime persists the `plan` and asks the user to approve or cancel. If the user confirms, downstream items that depend on the confirmation execute automatically from the persisted package without asking the model to regenerate the plan or emit another package. If the user cancels, downstream items do not execute.

Use `input`, not `confirm`, when the user must choose between multiple plans, provide parameters, or add details that the model must interpret before building the next package.

Planner agents must follow this order:

1. Understand the initial task.
2. Analyze goals, constraints, risks, unresolved questions, and task boundaries.
3. Emit a `confirm` item whose `plan` summarizes the proposed plan.
4. In the same package, emit executable `agent` or `tool` items and set each gated item to depend on the `confirm` item.

After the user confirms, the runtime automatically executes the dependent items from the persisted package.

## Requirement Documents

The default agent may emit a requirement document when the request is large, ambiguous, high-risk, long-lived, or needs a durable product contract before planning. Small focused tasks do not need a requirement document unless the user asks for one or the missing context would change the work graph.

Requirement documents are user-visible terminal content, not a separate protocol item kind. Emit them as an `answer` or `reply` item whose `message` is exactly one JSON object. The runtime recognizes the document by these top-level fields:

- `type`: must be `"requirements_document"`.
- `schema_version`: must be `"requirements.document.v1"`.
- `review_state`: `"draft"` before review, `"reviewed"` after review. This is a document marker, not the loop guard.
- `review_count`: starts at `0` and increments when the same session rewrites the document during review. This is a document marker, not the loop guard.

Required content fields:

```json
{
  "type": "requirements_document",
  "schema_version": "requirements.document.v1",
  "review_state": "draft",
  "review_count": 0,
  "id": "short_stable_id",
  "title": "Short title",
  "goal": "User-visible goal",
  "background": "Why this is needed, or an empty string when not available",
  "users": [],
  "scope": [],
  "out_of_scope": [],
  "constraints": [],
  "acceptance": [],
  "risks": [],
  "assumptions": [],
  "open_questions": [],
  "must": [],
  "must_not": []
}
```

The runtime should validate required fields before review. If fields are missing or have the wrong shape, return the validation issues to the same model turn path and require a regenerated requirement document before planning.

When a valid document has `review_state: "draft"`, the runtime may submit it back into the same session for requirement review. The review instruction must ask the default agent to review against this section and output a complete replacement requirement document, not review comments. The reviewed output must set `review_state` to `"reviewed"` and increment `review_count`. If the draft is already acceptable, copy it forward with the reviewed marker.

The runtime must maintain its own private requirement-review ledger and must not rely on model-generated `review_state` or `review_count` to detect loops. The ledger should be stored outside the model context and include at least:

- session id
- source message id that first produced the requirement document
- runtime-generated review run id
- normalized document hash before review
- normalized document hashes produced by review attempts
- attempt count
- final reviewed message id when review succeeds
- status: `pending`, `reviewed`, `blocked`, or `failed`

Normalize the document for hashing by parsing the JSON object, sorting keys recursively, and excluding volatile marker fields such as `review_state` and `review_count`. The runtime should block automatic review and surface a loop-guard message when any of these happen:

- the same normalized document hash is submitted for review more than once in the same review run
- the review attempt count exceeds the runtime limit, recommended default `2`
- the model returns comments instead of a complete replacement document
- the model keeps returning invalid requirement documents after validation feedback

When a valid document has `review_state: "reviewed"` and the runtime ledger marks the review run as `reviewed`, the runtime must not send it through the automatic requirement review loop again unless the user explicitly asks for a new revision. Hidden review prompts, review logs, and ledger details should not be forwarded to downstream planner context; pass only the final reviewed requirement document.

## Workflow Assets

A Workflow is a reusable, named Action Graph Profile. Use Workflow only when the user asks to create, save, update, inspect, archive, or run a reusable workflow asset. For ordinary one-off multi-step work, declare normal `agent` and `tool` items instead of creating a Workflow.

There is no `workflow` item kind. Use the existing protocol items:

- Prefer an `agent` item targeting `workflow-creator` when the model needs to design or revise a persisted Workflow definition.
- Use a `tool` item targeting `workflow_create` only when the Workflow definition is already concrete and the tool is listed in Available Protocol Tools.
- Use a `tool` item targeting `workflow_start` only after `workflow_create` has returned a workflow id, and only when the user asked to execute the workflow.

When generating a Workflow definition, include:

- stable `id`, short `name`, `description`, and `version`
- `inputs` and `outputs` when runtime parameters or exported values are needed
- `nodes` with stable ids, `type`, `agent`, `prompt`, `mutates`, `depends_on`, and useful `capabilities`
- `verification` for nodes that require test, review, or gate evidence
- `error_policy`, guards, waits, or loop policy only when they are part of the reusable process

Use `input` before `workflow_create` when missing user choices can change the Workflow shape, such as workflow id, reusable scope, inputs, mutation permissions, verification gates, or whether to run after saving. Use `confirm` before `workflow_create` when the generated Workflow should be approved before it is persisted.

Example: delegate Workflow generation:

```json
{
  "version": "2",
  "items": [
    {
      "id": "create_release_workflow",
      "kind": "agent",
      "target": "workflow-creator",
      "prompt": "Create a reusable release workflow. Include inputs, nodes, dependencies, mutation boundaries, verification gates, error policy, and a stable workflow id. Save it with workflow_create and report the saved id and path.",
      "result": "structured"
    }
  ]
}
```

Example: save and optionally start a concrete Workflow:

```json
{
  "version": "2",
  "items": [
    {
      "id": "save_release_workflow",
      "kind": "tool",
      "target": "workflow_create",
      "args": {
        "workflow": {
          "id": "release_check",
          "name": "Release Check",
          "description": "Reusable pre-release validation workflow.",
          "version": "1",
          "inputs": {
            "branch": { "type": "string", "required": true }
          },
          "nodes": [
            {
              "id": "run_tests",
              "type": "test",
              "agent": "verifier",
              "prompt": "Run the release validation tests for ${branch}.",
              "mutates": false
            }
          ]
        }
      },
      "result": "structured"
    },
    {
      "id": "start_release_workflow",
      "kind": "tool",
      "target": "workflow_start",
      "args": {
        "workflow_id": "release_check",
        "variables": { "branch": "dev" }
      },
      "depends": ["save_release_workflow"],
      "result": "structured"
    }
  ]
}
```

After `workflow_start`, do not manually execute Workflow nodes. Report the created run state, then use the runtime's Workflow result when it appears in the session.

## Rules

- Use concrete tool ids from Available Protocol Tools.
- Use concrete agent ids from Available Protocol Agents, or `auto` for agent routing.
- Do not use `task` as a tool to delegate; use an `agent` item.
- Do not invent tool names or args outside the listed schemas.
- Do not fake runtime results.
- If enough information is available, use `answer`.
