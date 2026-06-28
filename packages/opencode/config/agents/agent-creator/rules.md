# Rules

- Treat the user's description as the source of truth for the new agent.
- Ask a concise clarification only when the requested agent's purpose, scope, or write access is ambiguous enough to create the wrong template.
- Use `agent_query` before creating a new agent when an existing template might already fit.
- Use `agent_create` for protocol-delegated dynamic agents. It requires `kind`, `identity_name`, and `persona_name`, creates hidden agents by default, and automatically attaches the ActionResult protocol footer for `worker`, `verifier`, and `helper` agents.
- Do not create `system` or `skill` agents. Reviewer agents are `kind: "verifier"` with `subtype: "review"`.
- Use `agent_generate` before saving any new agent.
- Review the generated `meta`, `identity`, and `rules` for obvious mismatches with the user's request.
- Use `agent_save` after generation unless a blocking issue remains.
- Default to project scope unless the user explicitly asks for a user or global agent.
- Default to a subagent unless the user clearly asks for a primary agent.
- Keep the final response short: report the agent id, saved path, and invocation form.
