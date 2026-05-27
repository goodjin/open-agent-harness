# MOD-00 Baseline Stabilization

## Document Info

- Mission: `opencode-agent-rewrite`
- Feature: `feature-mod-00-baseline`
- Task range: `T-0001~T-0006`
- Source plan: `docs/archive/agent-rewrite/00-revised-dev-plan.md`
- Baseline command: `git diff --name-status origin/dev`
- Recorded at: `2026-05-16T15:04:56+08:00`

## Scope Boundary

This document records the current phase-1 worktree. It does not implement MOD-01+ work, clean production code, or remove plugin/skill remnants. The only codebase changes for MOD-00 are this baseline record and orchestration state updates.

Untracked local paths seen in `git status --short` but not represented by `git diff --name-status origin/dev` include `.claude/`, `docs/`, `packages/opencode/bin/jin`, `packages/opencode/config.json`, and `packages/opencode/docs/`. They are tracked here as local orchestration or workspace artifacts, not as part of the diff inventory acceptance check.

## Changed File Inventory

The following inventory mirrors `git diff --name-status origin/dev` and maps each changed path to the planned module that should own follow-up stabilization.

| Status | Path | Module |
|---|---|---|
| M | `bun.lock` | MOD-11/MOD-00 package drift |
| A | `packages/opencode/config/agents/default/identity.md` | MOD-01 Agent schema |
| A | `packages/opencode/config/agents/default/meta.json` | MOD-01 Agent schema |
| A | `packages/opencode/config/agents/default/rules.md` | MOD-01 Agent schema |
| A | `packages/opencode/migration/20260514184707_add_session_dsl_context/migration.sql` | MOD-09 Timeline / MOD-13 Workflow |
| A | `packages/opencode/migration/20260514184707_add_session_dsl_context/snapshot.json` | MOD-09 Timeline / MOD-13 Workflow |
| M | `packages/opencode/package.json` | MOD-00 package drift |
| M | `packages/opencode/src/agent/agent.ts` | MOD-03 Agent prompt integration |
| A | `packages/opencode/src/agent/identity.ts` | MOD-03 Agent prompt integration |
| A | `packages/opencode/src/agent/loader.ts` | MOD-02 Agent loader and registry |
| D | `packages/opencode/src/agent/prompt/compaction.txt` | MOD-03 Agent prompt integration |
| D | `packages/opencode/src/agent/prompt/explore.txt` | MOD-03 Agent prompt integration |
| D | `packages/opencode/src/agent/prompt/summary.txt` | MOD-03 Agent prompt integration |
| D | `packages/opencode/src/agent/prompt/title.txt` | MOD-03 Agent prompt integration |
| A | `packages/opencode/src/agent/registry.ts` | MOD-02 Agent loader and registry |
| A | `packages/opencode/src/agent/rules.ts` | MOD-03 Agent prompt integration |
| A | `packages/opencode/src/agent/schema.ts` | MOD-01 Agent schema |
| M | `packages/opencode/src/cli/cmd/agent.ts` | MOD-02 Agent loader and registry |
| M | `packages/opencode/src/cli/cmd/debug/index.ts` | MOD-04 Skill removal |
| D | `packages/opencode/src/cli/cmd/debug/skill.ts` | MOD-04 Skill removal |
| M | `packages/opencode/src/cli/cmd/providers.ts` | MOD-05 Plugin removal |
| M | `packages/opencode/src/cli/cmd/run.ts` | MOD-05 Plugin removal |
| D | `packages/opencode/src/cli/cmd/tui/component/dialog-skill.tsx` | MOD-04 Skill removal |
| M | `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` | MOD-12 TUI workbench |
| M | `packages/opencode/src/cli/cmd/tui/context/local.tsx` | MOD-12 TUI workbench |
| M | `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | MOD-12 TUI workbench |
| A | `packages/opencode/src/cli/cmd/tui/routes/session/error-banner.tsx` | MOD-12 TUI workbench |
| M | `packages/opencode/src/cli/cmd/tui/routes/session/header.tsx` | MOD-12 TUI workbench |
| M | `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | MOD-12 TUI workbench |
| M | `packages/opencode/src/command/index.ts` | MOD-04 Skill removal |
| M | `packages/opencode/src/config/config.ts` | MOD-04/MOD-05 removal config |
| M | `packages/opencode/src/effect/instances.ts` | MOD-05 Plugin removal |
| M | `packages/opencode/src/permission/next.ts` | MOD-06 Permission capability and policy |
| M | `packages/opencode/src/permission/service.ts` | MOD-07 Permission approval flow |
| A | `packages/opencode/src/plugin-stub.ts` | MOD-05 Plugin removal |
| D | `packages/opencode/src/plugin/codex.ts` | MOD-05 Plugin removal |
| D | `packages/opencode/src/plugin/copilot.ts` | MOD-05 Plugin removal |
| D | `packages/opencode/src/plugin/index.ts` | MOD-05 Plugin removal |
| M | `packages/opencode/src/project/bootstrap.ts` | MOD-10 Workspace runtime |
| M | `packages/opencode/src/provider/auth-service.ts` | MOD-05 Plugin removal |
| M | `packages/opencode/src/provider/provider.ts` | MOD-05 Plugin removal |
| M | `packages/opencode/src/pty/index.ts` | MOD-05 Plugin removal |
| M | `packages/opencode/src/question/service.ts` | MOD-08 Session state machine |
| M | `packages/opencode/src/server/routes/session.ts` | MOD-09 Timeline / MOD-11 Protocol |
| M | `packages/opencode/src/server/server.ts` | MOD-11 Protocol |
| M | `packages/opencode/src/session/compaction.ts` | MOD-03/MOD-04 prompt cleanup |
| M | `packages/opencode/src/session/index.ts` | MOD-08 Session state machine |
| M | `packages/opencode/src/session/llm.ts` | MOD-03 Agent prompt integration |
| M | `packages/opencode/src/session/message-v2.ts` | MOD-11 Protocol |
| M | `packages/opencode/src/session/processor.ts` | MOD-08 Session state machine |
| M | `packages/opencode/src/session/prompt.ts` | MOD-03 Agent prompt integration |
| M | `packages/opencode/src/session/session.sql.ts` | MOD-09 Timeline / MOD-13 Workflow |
| M | `packages/opencode/src/session/status.ts` | MOD-08 Session state machine |
| M | `packages/opencode/src/session/system.ts` | MOD-03 Agent prompt integration |
| A | `packages/opencode/src/session/timeline.ts` | MOD-09 Timeline and checkpoint |
| D | `packages/opencode/src/skill/discovery.ts` | MOD-04 Skill removal |
| D | `packages/opencode/src/skill/index.ts` | MOD-04 Skill removal |
| D | `packages/opencode/src/skill/skill.ts` | MOD-04 Skill removal |
| M | `packages/opencode/src/storage/db.ts` | MOD-09 Timeline / migration |
| M | `packages/opencode/src/tool/bash.ts` | MOD-06/MOD-07 Permission |
| M | `packages/opencode/src/tool/question.ts` | MOD-07 Permission approval flow |
| M | `packages/opencode/src/tool/registry.ts` | MOD-04 Skill removal |
| D | `packages/opencode/src/tool/skill.ts` | MOD-04 Skill removal |
| M | `packages/opencode/src/tool/task.ts` | MOD-06 Permission capability and policy |
| M | `packages/opencode/test/acp/event-subscription.test.ts` | MOD-11 Protocol |
| D | `packages/opencode/test/agent/agent.test.ts` | MOD-03 Agent prompt integration |
| A | `packages/opencode/test/agent/identity-rules.test.ts` | MOD-03 Agent prompt integration |
| A | `packages/opencode/test/agent/loader.test.ts` | MOD-02 Agent loader and registry |
| A | `packages/opencode/test/agent/registry.test.ts` | MOD-02 Agent loader and registry |
| A | `packages/opencode/test/agent/schema.test.ts` | MOD-01 Agent schema |
| A | `packages/opencode/test/agent/switch-session-state.test.ts` | MOD-03 Agent prompt integration |
| A | `packages/opencode/test/permission-inheritance.test.ts` | MOD-06 Permission capability and policy |
| A | `packages/opencode/test/permission/agent-isolation.test.ts` | MOD-06 Permission capability and policy |
| M | `packages/opencode/test/permission/next.test.ts` | MOD-06/MOD-07 Permission |
| A | `packages/opencode/test/permission/six-dimension.test.ts` | MOD-06 Permission capability and policy |
| D | `packages/opencode/test/plugin/auth-override.test.ts` | MOD-05 Plugin removal |
| D | `packages/opencode/test/plugin/codex.test.ts` | MOD-05 Plugin removal |
| M | `packages/opencode/test/server/global-session-list.test.ts` | MOD-10/MOD-11 Protocol |
| M | `packages/opencode/test/server/session-list.test.ts` | MOD-10/MOD-11 Protocol |
| M | `packages/opencode/test/server/session-messages.test.ts` | MOD-11 Protocol |
| M | `packages/opencode/test/server/session-select.test.ts` | MOD-11 Protocol |
| M | `packages/opencode/test/session/messages-pagination.test.ts` | MOD-11 Protocol |
| M | `packages/opencode/test/session/prompt.test.ts` | MOD-03 Agent prompt integration |
| M | `packages/opencode/test/session/revert-compact.test.ts` | MOD-09 Timeline and checkpoint |
| M | `packages/opencode/test/session/session.test.ts` | MOD-08 Session state machine |
| A | `packages/opencode/test/session/status.test.ts` | MOD-08 Session state machine |
| M | `packages/opencode/test/session/structured-output-integration.test.ts` | MOD-08 Session state machine |
| A | `packages/opencode/test/session/timeline.test.ts` | MOD-09 Timeline and checkpoint |
| A | `packages/opencode/test/session/workspace-binding.test.ts` | MOD-10 Workspace runtime |
| D | `packages/opencode/test/skill/discovery.test.ts` | MOD-04 Skill removal |
| D | `packages/opencode/test/skill/skill.test.ts` | MOD-04 Skill removal |
| A | `packages/opencode/test/tool/permission-binding.test.ts` | MOD-07 Permission approval flow |
| M | `packages/opencode/test/tool/read.test.ts` | MOD-06 Permission capability and policy |
| D | `packages/opencode/test/tool/skill.test.ts` | MOD-04 Skill removal |
| M | `packages/web/package.json` | MOD-11/MOD-00 package drift |

## Test File Classification

| Bucket | Files | Rationale |
|---|---|---|
| Keep | `packages/opencode/test/agent/identity-rules.test.ts`, `packages/opencode/test/agent/loader.test.ts`, `packages/opencode/test/agent/registry.test.ts`, `packages/opencode/test/agent/schema.test.ts`, `packages/opencode/test/agent/switch-session-state.test.ts` | Agent template tests are the phase-1 replacement surface for the removed legacy agent fixture test. |
| Keep | `packages/opencode/test/permission-inheritance.test.ts`, `packages/opencode/test/permission/agent-isolation.test.ts`, `packages/opencode/test/permission/next.test.ts`, `packages/opencode/test/permission/six-dimension.test.ts`, `packages/opencode/test/tool/permission-binding.test.ts` | Current permission coverage passes and protects the partial `PermissionNext` behavior until MOD-06/MOD-07 formalize v2 modules. |
| Keep | `packages/opencode/test/session/status.test.ts`, `packages/opencode/test/session/timeline.test.ts`, `packages/opencode/test/session/workspace-binding.test.ts`, existing modified session/server tests | These tests cover phase-1 status, timeline, workspace, and protocol behavior. |
| Rewrite | `packages/opencode/test/agent/agent.test.ts` | Deleted. Legacy agent config behavior should be rewritten as template schema, loader, registry, prompt, and switch-session tests. |
| Delete | `packages/opencode/test/plugin/auth-override.test.ts`, `packages/opencode/test/plugin/codex.test.ts` | Deleted source files `src/plugin/codex.ts`, `src/plugin/copilot.ts`, and `src/plugin/index.ts` remove the tested runtime behavior. MOD-05 must replace with explicit fork behavior or unsupported-plugin tests. |
| Delete | `packages/opencode/test/skill/discovery.test.ts`, `packages/opencode/test/skill/skill.test.ts`, `packages/opencode/test/tool/skill.test.ts` | Deleted source files `src/skill/*` and `src/tool/skill.ts` remove the tested runtime behavior. MOD-04 must replace with migration-warning and no-registration tests. |
| Add | `packages/opencode/test/config/*` removal fixtures, `packages/opencode/test/tool/registry.test.ts` skill exclusion case, TUI stale-skill/plugin presentation checks | Needed by MOD-04/MOD-05 to prove deleted systems have no surviving user-facing or registry paths. |
| Add | Loader diagnostics and no-temp-log tests | Needed by MOD-02 because current code still writes `/tmp/opencode-agents.log`. |
| Add | SDK/protocol contract tests | Needed by MOD-11 after session/timeline endpoints stabilize. |

Deleted source file coverage decisions:

| Deleted Source | Test Decision |
|---|---|
| `packages/opencode/src/agent/prompt/compaction.txt` | Rewrite into prompt snapshot and compaction fallback tests under MOD-03. |
| `packages/opencode/src/agent/prompt/explore.txt` | Rewrite into agent prompt/default-agent tests if explore mode remains supported. |
| `packages/opencode/src/agent/prompt/summary.txt` | Rewrite into summary/compaction prompt tests under MOD-03. |
| `packages/opencode/src/agent/prompt/title.txt` | Rewrite into title fallback tests under MOD-03. |
| `packages/opencode/src/cli/cmd/debug/skill.ts` | Delete legacy tests; add no-stale-debug-command check under MOD-04. |
| `packages/opencode/src/cli/cmd/tui/component/dialog-skill.tsx` | Delete legacy tests; add TUI visible stale-skill absence check under MOD-12. |
| `packages/opencode/src/plugin/codex.ts` | Delete legacy plugin test; add unsupported/replaced auth behavior tests under MOD-05. |
| `packages/opencode/src/plugin/copilot.ts` | Delete legacy plugin test; add first-class provider auth coverage under MOD-05. |
| `packages/opencode/src/plugin/index.ts` | Delete legacy plugin test; add no `Plugin.*` production call-site check under MOD-05. |
| `packages/opencode/src/skill/discovery.ts` | Delete legacy skill discovery tests; add config migration warning tests under MOD-04. |
| `packages/opencode/src/skill/index.ts` | Delete legacy skill tests; add no runtime import check under MOD-04. |
| `packages/opencode/src/skill/skill.ts` | Delete legacy skill tests; add no command/autocomplete reference checks under MOD-04. |
| `packages/opencode/src/tool/skill.ts` | Delete legacy tool test; add tool registry excludes skill test under MOD-04. |

## Phase-1 Acceptance Checklist

- Agent: default package template exists, template schema is stable, package/user precedence is deterministic, malformed templates produce diagnostics without hiding valid templates, and prompt injection order is covered by tests.
- Session: lifecycle states cover `idle`, `running`, `waiting_permission`, `waiting_user`, `error`, and `retry`; status transitions publish events; workspace binding is enforced; timeline checkpoints preserve `dsl_context`.
- Permission: current `PermissionNext` compatibility behavior is covered; six dimensions are named in tests; ask/once/always/reject flows preserve pending request scope; future MOD-06 must move matcher logic out of tests into production modules.
- Skill: deleted source has no runtime registration, CLI/debug/TUI surfaces are removed or migrated, and user-facing docs describe the unsupported `.opencode/skill` path.
- Plugin: no production path depends on `plugin-stub.ts` by release; provider auth, shell env, and tool registry extension points are explicit or intentionally unsupported.
- TUI: header/status/error surfaces are visible for all phase-1 states; agent switching is visible and does not expose stale skill/plugin panels.
- Repository hygiene: no ad hoc production temp logging remains; package drift is intentional; SDK regeneration is run if MOD-11 changes routes or contracts.

## Focused Verification

All commands were run from `packages/opencode`.

| Command | Result |
|---|---|
| `bun typecheck` | Passed. `tsgo --noEmit` completed successfully. |
| `bun test test/agent test/session/status.test.ts test/session/timeline.test.ts test/session/workspace-binding.test.ts test/permission test/permission-inheritance.test.ts test/tool/permission-binding.test.ts --timeout 30000` | Passed. 284 tests, 0 failures, 534 assertions across 15 files. |

## Temporary Diagnostics

`rg -n "opencode-agents\\.log|/tmp/|tmpdir|Bun\\.write\\(" packages/opencode/src packages/opencode/test docs .claude` found expected test tempdir usage and these production diagnostic traces:

| Path | Diagnostic |
|---|---|
| `packages/opencode/src/agent/agent.ts` | `appendLog()` writes `/tmp/opencode-agents.log`. |
| `packages/opencode/src/agent/loader.ts` | `appendLog()` writes `/tmp/opencode-agents.log`. |
| `packages/opencode/src/agent/registry.ts` | `appendLog()` writes `/tmp/opencode-agents.log`. |
| `packages/opencode/src/cli/cmd/tui/context/local.tsx` | TUI local registry load appends to `/tmp/opencode-agents.log`. |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | TUI sync response appends to `/tmp/opencode-agents.log`. |
| `packages/opencode/src/server/server.ts` | `/agent` route logs returned modes to `console.log` and appends them to `/tmp/opencode-agents.log`. |
| `packages/opencode/src/cli/cmd/tui/util/editor.ts` | Uses `os.tmpdir()` for editor scratch file; this is regular user-flow scratch behavior, not agent diagnostics. |
| `packages/opencode/src/cli/cmd/tui/util/clipboard.ts` | Uses `os.tmpdir()` for clipboard image temp file; this is regular user-flow scratch behavior, not agent diagnostics. |

MOD-02 should remove the agent temp log writes. MOD-00 records them only.

## Naming Cleanup Notes

Touched code currently contains identifiers that should be shortened or centralized in follow-up cleanup:

- `appendLog` appears in `agent.ts`, `loader.ts`, and `registry.ts`; remove with temp diagnostics or replace with the existing `Log` facility.
- `/agent` route diagnostics in `src/server/server.ts` should remove both the `console.log` and `/tmp/opencode-agents.log` append when MOD-02 cleans production temp logging.
- `BUILTIN_DEFAULT_AGENT`, `baseDir`, `fallbackDir`, `metaFiles`, `metaPath`, `agentDir`, `agentId`, `identityPath`, `rulesPath`, and `metaContent` in `src/agent/loader.ts` should be reviewed against the single-word naming rule. Likely shorter forms: `builtin`, `base`, `fallback`, `files`, `file`, `dir`, `id`, `identity`, `rules`, `text`.
- `buildPermission` is duplicated in `src/agent/agent.ts` and `src/agent/registry.ts`; MOD-02 task `T-0205` should centralize it and prefer a shorter helper name if clear.
- `whitelistedDirs`, `hasExplicitTruncateDeny`, `workflowModeToMode`, `transformToInfo`, and `currentAgentId` are multi-word helpers/locals that should be shortened when the permission conversion is centralized.
- `registryBaseDir`, `registryAgents`, `setRegistryAgents`, `getFirstValidModel`, `visibleAgents`, and `agentStore` in `src/cli/cmd/tui/context/local.tsx` should be revisited in MOD-12 TUI cleanup.
- `providersResponse`, `providerListResponse`, `agentsResponse`, `configResponse`, and `sessionListResponse` in `src/cli/cmd/tui/context/sync.tsx` are new compound locals that can likely become `providers`, `list`, `agents`, `config`, and `sessions` after promise handling is simplified.

## MOD-00 Acceptance Status

- T-0001: Completed. Diff inventory maps every `git diff --name-status origin/dev` entry to an owning module.
- T-0002: Completed. Existing changed/deleted test files are classified and every deleted source file has a test decision.
- T-0003: Completed. Phase-1 checklist covers Agent, Session, Permission, Skill, Plugin, and TUI.
- T-0004: Completed. Focused typecheck and tests are recorded with passing results.
- T-0005: Completed. Temporary diagnostics are identified and scoped to follow-up cleanup.
- T-0006: Completed for baseline. Naming cleanup candidates are recorded; no production code was edited in MOD-00.
