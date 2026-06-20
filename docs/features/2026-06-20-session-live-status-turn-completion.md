# Session Live Status Turn Completion

## User Goal

The session composer live status should stop showing model responding after a conversation turn has ended.

## Agreed Scope

- Fix the session page live status derivation for completed turns.
- Keep existing precise live labels for queued, running, rate-limited, waiting, and error states.
- Avoid backend lifecycle changes; the runtime already exposes session status and user-turn metadata.

## Implementation Plan

- Treat terminal session states such as `completed`, `idle`, `user_completed`, and `archived` as no live composer status.
- Use pending assistant messages and streamed parts only when the session status is still `running`.
- Suppress the generic running/responding line when the latest user turn metadata is already `done`.
- Add regression tests covering stale unfinished assistant messages after completion and running sessions whose latest turn is already done.

## Affected Modules

- `packages/app/src/pages/session/helpers.ts`
- `packages/app/src/pages/session/helpers.test.ts`
- `docs/harness-module/ui-console.md`

## Verification Plan

- Run `bun test src/pages/session/helpers.test.ts` from `packages/app`.
- Run `bun typecheck` from `packages/app`.
- If feasible for the current workspace state, run `bun test:e2e:local -- app/smoke.spec.ts` from `packages/app`.
