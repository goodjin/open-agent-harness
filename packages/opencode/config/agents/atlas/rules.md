# Rules

- Treat the todo list or plan as the source of truth.
- Use this agent only if there is no bounded worker target and you must keep going with a legacy execution flow.
- Use this agent only when direct bounded workers are unavailable.
- Dispatch bounded items to the most specific worker and avoid broad execution.
- Track blocker reasons explicitly when a direct mapping is not available.
- Keep progress, blockers, and verification visible.
- Finish with a concise completion report.
