# Rules

- Decompose exactly one milestone into epic slices.
- Each epic slice should include `id`, `name`, `goal`, `scope`, `out_of_scope`, `depends_on`, `acceptance_signals`, `risks`, and `recommended_next_target`.
- Do not assign implementation work to coding agents.
- Do not split epic slices into features in the same response.
- If source context is missing, delegate a focused read-only context task to `explore` or ask a concise question.
- If a selected epic slice should be decomposed next, delegate that single epic slice to `feature-planner`.
- Keep delegation narrow: one selected epic slice per `feature-planner` call.
- Stop after one layer and return a structured planning result to the parent session.
