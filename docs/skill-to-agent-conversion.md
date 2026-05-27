# Skill To Agent Conversion

Open Agent Harness treats skills as compatibility input, not as a separate runtime primitive. The runtime converts supported skill files into virtual agents so they can participate in the same selection, delegation, permission, and management surfaces as authored agents.

## Philosophy

Skills and agents started from different authoring habits, but they often describe the same thing: reusable instructions for doing a specific piece of work.

A skill usually begins as a shortcut for a repeated prompt. As it matures, it grows into a reusable workflow: what role to take, what steps to follow, what rules to obey, what exceptions to handle, and what output to produce. Agent teams describe the same structure from the opposite direction: break a larger job into roles, give each role a focused workflow, and let the system delegate to the right specialist.

The product position is that this overlap should resolve toward agents.

Agents are the stronger runtime abstraction because they give reusable workflows a complete execution boundary:

- Identity and role are first-class.
- Context is isolated per task instead of accumulating many unrelated skills in one conversation.
- Lifecycle is explicit: create an agent instance for the job, complete the job, then discard that context.
- Permissions, tools, model choice, cost, and entry behavior can be governed per agent.
- Future memory or operational history belongs naturally to the agent, not to a stateless prompt snippet.

This matters for context engineering. Calling multiple skills inside one long conversation mixes unrelated instructions and history. That increases context length, attention drift, and accidental cross-contamination between tasks. Running the same workflow as a subagent keeps each unit of work focused: one agent instance, one task boundary, one clean context.

Skills remain valuable as a low-friction authoring format and as an existing ecosystem. The goal is not to discard that investment. The goal is to lower the cost of creating agents until a skill can be treated as an agent definition with a simpler file format.

In short: skills are accepted as authoring input; agents are the execution model.

## Rationale

The core product direction is that reusable behavior should be represented as agents. A skill is easy to write, but a standalone skill runtime creates a second abstraction beside agents: separate discovery, separate invocation rules, separate permissions, and separate UI behavior.

The conversion layer keeps the authoring convenience of `SKILL.md` while moving execution into the agent model. After conversion, the system sees a skill as an agent with metadata, prompt text, entry flags, capability tags, and permission policy.

## Supported Input

The runtime scans supported skill roots for files named:

```text
*/SKILL.md
```

Currently the global Claude-compatible skill root is:

```text
~/.claude/skills/
```

The lower-level loader also supports sibling `skill/` and `skills/` directories when an agent directory root is provided. This is used for tests and compatibility paths, but the main user-facing global path is `~/.claude/skills/`.

## Conversion Rules

Each `SKILL.md` is parsed as Markdown with optional frontmatter.

The converted agent id comes from:

1. `name` in frontmatter, when present.
2. The skill directory name, when `name` is absent.

The id is normalized to lowercase and may contain letters, numbers, dots, underscores, and dashes.

The converted description comes from:

1. `description` in frontmatter, when present.
2. A generated fallback description.

The converted prompt is built from the skill body:

- `## Role` becomes the agent identity when present.
- `## Workflow` and `## Rules` become agent rules when present.
- If those sections are absent, the full skill body is used.

The generated agent metadata uses:

```json
{
  "mode": "subagent",
  "capability": {
    "purpose": "legacy_skill",
    "tags": ["skill", "<agent-id>"],
    "cost": "medium",
    "writes": true
  },
  "permission_mode": "lax"
}
```

These agents are virtual. The runtime does not write generated `meta.json`, `identity.md`, or `rules.md` files back to disk.

## Precedence

Explicit agent templates override converted skills with the same id.

This allows migration by stages:

1. Keep an existing `SKILL.md`.
2. Let it appear as a virtual agent.
3. Later create a real agent template with the same id.
4. The authored agent template takes precedence.

## Runtime Behavior

Converted skills appear in `/agent` as normal agent records with:

- `name`: the converted agent id
- `mode`: `subagent`
- `capability.purpose`: `legacy_skill`
- `capability.tags`: `["skill", id]`

They are visible in session agent selection unless hidden by agent metadata or configuration.

They are mentionable and delegable by default because their generated entry metadata follows subagent semantics.

## Agent Management UI

The management API marks converted skills as:

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
- legacy skills

Converted skills are not directly editable in the agent manager because their source of truth is `SKILL.md`. To customize one, either edit the source skill file or create an authored agent template with the same id.

## Non Goals

This conversion layer does not restore the old skill runtime.

Specifically:

- There is no `skill` tool.
- Top-level `skills` config is unsupported.
- `permission.skill` config is unsupported.
- Converted skills do not execute through a skill-specific dispatcher.

The only supported execution path is through the agent runtime.

## Known Boundaries

Converted skills are best-effort compatibility objects. They preserve the main prompt content and description, but they do not infer rich agent metadata such as model preference, detailed tool policy, cost beyond the default, or custom entry flags.

For production-quality behavior, prefer an authored agent template once the skill has stabilized.
