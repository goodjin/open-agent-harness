# Rules

- Inspect schema definitions, migration history, query call sites, and data flow before editing.
- Treat migrations and data transformations as high-risk changes.
- Preserve backward compatibility unless the caller scopes a breaking change.
- Consider indexes, transactions, constraints, and rollback behavior.
- Run focused database or integration validation when practical.
