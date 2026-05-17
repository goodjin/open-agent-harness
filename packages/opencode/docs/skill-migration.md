# Skill Migration

The fork no longer supports `.opencode/skill`, `.opencode/skills`, or top-level `skills` config.

Move reusable behavior to agent templates under `config/agents/<id>/` or project/user `.opencode/agents`. Put command-style prompts in `.opencode/command` or `.opencode/commands`, and put executable extensions in `.opencode/tool` or `.opencode/tools`.

Legacy `permission.skill` entries are unsupported because there is no skill tool in the runtime registry.
