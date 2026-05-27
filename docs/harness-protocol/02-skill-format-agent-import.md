# Skill Format Agent Import

Open Agent Harness can import `SKILL.md` files as virtual agents. The runtime normalizes reusable instruction packages into the same agent registry, selection, delegation, permission, and management surfaces as authored agents.

## Philosophy

Skills and agents describe the same product object at different authoring depths: reusable instructions for doing a specific piece of work.

A skill usually begins as a shortcut for a repeated prompt. As it matures, it grows into a reusable workflow: what role to take, what steps to follow, what rules to obey, what exceptions to handle, and what output to produce. Agent teams describe the same structure from the opposite direction: break a larger job into roles, give each role a focused workflow, and let the system delegate to the right specialist.

The product position is that this overlap should resolve toward agents.

Agents are the stronger runtime abstraction because they give reusable workflows a complete execution boundary:

- Identity and role are first-class.
- Context is isolated per task instead of accumulating many unrelated skills in one conversation.
- Lifecycle is explicit: create an agent instance for the job, complete the job, then discard that context.
- Permissions, tools, model choice, cost, and entry behavior can be governed per agent.
- Future memory or operational history belongs naturally to the agent, not to a stateless prompt snippet.

This matters for context engineering. Calling multiple skills inside one long conversation mixes unrelated instructions and history. That increases context length, attention drift, and accidental cross-contamination between tasks. Running the same workflow as a subagent keeps each unit of work focused: one agent instance, one task boundary, one clean context.

Skills remain valuable as a low-friction authoring format. The protocol treats them as a compact way to define agents when a full template is unnecessary.

In short: skills are accepted as authoring input; agents are the execution model.

## Rationale

The core product direction is that reusable behavior is represented as agents. A separate skill execution path would duplicate discovery, invocation rules, permissions, and UI behavior.

The import layer keeps the authoring convenience of `SKILL.md` while execution stays inside the agent model. After import, the system sees a skill package as an agent with metadata, prompt text, entry flags, capability tags, and permission policy.

## Supported Input

The runtime scans supported skill roots for files named:

```text
*/SKILL.md
```

The default global skill root is:

```text
~/.claude/skills/
```

The loader may also support sibling `skill/` and `skills/` directories when an agent directory root is provided. The main user-facing global path is `~/.claude/skills/`.

## Import Rules

Each `SKILL.md` is parsed as Markdown with optional frontmatter.

The imported agent id comes from:

1. `name` in frontmatter, when present.
2. The skill directory name, when `name` is absent.

The id is normalized to lowercase and may contain letters, numbers, dots, underscores, and dashes.

The imported description comes from:

1. `description` in frontmatter, when present.
2. A generated default description.

The imported prompt is built from the skill body:

- `## Role` becomes the agent identity when present.
- `## Workflow` and `## Rules` become agent rules when present.
- If those sections are absent, the full skill body is used.

The generated agent metadata uses:

```json
{
  "mode": "subagent",
  "capability": {
    "purpose": "skill_import",
    "tags": ["skill", "<agent-id>"],
    "cost": "medium",
    "writes": true
  },
  "permission_mode": "lax"
}
```

These agents are virtual. The runtime does not write generated `meta.json`, `identity.md`, or `rules.md` files back to disk.

## Precedence

Explicit agent templates override imported skills with the same id.

This lets a lightweight `SKILL.md` evolve into a full agent template without changing its invocation id.

## Runtime Behavior

Imported skills appear in `/agent` as normal agent records with:

- `name`: the imported agent id
- `mode`: `subagent`
- `capability.purpose`: `skill_import`
- `capability.tags`: `["skill", id]`

They are visible in session agent selection unless hidden by agent metadata or configuration.

They are mentionable and delegable by default because their generated entry metadata follows subagent semantics.

## Agent Management UI

The management API marks imported skills as:

```json
{
  "kind": "skill",
  "editable": false
}
```

This distinguishes them from authored agents:

```json
{
  "kind": "agent",
  "editable": true
}
```

The settings UI can filter by type:

- all
- authored agents
- imported skills

Imported skills are not directly editable in the agent manager because their source of truth is `SKILL.md`. To customize one, either edit the source skill file or create an authored agent template with the same id.

## Non Goals

This import layer does not create a separate skill runtime.

Specifically:

- There is no `skill` tool.
- Top-level `skills` config is unsupported.
- `permission.skill` config is unsupported.
- Imported skills do not execute through a skill-specific dispatcher.

The only supported execution path is through the agent runtime.

## Known Boundaries

Imported skills preserve the main prompt content and description, but they do not infer rich agent metadata such as model preference, detailed tool policy, cost beyond the default, or custom entry flags.

For production-quality behavior, prefer an authored agent template once the skill has stabilized.
