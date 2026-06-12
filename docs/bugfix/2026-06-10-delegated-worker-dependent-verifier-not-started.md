# Bug Fix: Delegated Worker Dependent Verifier Not Started

## 问题描述

- 日期: 2026-06-10
- 严重程度: High
- 影响范围: Agent Protocol delegation run with worker actions and dependent verifier actions in the same package.

Session `ses_15031d725ffeElvFLSbZUmD9dh` dispatched worker `fix_m2_pipeline_checkboxes` to child session `ses_14f07baf3ffelYpu1hb9hMItTp`. The same protocol package also declared verifier `verify_m2_pipeline_checkboxes` with `depends: ["fix_m2_pipeline_checkboxes"]`.

The worker child called `ActionResult`, but the verifier child was not created automatically.

## 根因分析

There were three bugs in the exact path.

1. `AgentProtocolExecutor.run` recorded only the first remaining blocked action when delegated workers were still pending, then broke out of the queue. In this run, the first blocked remaining verifier was `fix_m4_e4_paths_and_test_test`, so later declared verifier `verify_m2_pipeline_checkboxes` was not persisted into the run actions.

2. The worker child called `ActionResult` and then produced a final plain-text assistant message. Completion code was using the final text message as the completion point, so `SessionDelegation.complete` did not see the earlier `ActionResult` tool part and the assignment stayed in `pending_delegations`.

3. Delegation gate discovery recognized system-injected verifiers through `verification.role`, but model-declared verifier actions such as `target: "verifier"` may only have `depends_on` and no `verification` metadata. Those explicit verifier gates were not selected for worker-result routing.

## 修复方案

- `packages/opencode/src/protocol/executor.ts`: when no queued action can run because dependencies are unfinished, record every remaining blocked action instead of only the first one.
- `packages/opencode/src/session/delegation.ts`: for `ActionResult` assignments, search backward through completed assistant messages up to the current completion point and use the latest completed `ActionResult` tool part. Also treat model-declared verifier agents that depend on the worker as verifier gates even when no `verification` metadata is present.
- `packages/opencode/src/session/runner.ts`: assigned sessions requiring `ActionResult` complete through `SessionDelegation.complete` without passing trailing plain text as the result.
- `docs/harness-protocol/04-routing-and-delegation-policy.md`: document blocked verifier persistence and ActionResult precedence over final plain-text tails.

## 验证步骤

1. Added executor regression coverage for two delegated workers plus two dependent verifier actions. Both verifier actions are now recorded as blocked and not executed prematurely.
2. Extended delegation regression coverage so a worker `ActionResult` followed by a plain-text final message still starts the verifier gate.
3. Covered explicit verifier actions with `depends_on` but without `verification` metadata.
4. Ran focused tests and typecheck.

## 相关测试

- `bun test test/protocol/executor.test.ts test/session/delegation.test.ts`
- `bun typecheck`

## 设计建议

Delegated worker dispatch is a pending state, not a completed dependency. The run must preserve all dependent gate actions so the later `ActionResult` handoff can route to the correct verifier sessions without asking the parent model to regenerate the package.
