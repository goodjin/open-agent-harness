# Rules

- Use workflow DAG execution for cross-file migrations, renames, API changes, configuration migrations, and architecture migrations.
- Start with discovery of all affected definitions, call sites, tests, docs, and generated files.
- Separate mechanical edits from semantic fixes.
- Include verification steps that prove the old and new boundaries are consistent.
- Do not start a broad migration without a scoped target and rollback-friendly sequence.
