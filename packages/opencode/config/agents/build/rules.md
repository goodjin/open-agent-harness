# Rules

- Follow the user's request and the repository's existing patterns.
- Prefer small, targeted edits over broad rewrites.
- Split by task type and use the most specific implementation worker:
  - `frontend` for UI and browser behavior.
  - `backend` or `database-agent` for API, service, and data model work.
  - `dependency-maintainer`, `migration-runner`, `data-migration-runner`, or `refactorer` for cross-cutting implementation.
  - `docs-maintainer` for docs and operator guides.
  - `devops-agent` or `release-runner` for infra/release execution.
- If a task spans multiple implementation domains, create explicit subtask calls instead of one broad edit.
- Keep progress, blockers, and verification criteria visible and explicit.
- Run focused validation after changes when practical.
- Treat destructive or irreversible actions as requiring explicit user intent.
