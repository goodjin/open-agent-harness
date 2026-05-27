# Routing And Delegation Policy

## Purpose

This document defines how Harness chooses executors and delegates work.

Routing converts a normalized `Action` into an executable `Assignment` or direct executor invocation. Delegation is a routing result where the executor is an agent session.

## Inputs

Runtime routing uses:

- action `operation`
- requested `executor.type`
- requested `executor.target`
- required capabilities
- resource read/write scope
- side effects
- agent `entry`
- agent `capability`
- effective permission policy
- availability, cost, and model preference
- current run state and dependency state

## Candidate Filtering

Recommended order:

1. Select executor class from `executor.type`.
2. If `target` is concrete, load that executor and reject if missing.
3. If `target` is `auto`, build candidates from registry metadata.
4. Reject hidden or disabled agents unless the runtime has explicit system authority.
5. For agent delegation, require `entry.delegable === true`.
6. Match capability purpose and tags.
7. Reject candidates whose permission profile cannot satisfy action side effects.
8. Apply cost, availability, and model constraints.
9. Choose the lowest-surprise candidate and record the decision.

The model may suggest an executor. Runtime owns the final choice.

## Assignment Binding

When an action delegates to an agent, runtime creates an assignment:

```json
{
  "id": "assign_review_changes",
  "action_id": "review_changes",
  "agent_id": "reviewer",
  "capabilities": ["code_review", "testing"],
  "authority": {
    "read": ["repo://current"],
    "write": [],
    "approve": ["task.review"]
  },
  "contract": {
    "input": "context_bundle",
    "output": "evaluation_result"
  }
}
```

Template-level metadata does not grant authority by itself. Runtime derives assignment authority from action policy, run policy, user approval, and gate requirements.

## Child Session Trace

Agent delegation must produce inspectable child records:

- parent run id
- parent action id
- child session id
- assigned agent id
- effective capability match
- effective authority
- input context refs
- result summary
- artifact refs
- failure/block reason

Failed child work must not be silently dropped from the parent action. The parent action should become `failed`, `blocked`, or `partial` according to failure policy.

## Handoff Rules

Handoff from one agent to another must go through Runtime:

```txt
Agent A -> action result / command -> Runtime -> assignment -> Agent B
```

Agent A should not directly instruct Agent B as a control mechanism. It may propose a next action, but Runtime validates and dispatches.

## Delegation Request Recovery

If model emits a direct task/delegation request, runtime may recover it into an agent action only when:

- target agent is concrete or safely resolvable
- description is specific enough for an assignment
- scope and expected result are known
- permissions can be enforced

Otherwise runtime should return a protocol violation and ask for a structured action.

## V1 Boundary

V1 can start with:

- `target: "auto"` agent selection using `entry` and `capability`
- read-only or review-style delegated agents
- child session trace links
- rejection for hidden, disabled, non-delegable, or permission-mismatched agents

Full multi-agent recovery loops can wait until workflow and protocol logs are stable.
