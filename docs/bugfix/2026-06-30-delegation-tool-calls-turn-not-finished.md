# Bug Fix: Delegation tool-calls turn remains running and blocks queued continuation

## Problem

- Date: 2026-06-30
- Severity: High
- Session: `ses_0eb8b3a37ffevmSi435koX97Pr`
- Title: `M2 Phase 15: 工作树收敛 + 主仓落盘 + 验收闭环`

The parent session had already completed the prior HTTP/LLM request and wrote a delegated continuation message, but the queued continuation did not start a new request. The UI showed the session as running and user input stayed queued.

## Evidence

- Parent DB status: `running/active`.
- Latest live status: `{"type":"running"}`.
- Last real LLM request:
  - `llm.start`: 2026-06-30 01:13:36 UTC
  - `llm.finish`: 2026-06-30 01:15:12 UTC
  - finish: `tool-calls`
- Delegation child completion:
  - `protocol.agent.completed`: 2026-06-30 01:17:49 UTC
  - Child: `ses_0e9e7c1e8ffe4HzxkqCaSUv9ho`
  - Child session status: `terminal_success`
  - Stored result: `result_f161a9705001dXBCK1wACCRnbj`, status `blocked`
- Parent turn state:
  - Old internal user: `msg_f1616ba83001K3yjsgiIGsLpW9`
  - `metadata.turn.status`: `running`
  - Child timeline includes `completed_at`, `result_id`, and `notified_at`
- Queued continuation:
  - User message: `msg_f161a9722001sE18nODkz38lOT`
  - `metadata.turn.status`: `queued`
  - Text exists in `part`: `Delegated child sessions have finished for run ...`
- `session_log` has no `session.turn.finished` event for this turn.

## Root Cause

This is not the same as an aborted empty assistant. The assistant message is completed with `finish="tool-calls"` because it called the native `AgentProtocolOutput` tool.

Expected flow:

1. `SessionRunner.protocol()` validates the protocol package.
2. `execute()` launches delegated child sessions.
3. `settle()` writes protocol runtime output and marks the assistant completed.
4. `mark()` calls `SessionTurn.finish()` with outcome `waiting_child`.
5. When all children finish, `SessionDelegation.submit()` writes an internal continuation prompt.
6. The queued continuation should be processed as the next request.

Observed flow:

1. Protocol validation and child launch happened.
2. The same protocol package also contained an independent human `input` action: `decide_convergence_path`.
3. `AgentProtocolExecutor.run()` treated the delegated action as `metadata.delegated === true`, recorded it as blocked/waiting, but did not stop the package.
4. The executor then continued to the human `input` action and entered `Question.ask()`.
5. Because `Question.ask()` waits for user input, `execute()` never returned to `SessionRunner.protocol()`.
6. Because `execute()` never returned, `SessionRunner.mark()` never called `SessionTurn.finish(... outcome: "waiting_child")`.
7. The child session completed later and `SessionDelegation.submit()` wrote the internal continuation message, but the original parent loop was still blocked in the earlier `Question.ask()` call.
8. The continuation stayed queued behind the stale running turn.

The actual program bug is in protocol execution ordering: a delegated child result is an asynchronous package boundary, but `AgentProtocolExecutor.run()` continues executing sibling actions after a delegated wait. If one of those sibling actions is a human input/confirm, the parent HTTP/session loop can remain open waiting for user input and never reaches the normal turn-finish path for the delegated wait.

The earlier `timeline()` overwrite concern is still worth hardening, but it is not the primary root cause for this incident. In this session, the runner never reached the `mark()` call that would have written the `done/waiting_child` turn.

Relevant code:

- `packages/opencode/src/session/prompt.ts`
  - `turn()` selects unfinished user turns.
  - `closed()` intentionally skips assistant messages with `finish="tool-calls"`.
  - `resumeAfter()` only resumes when pending callbacks remain in memory.
- `packages/opencode/src/session/runner.ts`
  - `mark()` should finish protocol turns with `waiting_child` when delegation was launched.
  - `execute()` only returns after `AgentProtocolExecutor.run()` completes.
- `packages/opencode/src/protocol/executor.ts`
  - A delegated action sets `wait = result.metadata.delegated === true`.
  - The executor does not add the action id to `ok`, but it also does not break.
  - This lets unrelated sibling actions run after a delegated wait.
- `packages/opencode/src/session/delegation.ts`
  - `assign()` calls `timeline(... status: "pending")`.
  - `notified()` calls `timeline(... notified_at)`.
  - `timeline()` writes the full user message with existing turn metadata.

## Fix Plan

1. Add a regression test that reproduces the exact pattern:
   - A user turn has `status: running`.
   - Its assistant has `finish: "tool-calls"` and completed time.
   - The user turn has delegation child metadata with `completed_at`, `result_id`, and `notified_at`.
   - A later internal/user message is queued.
   - `SessionPrompt.loop()` should mark or skip the stale delegation wait turn and process the queued message.

2. Fix protocol executor package boundaries:
   - When an action returns `metadata.delegated === true`, stop the current package immediately after recording that action.
   - Do not continue into independent `input` or `confirm` actions in the same package while delegated children are still outstanding.
   - The parent model should resume from the child result summary and decide whether to ask the user then.

3. Harden delegation timeline writes:
   - Re-read the latest owner user immediately before writing.
   - Preserve existing `turn.status: "done"`, `outcome`, `reason`, `assistant_id`, `run_id`, and completed time if another path already finished the turn.
   - Avoid writing stale `running` turn metadata over a completed turn.

4. Add repair coverage for already persisted sessions:
   - Detect internal/user turns whose assistant is completed with `finish="tool-calls"`, whose delegation children are all completed/notified, and where a later queued user turn exists.
   - Finish the stale parent turn with an appropriate outcome, likely `waiting_child` or `completed` depending on the stored child summary.
   - Then allow normal queued continuation processing.

5. Verify:
   - Run the focused prompt/delegation tests from `packages/opencode`.
   - Run `bun typecheck` from `packages/opencode`.
   - If app-facing behavior changes, run the app smoke check from `packages/app`.

## Open Decision

The repair outcome needs to stay semantically accurate. For a stale parent turn that launched children and has a queued delegation summary, the best persisted outcome appears to be `waiting_child` with reason `waiting_child`, because that is what the original protocol turn represented. The queued summary then determines whether the parent replies `blocked`, `completed`, or continues.
