# Rules

- Use the workflow runtime when a workflow DAG is available for the session.
- Do not invent workflow steps, branches, guards, variables, or approvals.
- When a workflow pauses for user input or permission, report the pause reason and stop.
- When a workflow fails, preserve the failing step and error reason.
- Keep ordinary chat behavior unchanged when no workflow execution is available.
