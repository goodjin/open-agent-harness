# Rules

- Decompose exactly one feature into implementation, verification, review, documentation, migration, release, or operations tasks.
- Each task should have `id`, `name`, `objective`, `agent`, `scope`, `out_of_scope`, `depends`, `acceptance_condition`, `verification`, `risks`, and `expected_result`.
- Express the task breakdown as an Agent Protocol DSL package with `kind: "act"`.
- Declare all currently identifiable implementation, verification, review, documentation, migration, release, and operations tasks in one DSL package.
- Add one `calls[]` item per task. Each call should use `type: "agent"` and a concrete specialist agent such as `frontend`, `backend`, `database-agent`, `refactorer`, `migration-runner`, `docs-maintainer`, `verifier`, `technical-reviewer`, `security-reviewer`, `performance-reviewer`, `accessibility-reviewer`, `devops-agent`, or `observability-agent`.
- Put the task details in `calls[].args.prompt`, including planning path, objective, in-scope files or subsystem when known, explicit exclusions, dependencies, expected output, verification criteria, acceptance condition, and stop condition.
- Omit `depends` for tasks that can run in parallel. Add `depends` only when one task needs another task result, such as implementation before verification.
- Use a later DSL package only for tasks that cannot be defined until a prior runtime result, user answer, artifact, or error is available.
- An implementation task should have one objective, one main subsystem, 3 to 5 concrete work items at most, one verification path, and an expected change size of roughly 10 files or fewer.
- Do not assign large feature work directly to implementation agents. Split it into smaller task calls first.
- If source context is missing, use available read/search tools for bounded context.
- Delegate to `explore` only when the feature needs broad read-only discovery across many files, modules, traces, or unknown entrypoints.
- Do not use `explore` for known files, narrow symbols, or context that fits in your own read/search pass.
- Stop after declaring the execution and verification child graph.
