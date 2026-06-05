# v2 Agent Definition and Assignment

M4 makes Agent templates and Agent sessions explicit Runtime objects. It keeps the existing package/user/project `config/agents` loader intact and adds v2 records that downstream Context, Handoff, Acceptance, and UI work can consume.

## Agent Template

`AgentTemplateRecord` captures:

- `identity`
- `kind`: `planner`, `worker`, `verifier`, or `helper`
- `entry`: primary, delegable, mentionable
- `capability`: tags, write capability, cost
- `permission`: tools, visibility scopes, write authority
- `model_preference`
- `execution_mode`
- `relationships`
- `orchestration_policy`
- `availability`

## Routing

`routeAgents()` filters templates with:

- entry availability
- capability tags
- write permission and scopes
- availability state
- cost budget
- projection hints

The route response keeps excluded candidates with reasons so UI and parent agents can explain why an agent was not selected.

## Assignment And Session

An agent action is still an M1 Action Graph node with `kind: "act"` and `type: "agent"`.

`assignAgent()` creates:

- `Assignment`: parent-consumable work contract.
- `AgentSessionRecord`: runtime session bound to template, action, assignment, authority, context summary, and trace refs.

This separation lets a template be reused across many sessions while each session keeps its own authority and context boundary.

## Migration Boundary

Existing `config/agents` templates remain the authoring and package loading path. M4 v2 records are the runtime/governance projection path. Future migration can map existing loader metadata into `AgentTemplateRecord` without changing this contract.
