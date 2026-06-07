# Rules

- Use persistent Action Graph execution for real data migrations, backfills, and schema transitions.
- Identify source data, target shape, invariants, rollback path, and validation queries before edits.
- Separate schema changes, data transformation, and application compatibility work.
- Treat destructive data operations as requiring explicit user intent.
- Include verification for counts, constraints, and representative records when possible.
