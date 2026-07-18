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

`pending -> claimed(owner token, generation, lease) -> continuation_pending -> completed | cancelled`

Only the transaction that wins `pending -> claimed` may create or reuse the canonical Assignment and Handoff proof. Reclaim increments the generation and replaces the owner token; every later Assignment, Handoff, outbox, and terminal transition checks that fence. The first claim stores an immutable canonical proposal snapshot and hash. A current Revision mismatch returns 409 before Assignment, continuation, or protocol state changes, while a matching terminal replay remains readable after the Task advances. A fixed proposal-derived continuation message and outbox dedupe key make retries and recovery reuse one delivery. Outbox delivery uses its own fenced `delivering` lease. Terminal state is written only after live reply delivery or durable continuation delivery is accepted. Assignment source locators are database-unique because Runtime treats source Session, Run, and action as one immutable identity.

The claim owner starts a heartbeat immediately and keeps it active across Assignment, Handoff, live Question acknowledgement, durable continuation, and terminal commit, then stops it in `finally`. Every irreversible publication performs a synchronous lease renewal before the call and fences again after it returns. A live Question is acknowledged with an internal reroute marker so its original runner does not continue the package; the fixed prompt outbox is the single continuation carrier in both live and restored cases.

## Affected Modules

- `session.sql.ts` and a new migration: durable confirmation claim.
- `task-confirmation.ts`: transactional claim, proof reuse, delivery and recovery.
- `recovery.ts`: startup scan.
- `server/routes/session.ts`: expected Revision enters the domain transaction.
- OpenAPI and generated JavaScript SDK.

## Verification

- Live Question candidates whose assistant `AgentProtocolOutput` input identifies update/handoff fail closed with 409 when the DSL locator is missing or duplicated; reply and reject retain the pending Question and produce no Assignment, Handoff transition, outbox, or prompt continuation.
- Tool-backed protocol input/select Questions remain on the generic Question path.

- RED/GREEN route tests for the revision barrier, failed continuation, fixed identity, replay, and generated SDK surface.
- Controlled lease and barrier tests across Assignment, Handoff, and live Question reply.
- Public Question reply route tests proving live and restored Task confirmations enter the same confirmation service and fixed continuation outbox, while generic Questions keep their existing behavior.
- Legacy terminal import tests proving only canonical confirmed/cancelled DSL state becomes a durable terminal confirmation without a new continuation.
- Real Bun child-process contention test against one SQLite database.
- Task API, recovery, assignment, Runs and tree regressions.
- Migration check, typecheck, SDK check/typecheck/build, agent manifest build, and diff check.
