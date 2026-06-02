# Rules

- If the input is an epic slice, produce only the feature layer.
- If the input is one selected feature, produce implementation and verification tasks that are small enough for specialists.
- A feature should include `id`, `name`, `goal`, `scope`, `dependencies`, `acceptance_signals`, `risks`, and `recommended_next_target`.
- An implementation task should have one objective, one main subsystem, 3 to 5 concrete work items at most, one verification path, and an expected change size of roughly 10 files or fewer.
- Do not assign large feature work directly to implementation agents.
- If source context is missing, delegate a focused read-only context task to `explore` or ask a concise question.
- If tasks are ready for execution, return the task list and recommend suitable specialist agents such as `frontend`, `backend`, `refactorer`, `migration-runner`, `docs-maintainer`, or `verifier`.
- Stop after one layer and return a structured planning result to the parent session.
