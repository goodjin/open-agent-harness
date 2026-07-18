# Task Confirmation Durability Bugfix Plan

## Goal

Close the Task API revision TOCTOU, cross-process confirmation idempotency, durable continuation, and generated SDK naming gaps found after Task 7 review.

## Scope

- Add a SQLite-backed confirmation claim keyed by Session and proposal.
- Recheck proposal ownership and expected current Revision in one immediate transaction.
- Persist fixed continuation identity and delivery state; recover unfinished delivery at startup.
- Keep live Question replies and restored continuation idempotent.
- Rename Task operation IDs so the generated v2 client has one coherent public surface.
- Add migration, server/domain/recovery/process-concurrency tests, and regenerate the SDK only through the repository script.

## State Machine

`pending -> claimed -> continuation_pending -> completed | cancelled`

Only the transaction that wins `pending -> claimed` may create or reuse the canonical Assignment and Handoff proof. A current Revision mismatch returns 409 before Assignment, continuation, or protocol state changes. A fixed proposal-derived continuation message and outbox dedupe key make retries and recovery reuse one delivery. Terminal state is written only after live reply delivery or durable continuation delivery is accepted.

## Affected Modules

- `session.sql.ts` and a new migration: durable confirmation claim.
- `task-confirmation.ts`: transactional claim, proof reuse, delivery and recovery.
- `recovery.ts`: startup scan.
- `server/routes/session.ts`: expected Revision enters the domain transaction.
- OpenAPI and generated JavaScript SDK.

## Verification

- RED/GREEN route tests for the revision barrier, failed continuation, fixed identity, replay, and generated SDK surface.
- Real Bun child-process contention test against one SQLite database.
- Task API, recovery, assignment, Runs and tree regressions.
- Migration check, typecheck, SDK check/typecheck/build, agent manifest build, and diff check.
