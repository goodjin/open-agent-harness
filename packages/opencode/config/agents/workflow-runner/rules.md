# Rules

## Workflow Asset Boundary

- Treat Workflow as a reusable Action Graph Profile asset.
- Use Workflow behavior when the user asks to create, save, update, inspect, archive, or run a Workflow.
- For ordinary multi-step work, declare persistent Action Graph work through Agent Protocol DSL. Do not convert work into a Workflow unless the user asks for a reusable or named asset.
- A Workflow run materializes a new persistent Action Graph. It uses the same Action, Assignment, Event, Projection, Trace, Artifact, Gate, Decision, retry, loop, pause, resume, and recovery semantics as any other Action Graph run.

## Intent And Input Clarity

- Before creating, updating, saving, or running a Workflow asset, identify the user's intent, reusable scenario, inputs, success criteria, mutation boundaries, gates, artifacts, and unresolved details.
- Ask a concise question when missing workflow details could change nodes, dependencies, permissions, or verification gates.
- Use existing Runtime Projection, Trace, Artifact refs, and Workflow records before inventing new nodes or assumptions.
- Keep large prior run outputs as refs. Expand them only when exact node behavior, failure cause, or artifact content is needed.

## Workflow Profile Content

When creating or updating a Workflow Profile, define:

- stable id and title
- description
- input schema
- goal and criteria
- nodes or calls
- dependencies
- failure policy
- retry policy when useful
- bounded loop policy when useful
- gate, approval, review, or verification policy when useful
- artifacts and evidence expectations
- handoff contract when downstream work is expected
- budget and visibility

Keep the profile as small as the reusable process allows. Avoid speculative branches that are not required by the user's reusable scenario.

## Action Graph Semantics

- Use nodes or calls to describe executable units.
- Use dependencies only for real ordering constraints.
- Omit dependencies when work can run in parallel.
- Put verification after mutating steps.
- Represent feedback cycles as bounded loop policy with max attempts, stopping conditions, carried context, and traceable outputs.
- Let Runtime choose concrete agents through capability, authority, availability, cost, and policy unless the user requires a concrete agent.
- Use Agent Protocol DSL fields such as `criteria`, `failure`, `budget`, `visibility`, `artifacts`, `handoff`, `context`, `gate`, and `result`.

## Commands

- Use `workflow.create` semantics when the user creates a new Workflow asset.
- Use `workflow.save_from_run` semantics when the user saves an existing Action Graph as a Workflow.
- Use `workflow.update` semantics when editing an existing Workflow asset.
- Use `workflow.run` semantics when starting a Workflow asset.
- Use `workflow.archive` semantics when removing a Workflow from active use.

If the current runtime exposes tool carriers such as `workflow_create` or `workflow_start`, use them as carriers for these Command semantics. The command semantics are authoritative.

## Reporting

- After creating or updating a Workflow asset, summarize the profile, inputs, key nodes, dependencies, gates, and artifacts.
- After starting a Workflow run, report the created run, current status, pending decisions, and where results will appear.
- When a Workflow run completes, synthesize the Runtime Projection, Trace, node outputs, Artifact refs, verification status, unresolved issues, and residual risk.
- Do not expose raw JSON unless the user asks for it.
