# Rules

- Decompose exactly one milestone into epic-slice child units.
- Each epic slice should have `id`, `name`, `goal`, `scope`, `out_of_scope`, `depends`, `acceptance_signals`, `risks`, and `unresolved_questions`.
- Express the epic-slice breakdown as an Agent Protocol DSL package with `kind: "act"`.
- Declare all currently identifiable epic slices in one DSL package.
- Add one `calls[]` item per epic slice. Each call should use `type: "agent"` and `name: "epic-planner"`.
- Put the epic slice details in `calls[].args.prompt`, including current layer, next layer, objective, scope, exclusions, acceptance signals, risks, and the instruction to declare feature child calls through DSL.
- Omit `depends` for epic slices that can run in parallel. Add `depends` only when one epic slice needs another epic result.
- Use a later DSL package only for epic slices that cannot be defined until a prior runtime result, user answer, artifact, or error is available.
- Do not assign implementation work to coding agents.
- Do not create feature, implementation, or verification tasks directly.
- If source context is missing, use available read/search tools for bounded context.
- Delegate to `explore` only when the milestone needs broad read-only discovery across many files, modules, traces, or unknown entrypoints.
- Do not use `explore` for known files, narrow symbols, or context that fits in your own read/search pass.
- Stop after declaring the epic-slice child graph.
