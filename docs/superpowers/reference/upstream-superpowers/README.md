# Upstream Superpowers Reference

This directory keeps a local reference copy of the upstream Superpowers skills.

Copied source:

```text
/Users/jin/.codex/plugins/cache/openai-curated/superpowers/c3319989/skills
```

Copied on: 2026-06-09

The copied files are reference material. Treat `skills/*/SKILL.md` as the source text for behavior, and keep sibling prompts, scripts, and examples with the skill that uses them.

## Skill Inventory

| Skill | Trigger | Role In The Framework |
|---|---|---|
| `using-superpowers` | Start of a conversation or before any action where a skill may apply | Skill discovery and invocation discipline |
| `brainstorming` | Creative work, feature design, behavior changes | Requirements shaping, design approval, spec creation |
| `writing-plans` | Approved spec or multi-step requirement before code | Detailed implementation plan with exact tasks and tests |
| `using-git-worktrees` | Feature work that needs isolation | Workspace isolation before implementation |
| `test-driven-development` | Feature, bugfix, refactor, behavior change | Red-green-refactor gate before production code |
| `systematic-debugging` | Bug, test failure, unexpected behavior | Root-cause-first debugging workflow |
| `dispatching-parallel-agents` | Independent failures or work domains | Parallel investigation with isolated agent context |
| `subagent-driven-development` | Executing an implementation plan with independent tasks | One implementer agent per task plus review gates |
| `executing-plans` | Executing a written plan in a separate session | Inline or session-based plan execution |
| `requesting-code-review` | After tasks, major features, or before merge | Focused review by a fresh agent |
| `receiving-code-review` | Review feedback arrives | Evaluate feedback before applying it |
| `verification-before-completion` | Before claiming completion, commit, PR, or pass status | Evidence gate for tests, build, and requirements |
| `finishing-a-development-branch` | Work is implemented and verified | Merge, PR, cleanup, or branch completion choices |
| `writing-skills` | Creating or revising skills | TDD-style process for skill authoring |

## Framework Shape

Superpowers works less like a tool library and more like a process runtime:

1. `using-superpowers` decides whether a skill should enter the current context.
2. Process skills such as `brainstorming`, `writing-plans`, `systematic-debugging`, and `test-driven-development` constrain the next step.
3. Execution skills such as `subagent-driven-development`, `executing-plans`, and `dispatching-parallel-agents` create isolated work units.
4. Review and completion skills add gates before the controller moves forward.

The useful part to copy is the control structure: trigger, workflow, gate, artifact, and review loop. The exact prose can stay as reference text.

## Harness Mapping

`open-agent-harness` already treats skills as compatibility input and Agents as the runtime execution boundary. A similar Agent should use that direction instead of adding a second skill runtime.

Recommended mapping:

| Superpowers Concept | Harness Concept |
|---|---|
| Skill frontmatter `name` and `description` | Agent id, description, capability tags |
| Skill body | Agent prompt material or policy text |
| Skill companion prompts | Agent-specific reviewer or implementer prompts |
| Skill workflow step | Action Graph node |
| Skill hard gate | Gate, dependency, or orchestration policy |
| Subagent dispatch | Delegated Agent Assignment |
| Review loop | Required verifier Assignment after worker output |
| Verification command | Evidence artifact attached to Action result |

## Implementation Direction

The practical path is a hybrid:

1. Keep upstream skills as read-only references.
2. Add a `superpowers_controller` style Agent that routes the user request into one process path: design, debugging, planning, execution, review, or completion.
3. Convert stable workflows into authored Harness Agents rather than relying only on virtual skill conversion. The controller can still cite the upstream skill text when building context.
4. Express process gates in `orchestration_policy`, not only in natural language. Examples: design approval before implementation, TDD before writes, verifier after worker completion, fresh verification before completion claims.
5. Store every phase output as an artifact: spec, plan, task result, review finding, verification evidence, unresolved issue list.

This keeps the agent behavior inspectable in the graph and avoids hiding important decisions inside a long prompt.

## Candidate Agent Set

Start small:

| Agent | Kind | Purpose |
|---|---|---|
| `superpowers_controller` | `planner` | Selects the workflow path and creates the first Action Graph |
| `spec_designer` | `planner` | Runs the brainstorming/spec path |
| `plan_writer` | `planner` | Turns approved specs into implementation plans |
| `task_worker` | `worker` | Executes one bounded task from a plan |
| `spec_reviewer` | `verifier` | Checks implementation against the spec or plan |
| `code_reviewer` | `verifier` | Checks quality, regressions, and maintainability |
| `completion_verifier` | `verifier` | Confirms tests, typecheck, build, and requirement evidence |

Avoid creating one runtime Agent per upstream skill at first. Several skills are policies for the same controller lifecycle, and turning every file into a visible Agent would make routing noisier.

## Open Design Questions

1. Should the controller be a primary Agent users can select, or a hidden orchestration Agent used by the default Agent?
2. Should upstream `SKILL.md` files stay outside runtime loading, or should this reference folder be added as a skill root for conversion tests?
3. How strict should the gates be in autonomous mode? For example, should missing design approval block all writes, or only block large feature work?
