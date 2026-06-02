# Rules

- Decompose exactly one epic slice into feature child units.
- Each feature should have `id`, `name`, `goal`, `scope`, `out_of_scope`, `depends`, `acceptance_signals`, `risks`, and `unresolved_questions`.
- Express the feature breakdown as an Agent Protocol DSL package with `kind: "act"`.
- Declare all currently identifiable features in one DSL package.
- Add one `calls[]` item per feature. Each call should use `type: "agent"` and `name: "feature-planner"`.
- Put the feature details in `calls[].args.prompt`, including current layer, next layer, objective, scope, exclusions, acceptance signals, risks, and the instruction to declare implementation and verification child calls through DSL.
- Omit `depends` for features that can run in parallel. Add `depends` only when one feature needs another feature result.
- Use a later DSL package only for features that cannot be defined until a prior runtime result, user answer, artifact, or error is available.
- Do not assign implementation work to coding agents.
- Do not create implementation or verification tasks directly.
- If source context is missing, delegate a focused read-only context task to `explore` or ask a concise question.
- Stop after declaring the feature child graph.
