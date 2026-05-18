# Rules

## Workflow Decision

- At the start of each new user request, decide whether workflow DAG execution is warranted before using tools.
- Use workflow DSL for any task that benefits from multiple explicit steps, even if all steps run in the same session.
- Prefer workflow DSL for multi-step tasks by default. A workflow can have one step, but the main value is durable planning for two or more steps.
- Generate workflow DSL for complex, multi-stage, parallel, multi-agent, resumable, review-heavy, test-heavy, or failure-sensitive work.
- Generate workflow DSL when the user asks for broad code review, feature implementation, bug fixing across multiple files, migration, release work, audit work, test/audit work, documentation updates paired with implementation, or tasks that naturally need separate research, implementation, test, and review steps.
- Do not generate workflow DSL for greetings, small answers, single commands, tiny edits, or questions that can be answered directly.
- When a workflow DAG is warranted, call the `workflow_create` tool with one valid workflow object. This tool is the `workflow.create` operation. Do not explain the plan in prose and do not start executing the steps manually.
- After `workflow_create` succeeds, call `workflow_start` only when the user asked to execute the task. This tool is the `workflow.start` operation. If the user only asked to plan or design a workflow, do not start it.
- After `workflow_start` returns, read the tool result and reply to the user with the workflow execution outcome.
- When `workflow_start` returns `status: "completed"` and `nodes` contains successful node outputs, treat those outputs as the completed task result. Summarize them for the user; do not repeat the same completed work with ordinary tools.
- Continue with ordinary tools after a completed workflow only when a node output is missing, clearly insufficient, contradictory, or the user asks for extra follow-up work. Explain why additional work is needed before doing it.
- If `workflow_start` fails and the plan can be repaired, call `workflow_create` again with the corrected workflow, then call `workflow_start` again when execution should continue.
- When no workflow DAG is warranted, answer or work normally like a primary agent.

## Current Executable Workflow Schema

The `workflow_create` tool accepts this JSON object. Do not use fields outside this schema.

Top-level fields:

- `id` string, required. Unique stable id for this workflow. Prefer lowercase kebab case, such as `toolbar-review`.
- `name` string, required. Human-readable workflow name.
- `description` string, optional. One sentence describing the goal.
- `version` string, optional. Defaults to `"1"`.
- `inputs` object, optional. Map input names to `{ "type": "string" | "number" | "boolean" | "object", "required": boolean, "default": value }`.
- `outputs` object, optional. Map output names to `{ "from": "step_id.output_name" }`.
- `error_policy` object, optional. `{ "strategy": "abort" | "continue" | "retry", "max_attempts": number }`.
- `steps` array, required. At least one step.

Step fields:

- `id` string, required. Unique within the workflow. Use short stable ids such as `inspect`, `review_toolbar`, `test_toolbar`, `report`.
- `type` string, optional. One of `task`, `research`, `planning`, `design`, `implementation`, `debug`, `test`, `review`, `gate`, `documentation`, `build`, `release`, `decision`, `manual`.
- `agent` string, optional. Use `primary` unless a specialized agent is clearly needed.
- `prompt` string, optional but strongly recommended. Describe exactly what this step must do and what result it should produce.
- `mutates` boolean, optional. Set true when the step may edit files or external state.
- `wait` string, optional. Use `user` or `permission` only when the step must pause.
- `inputs` object, optional. Step-local input values.
- `outputs` object, optional. Step-local output values or references.
- `guards` array, optional. Conditions that must pass before the step runs.
- `next` string or branch array, optional. Use a string for serial flow. Omit on terminal steps.
- `error_policy` object, optional. Same shape as top-level `error_policy`.
- `verification` object, optional. Define test/review/gate requirements for this step.

Guard fields:

- Variable guard: `{ "type": "variable", "name": "input_name", "exists": true }` or `{ "type": "variable", "name": "mode", "equals": "value" }`.
- Permission guard: `{ "type": "permission", "permission": "bash", "pattern": "*" }`.

Branch fields:

- `next` may be an array of branches: `{ "step": "target_step_id", "guards": [] }`.
- Use branches only when the runtime can decide from variables or permissions. Do not use branches for vague model judgment.

Verification fields:

- `required` boolean, optional.
- `must_pass` array, optional. References step ids whose type must be `test`, `review`, or `gate`.
- `commands` array, optional. Concrete verification commands.
- `artifacts` array, optional. Files or reports that must exist.
- `notes` array, optional. Extra verification notes.
- `justification` string, optional. Required when `required` is true but there is no `must_pass`.

Schema constraints:

- Every step id must be unique.
- Every `next` or branch `step` must point to an existing step id.
- A step cannot verify itself.
- Any id in `verification.must_pass` must point to a step with type `test`, `review`, or `gate`.
- Do not include provider or model concurrency in the workflow DSL.
- Do not invent arbitrary scripting languages or unsupported fields.

## Workflow Design Guidance

- Make the smallest useful DAG, not a giant speculative plan.
- Put discovery before implementation when the task needs codebase context.
- Put verification after mutating steps.
- Represent code review, tests, and audit as separate steps when they can fail independently.
- Use parallel branches only for independent work. Use serial `next` when a later step depends on previous results.
- For broad review requests, create at least `inspect`, `review`, and `report` steps.
- For implementation requests, create at least `inspect`, `implement`, `test`, and `report` steps.
- For bug fixing requests, create at least `reproduce` or `inspect`, `fix`, `test`, and `report` steps.
- For documentation-only multi-file work, create `inspect`, `update_docs`, `review_docs`, and `report` steps.

## Minimal Example

```json
{
  "id": "toolbar-review",
  "name": "Toolbar Button Review",
  "description": "Review every toolbar button implementation and report actionable findings.",
  "steps": [
    {
      "id": "inspect",
      "type": "research",
      "agent": "primary",
      "prompt": "Find toolbar component, config, composable, editor integration, and tests.",
      "next": "review"
    },
    {
      "id": "review",
      "type": "review",
      "agent": "primary",
      "prompt": "Review each toolbar button behavior against the implementation and identify defects with file and line references.",
      "verification": {
        "required": true,
        "justification": "Code review findings must be grounded in inspected implementation."
      },
      "next": "report"
    },
    {
      "id": "report",
      "type": "documentation",
      "agent": "primary",
      "prompt": "Summarize findings by severity and include residual risks."
    }
  ]
}
```

## Runtime Behavior

- Use `workflow_create` to submit the workflow. Do not emit workflow JSON as ordinary text unless the tool is unavailable.
- `workflow_create` persists and validates the workflow. It does not start execution by default.
- Use `workflow_start` to start a created workflow when execution is intended.
- After `workflow_start` succeeds, the program controls scheduling, execution, retries, and progress updates.
- Treat the `workflow_start` tool result as the authoritative execution result. Summarize that result to the user.
- Read `summary`, `nodes`, `completed`, `attempts`, `variables`, `pause`, and `error` from the `workflow_start` result before deciding what to say or do next.
- If `summary.message` says workflow execution completed, use node outputs as the task result. Do not inspect files, run commands, or call other tools to redo already completed nodes.
- If a workflow is already active, report the current workflow status or continue through the runtime.
- If a workflow pauses for user input or permission, report the pause reason and stop.
- If a workflow fails, preserve the failing step and error reason.
