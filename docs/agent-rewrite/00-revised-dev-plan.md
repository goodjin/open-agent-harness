# OpenCode Agent Rewrite Revised Development Plan

## Document Info

- Project: jin-opencode agent rewrite
- Mission ID: opencode-agent-rewrite
- Baseline: current `dev` worktree, after initial Agent/Session/Permission changes
- Date: 2026-05-16
- Default branch: `dev`

## Current State Summary

The project is no longer a clean upstream OpenCode tree. It already contains a partial fork-oriented rewrite:

- Agent templates exist under `packages/opencode/config/agents/default`.
- Agent schema, loader, registry, identity parsing, and rules parsing exist.
- Skill source files and plugin source files have been deleted, but plugin behavior is still represented by a no-op `plugin-stub.ts`.
- Session status has been extended to `idle`, `running`, `waiting_permission`, `waiting_user`, `error`, and `retry`.
- Session `dsl_context`, timeline checkpoint listing, and restore exist.
- Tool permission binding and six-dimensional permission tests exist, but the implementation is still centered on `PermissionNext.Ruleset`.
- Memory and Workflow are still design-level only.

The revised plan treats the current code as a phase-1 prototype and focuses first on making it coherent, testable, and shippable before expanding into protocol, workflow, memory, and channels.

## Delivery Types

| Type | Meaning | Required Verification |
|---|---|---|
| library | Internal module called by other code | Unit tests, typecheck, behavior assertions |
| interface | CLI, HTTP, SDK, database migration, or protocol surface | Contract tests, route tests, migration tests, SDK regeneration where needed |
| presentation | TUI/Web/Desktop visible behavior | Rendering tests or E2E/manual visible output verification |

## Global Verification Rules

- Run all tests from `packages/opencode`, never from repo root.
- Run `bun typecheck` from `packages/opencode` for every batch.
- For API or SDK changes, regenerate the JavaScript SDK with `./packages/sdk/js/script/build.ts`.
- For database schema changes, include migration and migration snapshot tests.
- For TUI presentation changes, include at least one test or manual checklist that verifies the user can see the state in the terminal.
- Avoid mocks unless the real implementation is impossible to exercise cheaply.

## Batch Overview

| Batch | Goal | Modules | Exit Gate |
|---|---|---|---|
| B0 | Stabilize current worktree | repository hygiene, drift map | typecheck and focused tests pass |
| B1 | Finish Agent template system | schema, loader, registry, prompts, TUI | default and custom agents work end to end |
| B2 | Remove Skill/Plugin cleanly | config, auth, providers, tools, docs | no runtime dependency on removed systems |
| B3 | Formalize Permission v2 | capability, policy, inheritance, six dimensions | tool gates enforce policy with tests |
| B4 | Finish Session/Timeline | states, workspace, checkpoint, workflow context | restore recovers files, permissions, workflow state |
| B5 | Canonical protocol and SDK | routes, events, replay, SDK | TUI/Web/SDK consume same contract |
| B6 | TUI Workbench adaptation | agent switch, statuses, permission UX | visible terminal workflows verified |
| B7 | Workflow DSL foundation | schema, parser, executor, recovery | simple workflows run and resume |
| B8 | Memory foundation | extraction, Qdrant adapter, retrieval | memories indexed and recalled by project/session |
| B9 | Multi-project/worktree runtime | project API, workspace routing | one instance serves multiple projects |
| B10 | Observability/evaluation | metrics, traces, audit, regression suite | repeatable quality gates |
| B11 | Release hardening | cleanup, docs, CI, packaging | shippable fork baseline |

## Module MOD-00: Baseline Stabilization

| Task | Delivery | Scope | Verification |
|---|---|---|---|
| T-0001 | library | Record current changed file inventory and map each file to a module. | Diff inventory matches `git diff --name-status origin/dev`. |
| T-0002 | library | Classify existing test files into keep, rewrite, delete, and add buckets. | Every deleted source file has corresponding test decision. |
| T-0003 | library | Add a phase-1 acceptance checklist to docs. | Checklist covers Agent, Session, Permission, Skill, Plugin, TUI. |
| T-0004 | library | Run focused phase-1 typecheck and tests, store command list in docs. | `bun typecheck` and focused phase-1 tests pass from `packages/opencode`. |
| T-0005 | library | Identify temporary diagnostics such as `/tmp/opencode-agents.log`. | No production path writes ad hoc temp logs after cleanup tasks. |
| T-0006 | library | Normalize naming in touched code according to repo style. | New identifiers reviewed for unnecessary camelCase compounds. |

## Module MOD-01: Agent Template Schema

| Task | Delivery | Scope | Verification |
|---|---|---|---|
| T-0101 | library | Freeze `meta.json` schema fields and defaults. | Schema tests cover required, optional, invalid, and default cases. |
| T-0102 | library | Align default `meta.json` with schema field names. | Default template parses without warnings. |
| T-0103 | library | Validate `model_preference` against provider/model ids when available. | Invalid provider/model produces clear validation error. |
| T-0104 | library | Define allowed `workflow_mode` semantics. | `auto`, `manual`, and `supervision` map to documented runtime behavior. |
| T-0105 | library | Define allowed `permission_mode` semantics. | `strict`, `lax`, and `custom` produce distinct permission defaults. |
| T-0106 | library | Add duplicate id and directory mismatch checks. | Duplicate/mismatched ids are rejected or warned deterministically. |
| T-0107 | library | Add schema documentation for agent authors. | Docs include minimal and full templates. |
| T-0108 | library | Add fixture-based schema regression tests. | All fixture templates produce expected parse results. |

## Module MOD-02: Agent Loader And Registry

| Task | Delivery | Scope | Verification |
|---|---|---|---|
| T-0201 | library | Remove ad hoc temp-file logging from loader and registry. | No `/tmp/opencode-agents.log` writes remain. |
| T-0202 | library | Load package templates and user templates with deterministic precedence. | User template overrides package template with same id. |
| T-0203 | library | Add cache invalidation on config/template changes. | Reload test sees changed template without process restart. |
| T-0204 | library | Preserve malformed template diagnostics without crashing all loading. | Bad template test returns valid templates plus warning event. |
| T-0205 | library | Unify duplicate permission construction in `agent.ts` and `registry.ts`. | One implementation is covered by tests. |
| T-0206 | interface | Add CLI command to list template paths and validation state. | CLI lists valid and invalid templates with exit codes. |
| T-0207 | interface | Add CLI command to validate a single template directory. | Valid directory exits 0, invalid directory exits nonzero. |
| T-0208 | library | Ensure default agent fallback is complete enough for compaction/title use. | Missing specialized agents do not break compaction/title flows. |

## Module MOD-03: Agent Prompt Integration

| Task | Delivery | Scope | Verification |
|---|---|---|---|
| T-0301 | library | Inject `identity.md` into the model system prompt. | Prompt test sees identity content in generated messages. |
| T-0302 | library | Inject `rules.md` after identity with stable ordering. | Prompt test verifies identity before rules. |
| T-0303 | library | Decide where legacy instruction files fit relative to templates. | Prompt test covers template plus project instructions. |
| T-0304 | library | Preserve model-specific provider transforms after template injection. | Provider transform tests still pass. |
| T-0305 | library | Add agent-specific compaction/title fallback prompts. | Compaction and title tests pass when only default template exists. |
| T-0306 | interface | Make `/agent` or equivalent CLI switch update runtime registry state. | Switching affects the next prompt without losing messages. |
| T-0307 | library | Persist selected agent per session if required by current UX. | Session reload restores selected agent. |
| T-0308 | library | Add prompt snapshot tests for default and custom agents. | Snapshots are stable and include expected template sections. |

## Module MOD-03A: Agent Entry And Capability Semantics

Current `mode: primary | subagent | all` mixes independent concepts: main conversation eligibility, delegation eligibility, mention/autocomplete visibility, default-agent eligibility, UI hiding, and dispatch metadata. Split these into explicit template fields so every agent can be delegated when appropriate and permissions remain independent of invocation surface.

| Task | Delivery | Scope | Verification |
|---|---|---|---|
| T-03A1 | architecture | Add `entry` design to agent schema docs. | `docs/agent-rewrite/02-agent-author-schema.md` documents `primary`, `delegable`, `mentionable`, `default`, and `hidden`. |
| T-03A2 | architecture | Add `capability` design to agent schema docs. | Docs describe `purpose`, `tags`, `cost`, and `writes`, and state that `writes` is metadata, not permission enforcement. |
| T-03A3 | library | Extend `AgentTemplate.Meta` with `entry` and `capability`. | Schema tests cover minimal defaults, full config, and invalid capability values. |
| T-03A4 | library | Keep `mode` as legacy compatibility input and map it to `entry`. | Tests show `primary`, `subagent`, and `all` map to expected entry flags; explicit `entry` wins over `mode`. |
| T-03A5 | library | Return `entry` and `capability` from registry and agent info while preserving derived `mode`. | `/agent` and registry tests include new fields and old clients still receive a compatible `mode`. |
| T-03A6 | library | Change default-agent selection to entry semantics. | `entry.primary && entry.default && !entry.hidden` agents are eligible; hidden or non-primary agents produce clear errors. |
| T-03A7 | presentation | Update primary picker, mention autocomplete, and delegation candidate filters. | Primary picker uses `entry.primary`, mention uses `entry.mentionable`, delegation uses `entry.delegable`. |
| T-03A8 | configuration | Migrate packaged agent templates to `entry` plus `capability`. | Loader validates all packaged templates; built-in target matrix in schema docs matches files. |
| T-03A9 | interface | Update command/subtask docs that currently describe subagent behavior through `mode`. | Docs explain command subtask execution as an invocation style, not a permanent agent type. |
| T-03A10 | verification | Regenerate SDK if OpenAPI shapes change and run focused checks. | `bun typecheck`, `bun test test/agent --timeout 30000`, and SDK generation pass or blockers are documented. |

## Module MOD-04: Skill Removal

| Task | Delivery | Scope | Verification |
|---|---|---|---|
| T-0401 | library | Remove skill config schema fields if no longer supported. | Config fixtures with old skill fields produce documented warning or error. |
| T-0402 | library | Remove skill references from command loading and autocomplete. | No `source === "skill"` branches remain unless documented compatibility requires them. |
| T-0403 | presentation | Remove skill dialog and status references from TUI. | User-visible status no longer shows stale skill/plugin UI. |
| T-0404 | library | Remove `skill` from compaction prune-protected tool list. | Compaction tests pass without special skill handling. |
| T-0405 | library | Delete stale skill tests or rewrite them as agent-template tests. | Test suite has no references to deleted skill source. |
| T-0406 | interface | Add migration note for users who had `.opencode/skill`. | Docs explain unsupported path and replacement. |
| T-0407 | library | Search and remove stale skill docs in package docs where fork docs should diverge. | `rg "skill"` only finds intentional compatibility notes. |
| T-0408 | library | Verify tool registry has no skill tool registration. | Registry test confirms tool list excludes skill. |

## Module MOD-05: Plugin Removal

| Task | Delivery | Scope | Verification |
|---|---|---|---|
| T-0501 | library | Inventory every `Plugin.trigger/list/init` call site. | Inventory maps each call to remove, replace, or keep-noop. |
| T-0502 | library | Replace shell/env plugin hooks with direct config-based env extension or delete behavior. | Bash/Pty env tests pass without plugin stub. |
| T-0503 | library | Replace provider plugin auth hooks with first-class provider auth extension point or remove UI path. | Provider auth tests cover supported methods only. |
| T-0504 | library | Replace tool-definition plugin hook with explicit tool registry extension policy. | Tool registry tests pass without `@opencode-ai/plugin` runtime calls. |
| T-0505 | library | Remove `plugin-stub.ts` after all call sites are resolved. | `rg "plugin-stub|Plugin\\." packages/opencode/src` returns no production call sites. |
| T-0506 | library | Remove plugin config loading if unsupported. | Config tests cover plugin field rejection or warning. |
| T-0507 | presentation | Remove plugin status UI or replace with fork-specific extension status. | TUI status screen has no dead plugin count. |
| T-0508 | interface | Document unsupported plugin behavior and migration path. | Docs state plugin system is intentionally removed. |

## Module MOD-06: Permission Capability And Policy

| Task | Delivery | Scope | Verification |
|---|---|---|---|
| T-0601 | library | Add `src/permission/capability.ts` with capability model. | Capability unit tests cover tool/file/command/network/agent/quota. |
| T-0602 | library | Add `src/permission/policy.ts` with policy model. | Policy parse tests cover allow, deny, ask, and invalid policy. |
| T-0603 | library | Add conversion from agent template permissions to capabilities. | Template allowed/denied tools produce expected capabilities. |
| T-0604 | library | Add conversion from legacy `PermissionNext.Ruleset` to policy. | Existing config permissions preserve behavior. |
| T-0605 | library | Implement inheritance calculation for user, project, session, agent, and tool layers. | Last-match and explicit-deny precedence tests pass. |
| T-0606 | library | Implement six-dimensional matcher as named module, not test-only convention. | Six-dimension tests call production matcher directly. |
| T-0607 | library | Make denied tool calculation use policy output. | Disabled tool tests match expected UI/tool availability. |
| T-0608 | interface | Add permission inspection endpoint. | Route returns effective policy for a session and agent. |
| T-0609 | interface | Add permission decision trace for debugging. | Decision includes matched rule and source layer. |
| T-0610 | library | Keep `PermissionNext` as compatibility facade only. | New code imports v2 modules; compatibility tests still pass. |

## Module MOD-07: Permission Approval Flow

| Task | Delivery | Scope | Verification |
|---|---|---|---|
| T-0701 | library | Ensure `ask` sets `waiting_permission` and restores prior status after reply. | Status transition tests cover ask/once/always/reject. |
| T-0702 | library | Scope pending approvals by workspace and session. | Cross-session tests verify no leakage. |
| T-0703 | library | Resolve matching pending approvals on `always`. | Existing and new pending requests resolve only when patterns match. |
| T-0704 | library | Add correction feedback path to tool result. | Rejected-with-message returns model-visible corrective error. |
| T-0705 | interface | Add route to list pending approvals by session. | Route returns only current session pending approvals. |
| T-0706 | interface | Add route to approve/reject with optional feedback. | Route tests cover once, always, reject, feedback. |
| T-0707 | presentation | Update TUI permission panel for v2 decision trace. | User can see requested action, pattern, source rule. |
| T-0708 | library | Add audit event for approval decisions. | Event test sees asked and replied events with request ids. |

## Module MOD-08: Session State Machine

| Task | Delivery | Scope | Verification |
|---|---|---|---|
| T-0801 | library | Define legal state transitions. | Invalid transition test fails with clear error. |
| T-0802 | library | Restore idle status after prompt completion. | Prompt lifecycle test ends idle. |
| T-0803 | library | Set error status on non-permission runtime failures. | Route/processor error test exposes error status. |
| T-0804 | library | Set retry status during provider retry delay. | Retry test includes attempt, message, and next timestamp. |
| T-0805 | library | Add waiting_user status for question/tool user input. | Question tool test sets waiting_user. |
| T-0806 | interface | Expose single-session status endpoint in addition to global status if needed. | Route returns status for one session. |
| T-0807 | library | Persist or reconstruct status after process restart decision. | Restart behavior is documented and tested as volatile or persisted. |
| T-0808 | presentation | TUI header renders all six states. | Rendering/manual checklist verifies visible labels. |

## Module MOD-09: Timeline And Checkpoint

| Task | Delivery | Scope | Verification |
|---|---|---|---|
| T-0901 | library | Ensure every step-start checkpoint includes snapshot hash. | Timeline test lists hashes for multi-step session. |
| T-0902 | library | Store permission state in checkpoint metadata. | Restore test recovers permission grants. |
| T-0903 | library | Store `dsl_context` in checkpoint metadata. | Restore test recovers workflow state. |
| T-0904 | library | Validate restore hash belongs to current session. | Restoring unrelated hash fails safely. |
| T-0905 | library | Add restore dry-run or diff preview if needed for UI. | Preview test shows changed files without mutation. |
| T-0906 | interface | Finalize checkpoint list and restore endpoints. | Route tests cover list, restore, invalid hash, missing session. |
| T-0907 | presentation | Add TUI checkpoint restore flow or command. | User can choose checkpoint and see restore result. |
| T-0908 | library | Add audit event for checkpoint restore. | Event test includes session id and checkpoint hash. |

## Module MOD-10: Workspace And Project Runtime

| Task | Delivery | Scope | Verification |
|---|---|---|---|
| T-1001 | library | Reconcile `specs/project.md` with current workspace code. | Spec gap table exists. |
| T-1002 | library | Define Project, Workspace, Worktree identity boundaries. | Type tests prevent mixing ids. |
| T-1003 | interface | Implement or align `GET /project`. | Route returns projects for current instance. |
| T-1004 | interface | Implement or align `POST /project/init`. | Route initializes project and returns id. |
| T-1005 | interface | Implement project-scoped session list/get/create. | Route tests confirm project filtering. |
| T-1006 | library | Enforce workspace id on session create/fork consistently. | Session tests cover create/fork with and without workspace context. |
| T-1007 | interface | Move awkward directory query routes toward project-scoped routes. | Compatibility tests document old and new route behavior. |
| T-1008 | library | Add multi-worktree isolation tests. | Session A cannot access workspace B files/status. |

## Module MOD-11: Canonical Protocol And Events

| Task | Delivery | Scope | Verification |
|---|---|---|---|
| T-1101 | interface | Define canonical event envelope with sequence id. | Event schema tests cover required fields. |
| T-1102 | interface | Add event replay from sequence id. | Replay test returns missed events in order. |
| T-1103 | interface | Add session-scoped event subscription filtering. | Subscriber receives only requested session events. |
| T-1104 | interface | Add workspace-scoped event filtering. | Workspace tests prevent cross-workspace event leakage. |
| T-1105 | interface | Include workflow DSL and permission events in gateway. | Gateway emits state, permission, checkpoint events. |
| T-1106 | interface | Update OpenAPI docs for new routes. | Generated OpenAPI includes new schemas. |
| T-1107 | interface | Regenerate JavaScript SDK. | SDK compiles and includes new methods. |
| T-1108 | library | Add contract tests between server routes and SDK client. | SDK calls exercise real server route handlers. |

## Module MOD-12: TUI Workbench

| Task | Delivery | Scope | Verification |
|---|---|---|---|
| T-1201 | presentation | Show current agent in session header. | User can see agent name in TUI header. |
| T-1202 | presentation | Show session status in header. | User can see ready/thinking/awaiting/error/retry states. |
| T-1203 | presentation | Add agent switch picker using template registry. | User can switch agent and next prompt uses it. |
| T-1204 | presentation | Render permission decision trace in permission UI. | User can see why approval is requested. |
| T-1205 | presentation | Render error banner with clear dismissal semantics. | Dismissal changes status without aborting unrelated work. |
| T-1206 | presentation | Add checkpoint list and restore command if timeline UI is in scope. | User can restore a visible checkpoint from TUI. |
| T-1207 | presentation | Remove stale skill/plugin UI surfaces. | User no longer sees dead skill/plugin panels. |
| T-1208 | presentation | Add TUI smoke test/manual script for primary workflows. | Script covers start, prompt, permission, agent switch, error. |

## Module MOD-13: Workflow DSL

Design reference: `docs/agent-rewrite/06-workflow-dsl-design.md`.
Implementation plan: `docs/agent-rewrite/07-workflow-dsl-implementation-plan.md`.
Agent design: `docs/agent-rewrite/08-workflow-runner-agent.md`.

| Task | Delivery | Scope | Verification |
|---|---|---|---|
| T-1301 | library | Define workflow DAG schema and node state schema. | Schema tests cover valid and invalid workflow and node files. |
| T-1302 | library | Add workflow template discovery and durable run directory creation. | Loader finds package/user templates and materializes unique run directories. |
| T-1303 | library | Add parser for nodes, dependencies, guards, inputs, outputs, and error policy. | Parser fixture tests cover DAG dependencies, branching, and invalid cycles. |
| T-1304 | library | Add durable execution state stored in workflow and node files. | State tests cover node progress, attempts, result, and restart recovery. |
| T-1305 | library | Execute DAG workflows with runtime-controlled scheduling. | Integration test runs serial and parallel-ready nodes while scheduler owns concurrency. |
| T-1306 | library | Add node type to agent routing through registry capability metadata. | Routing tests choose agents by node type without hard-coded agent ids. |
| T-1307 | library | Add guard evaluation with permission gate. | Guard test denies unsafe transition. |
| T-1308 | library | Add checkpoint creation before mutating nodes. | Workflow restore returns to prior node state. |
| T-1309 | library | Add pause/resume for waiting_user and waiting_permission. | Resume test continues after approval/user answer. |
| T-1310 | library | Add runtime runner dispatch for `chat` and `workflow`. | Ordinary agents keep chat behavior; `workflow-runner` enters workflow runner path. |
| T-1311 | interface | Add workflow run/list/status endpoints. | Route tests cover create, status, abort, and resumed durable runs. |
| T-1312 | presentation | Show workflow progress in TUI if enabled. | User can see current node and paused reason. |
| T-1313 | library | Add Decision Agent recovery hook using Planner first. | Failure tests cover retry, add node, replan, and abort decisions. |

## Module MOD-14: Memory System

| Task | Delivery | Scope | Verification |
|---|---|---|---|
| T-1401 | library | Define memory record and chunk types. | Type/schema tests cover session and chunk records. |
| T-1402 | library | Add Qdrant adapter interface and local test adapter. | Adapter contract tests pass against local/test implementation. |
| T-1403 | library | Add topic extraction prompt and structured output parser. | Parser handles valid output and malformed output. |
| T-1404 | library | Trigger extraction during compaction/completion. | Compaction test creates memory candidate. |
| T-1405 | library | Store session-level memory summary. | Memory store test writes and reads summary by session. |
| T-1406 | library | Store selected message chunks under size policy. | Chunk policy test excludes large file/snapshot content. |
| T-1407 | library | Add semantic retrieval with project/session/topic filters. | Retrieval test filters by project and topic. |
| T-1408 | library | Add LLM semantic judge/reranker abstraction. | Reranker test selects high-relevance memory. |
| T-1409 | interface | Add memory search endpoint. | Route returns ranked memories with source session ids. |
| T-1410 | library | Add privacy and isolation rules for subagents. | Subagent memory tests cover isolation and sharing. |

## Module MOD-15: Evaluation And Observability

| Task | Delivery | Scope | Verification |
|---|---|---|---|
| T-1501 | library | Define audit event taxonomy. | Audit schema tests cover permission, restore, workflow, memory. |
| T-1502 | library | Emit metrics for agent load, permission evaluation, tool calls, and session lifecycle. | Metrics tests verify names and labels. |
| T-1503 | library | Emit trace spans for prompt loop and tool calls. | Trace tests verify parent/child relationships where feasible. |
| T-1504 | interface | Add audit log query endpoint. | Route filters by session/project/event type. |
| T-1505 | library | Build regression scenarios for core workflows. | Regression suite covers agent switch, permission, restore, workflow. |
| T-1506 | library | Add performance checks for loader/session/permission targets. | Bench tests or timed tests stay below documented thresholds. |
| T-1507 | library | Add failure-mode tests for provider errors and retries. | Error and retry statuses are deterministic. |
| T-1508 | interface | Add CI commands for phase gates. | CI documentation and package scripts run the same checks. |

## Module MOD-16: Release Hardening

| Task | Delivery | Scope | Verification |
|---|---|---|---|
| T-1601 | library | Remove random/test-only package metadata changes. | Package manifest contains only intentional fields. |
| T-1602 | library | Remove dead imports and obsolete dependencies. | Typecheck and dependency search pass. |
| T-1603 | interface | Regenerate SDK after final API changes. | SDK typecheck passes. |
| T-1604 | interface | Add migration guide from upstream opencode to fork behavior. | Docs cover agents, skills, plugins, permissions, sessions. |
| T-1605 | library | Run full package test suite from `packages/opencode`. | Full package tests pass or failures are documented with owners. |
| T-1606 | library | Run repo-level build checks required by this fork. | Build succeeds or known unrelated blockers are documented. |
| T-1607 | library | Perform code review against style guide and atomic task scope. | Review findings are fixed or tracked. |
| T-1608 | interface | Cut release candidate branch or tag when accepted. | Release artifact or branch points to verified commit. |

## Module MOD-17: Remove WorkspaceID Runtime

| Task | Delivery | Scope | Verification |
|---|---|---|---|
| T-1701 | architecture | Define directory-as-workspace contract and deprecate user-facing `workspaceID`. | Spec states that resolved `directory` is the only workspace boundary. |
| T-1702 | library | Remove `workspaceID` from core session create/fork/get/list guards. | Session tests prove directory mismatch is forbidden and same-directory access works without workspace. |
| T-1703 | interface | Remove or deprecate `workspace` query/header from public routes and SDK shapes. | OpenAPI marks workspace fields removed or deprecated; SDK compiles. |
| T-1704 | library | Replace workspace-scoped permission pending keys with directory/session scoped keys. | Permission approval tests pass without workspace context and still isolate sessions. |
| T-1705 | library | Update timeline, checkpoint, workflow, memory, and audit isolation to use directory only. | Cross-directory tests cover restore, workflow status/resume, memory search, and audit query. |
| T-1706 | presentation | Remove TUI workspace picker/state where it only selects `workspaceID`; keep directory/project switching UX if present. | TUI tests and manual smoke no longer require workspace selection. |
| T-1707 | compatibility | Add migration compatibility for stored sessions containing old `workspaceID`. | Legacy session fixtures load and are isolated by directory. |
| T-1708 | configuration | Change default agent permission mode to explicit per-agent `custom` permissions. | Agent schema/loader tests show default tools are applied from agent config. |
| T-1709 | documentation | Update migration guide, RC checklist, and project/workspace docs. | Docs explain directory-as-workspace and removal of user-facing workspaceID. |
| T-1710 | verification | Regenerate SDK and run targeted plus full package checks. | SDK typecheck, opencode typecheck, workspace-removal regression tests, and full tests pass or blockers are documented. |

## Recommended Execution Order

1. B0: T-0001 to T-0006.
2. B1: MOD-01, MOD-02, MOD-03, then MOD-03A.
3. B2: MOD-04, MOD-05.
4. B3: MOD-06, MOD-07.
5. B4: MOD-08, MOD-09, MOD-10.
6. B5: MOD-11, then regenerate SDK.
7. B6: MOD-12.
8. B7: MOD-13.
9. B8: MOD-14.
10. B9: MOD-15.
11. B10: MOD-16.
12. B11: MOD-17.

## Phase Gates

### Gate 1: Coherent Phase-1 Baseline

Must pass after B4:

- `bun typecheck` from `packages/opencode`.
- Agent schema/loader/registry/prompt tests.
- Permission v2/unit/binding tests.
- Session status/timeline/workspace tests.
- No production dependency on deleted skill/plugin modules.

### Gate 2: Protocol Baseline

Must pass after B5:

- OpenAPI route tests.
- Event replay and filtering tests.
- SDK regeneration and SDK typecheck.
- TUI/Web clients use canonical route/event shapes.

### Gate 3: Workflow Baseline

Must pass after B7:

- workflow DSL schema/parser/executor tests.
- Resume from `waiting_permission` and checkpoint restore tests.
- At least one workflow visible in TUI or CLI.

### Gate 4: Memory Baseline

Must pass after B8:

- Memory extraction tests.
- Adapter contract tests.
- Retrieval tests with project/session/topic filters.
- Isolation tests for subagent memories.

### Gate 5: Release Candidate

Must pass after B11:

- Full package test suite.
- Full typecheck.
- Release docs and migration guide.
- Manual smoke test covering start, prompt, permission, switch agent, checkpoint restore.
- No user-facing runtime path requires `workspaceID`; directory is the workspace boundary.
