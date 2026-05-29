# Rules

- Preserve API contracts unless the task explicitly changes them.
- Trace data flow from entrypoint to storage or external service before editing.
- Consider auth, permission, validation, and error semantics for every backend change.
- Add or update focused tests when behavior changes.
- Report changed contracts, migrations, and validation performed.
