# Upstream Migration Spike

Date: 2026-05-22

## Scope

This is a research-only spike for deciding whether to keep building Agent Protocol DSL on the current `jin-opencode` fork or restart the local agent/workflow changes on top of latest upstream `sst/opencode` `dev`.

No business code was changed for this spike. Upstream was fetched directly into `refs/remotes/upstream/dev` with:

```sh
git fetch https://github.com/sst/opencode.git dev:refs/remotes/upstream/dev
```

The local worktree already had uncommitted changes before the spike:

- `packages/opencode/config/agents/workflow-runner/rules.md`
- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/test/agent/prompt-integration.test.ts`
- `packages/opencode/test/session/message-v2.test.ts`
- `script/dev-web.ts`
- untracked Agent Protocol DSL docs under `docs/agent-rewrite/09-*`, `10-*`, `11-*`, and `references/`

## Executive Conclusion

Recommendation: use a dual-track strategy.

Do not immediately rebase or port the fork. Continue the Agent Protocol DSL v1 experiment in the current fork because it already has the local agent registry, workflow runner, workflow state, session log, and UI projection hooks needed for a small proof of concept.

In parallel, do a narrower upstream migration spike in an isolated worktree focused only on the future protocol substrate, not on porting the old workflow implementation wholesale. Latest upstream is far enough ahead that a direct migration is high risk, but it also contains newer abstractions that may be a better long-term target for Agent Protocol DSL.

Important framing: Agent Protocol DSL is intended to replace or abstract the `toolCall` control surface, not merely replace the old workflow feature. The current workflow runtime is itself triggered through tool calls, so it should be treated as evidence and a harness for protocol design rather than the only thing being superseded.

## Upstream Status

Fetched upstream:

- upstream URL: `https://github.com/sst/opencode.git`
- upstream branch: `dev`
- fetched ref: `upstream/dev`
- upstream commit: `3e931152d tweak(tui): remove italics from thinking labels (#28737)`
- local HEAD: `4113661c9 fix(ui): allow copying toast text`
- merge base: `e14e874e5131`
- ahead/behind: local is `74` ahead and `2959` behind `upstream/dev`

This means local custom work is not a small patch queue over current upstream. It is a fork line from around upstream `1.2.27`, while upstream is now `1.15.7`.

## Version And Package Differences

Key package versions:

| Package | Current fork | Upstream/dev |
| --- | ---: | ---: |
| `packages/opencode` | `jin-opencode@1.2.27` | `opencode@1.15.7` |
| `packages/app` | `@opencode-ai/app@1.2.27` | `@opencode-ai/app@1.15.7` |
| `packages/web` | `@opencode-ai/web@1.2.27` | `@opencode-ai/web@1.15.7` |
| `packages/sdk/js` | `@opencode-ai/sdk@1.2.27` | `@opencode-ai/sdk@1.15.7` |

Root scripts differ:

- current fork adds `dev:web:full: bun script/dev-web.ts` and has `dev:desktop: bun --cwd packages/desktop tauri dev`
- upstream has `dev:desktop: bun --cwd packages/desktop dev` and `dev:console`, but no `dev:web:full`

Monorepo package structure differences:

- current-only package dirs: `desktop-electron`, `util`
- upstream-only package dirs: `core`, `effect-drizzle-sqlite`, `http-recorder`, `llm`
- both still have `app`, `console`, `desktop`, `enterprise`, `function`, `opencode`, `plugin`, `script`, `slack`, `storybook`, `ui`, `web`

Dependency changes that matter:

- `packages/opencode` changes `@agentclientprotocol/sdk` from `0.14.1` to `0.21.0`
- `ai` provider stack moved from mostly AI SDK v2 packages to v3/v4 package lines
- upstream introduces workspace packages `@opencode-ai/core`, `@opencode-ai/llm`, `@opencode-ai/plugin`, `@opencode-ai/ui`
- upstream removes current fork dependency on `@opencode-ai/util` and old Hono validator packages
- upstream adds OpenTelemetry-related dependencies and several repo tools (`repo_clone`, `repo_overview`, `task_status`, shell tool split)

## Changed Surface Area

Local changes relative to the fork point:

- `packages/opencode/src/agent`, `session`, `tool`, `workflow`, relevant app UI, and `script/dev-web.ts`: `46 files changed, 7051 insertions, 832 deletions`
- key local-only files include `packages/opencode/src/workflow/*`, `packages/opencode/src/session/runner.ts`, `packages/opencode/src/session/log.ts`, `packages/opencode/src/session/timeline.ts`, `packages/opencode/src/tool/workflow.ts`, `packages/opencode/src/tool/agent.ts`, and app settings/workflow UI files

Upstream changes from the same fork point:

- `packages/opencode/src/agent`, `session`, `tool`, and relevant app UI: `108 files changed, 17028 insertions, 10839 deletions`
- upstream deletes local-era `packages/opencode/src/session/index.ts` and replaces it with `packages/opencode/src/session/session.ts`
- upstream adds `packages/opencode/src/session/llm/*`, `projectors.ts`, `projectors-next.ts`, `tools.ts`, `run-state.ts`, `overflow.ts`, `reminders.ts`
- upstream keeps and updates `packages/opencode/src/tool/skill.ts`, while current fork deleted it
- upstream replaces old `bash`/`ls`/`batch` style tool files with `shell.ts`, `shell/*`, repo tools, `task_status`, and new truncation files

## Upstream Architecture Findings

Upstream has substantially refactored the session/runtime/tool stack.

Evidence:

- `upstream/dev:packages/opencode/src/session/session.ts` contains the main session model, row projection, Effect schema, and session persistence. It maps `SessionTable` rows through `fromRow()` and `toRow()`, and has no local fork `dsl_context` field in the shown row mapping.
- `upstream/dev:packages/opencode/src/session/llm/request.ts` extracts LLM request preparation into `LLMRequestPrep.prepare()`. It accepts `agent`, `permission`, `system`, `messages`, resolved `tools`, provider/auth/plugin/runtime flags, and an explicit `isWorkflow` boolean.
- `upstream/dev:packages/opencode/src/session/tools.ts` extracts tool resolution/execution bridging into `SessionTools.resolve()`. It wraps local registry tools and MCP tools, attaches metadata, triggers plugin hooks, handles permission asks, and calls processor update/complete hooks.
- `upstream/dev:packages/opencode/src/session/projectors.ts` introduces event projection for session/message/part persistence and usage accounting. It imports `projectors-next`, which suggests upstream is moving toward event/projector layering.
- `upstream/dev:packages/opencode/src/session/llm/native-runtime.ts` and related files indicate a split native LLM runtime path, not present in the current fork baseline.
- `upstream/dev:packages/opencode/src/tool/skill.ts` still exists; current fork deletes `packages/opencode/src/tool/skill.ts` and skill tests as part of the “agents replace skills” direction.

Interpretation:

Upstream may reduce long-term protocol implementation cost because LLM preparation, tool execution, and event projection are cleaner separable surfaces. But this same refactor makes direct porting of current workflow/session code high risk: local changes are built around `session/index.ts`, `SessionProcessor`, `SessionRunner`, `dsl_context`, and local message metadata conventions that upstream has rearranged.

## Local Customization Inventory

### Agent config and loading

Files:

- `packages/opencode/config/agents/*/{meta.json,identity.md,rules.md}`
- `packages/opencode/src/agent/schema.ts`
- `packages/opencode/src/agent/loader.ts`
- `packages/opencode/src/agent/registry.ts`
- `packages/opencode/src/agent/entry.ts`
- `packages/opencode/src/agent/identity.ts`
- `packages/opencode/src/agent/rules.ts`
- `packages/opencode/src/agent/manage.ts`
- `packages/opencode/src/server/routes/agent.ts`
- `packages/app/src/components/settings-agents.tsx`
- `packages/app/src/components/settings-agents-helpers.ts`

Evidence:

- `c98023792 feat: add AgentTemplateLoader for config/agents/ directory scanning`
- `3946478ad feat(agent): implement AgentRegistry with list(), get(), and runtime switching`
- `59905f2fd feat: rewrite opencode agent runtime`
- `9e45e3d92 Add agent creation command`
- `packages/opencode/src/agent/loader.ts` scans `*/meta.json` and reads `identity.md` / `rules.md`
- `packages/opencode/src/agent/registry.ts` describes itself as managing templates loaded from `config/agents/` and providing `list()`, `get()`, and runtime switching
- `packages/app/src/components/settings-agents-helpers.ts` exposes local UI concepts including `runners: ["chat", "workflow"]`

Migration assessment:

- Portability: medium.
- Conflict: medium-high. Upstream has continued to change `Agent.Info`, subagent permissions, scout, prompt files, and session runtime flags.
- Keep: yes. Custom agent config/list/editing is a product experience feature.

### Skills removed or replaced

Files:

- deleted locally: `packages/opencode/src/skill/*`
- deleted locally: `packages/opencode/src/tool/skill.ts`
- deleted locally: `packages/opencode/test/skill/*`
- local docs: `docs/agent-rewrite/03-plugin-removal.md`, `docs/agent-rewrite/01-baseline-stabilization.md`

Evidence:

- `4f5d6bf7b cleanup: remove skill/ and plugin/ directories`
- local diff has `D packages/opencode/src/tool/skill.ts`
- upstream `dev` still has `packages/opencode/src/tool/skill.ts` and `packages/opencode/src/tool/skill.txt`
- `docs/agent-rewrite/01-baseline-stabilization.md` records deleted skill source/tests and replacement coverage.

Migration assessment:

- Portability: low as a patch, medium as product policy.
- Conflict: high. Upstream still supports skills and may have evolved them.
- Keep: likely yes for the fork’s “all agent” direction, but this should be a deliberate product divergence, not mechanically ported.

### Workflow-runner agent

Files:

- `packages/opencode/config/agents/workflow-runner/meta.json`
- `packages/opencode/config/agents/workflow-runner/identity.md`
- `packages/opencode/config/agents/workflow-runner/rules.md`
- `packages/opencode/src/session/runner.ts`

Evidence:

- `65b993163 feat: add workflow runner dispatch`
- `67d31db78 feat: connect workflow runner execution`
- uncommitted edits in `workflow-runner/rules.md` now require a final summary report after completed workflows
- `packages/opencode/src/session/runner.ts` selects `chat` or `workflow` runner from `agent.runner`

Migration assessment:

- Portability: medium for prompt/config, low for runtime dispatch.
- Conflict: high with upstream session runner changes, because upstream now has extracted `SessionTools`, `LLMRequestPrep`, native runtime, and run state concepts.
- Keep: only for current fork v1 experiments. Long term Agent Protocol DSL should probably move orchestration control out of ad hoc workflow tool calls and into a first-class protocol layer.

### Workflow tool, runtime, DAG, loop, persistence

Files:

- `packages/opencode/src/tool/workflow.ts`
- `packages/opencode/src/workflow/schema.ts`
- `packages/opencode/src/workflow/parser.ts`
- `packages/opencode/src/workflow/loader.ts`
- `packages/opencode/src/workflow/state.ts`
- `packages/opencode/src/workflow/executor.ts`
- `packages/opencode/config/workflows/two-step.json`
- `packages/opencode/migration/20260514184707_add_session_dsl_context/*`
- `packages/opencode/migration/20260518090000_session_log/migration.sql`
- tests under `packages/opencode/test/workflow/*`, `test/tool/workflow.test.ts`, `test/server/workflow-routes.test.ts`

Evidence:

- `ee05bef0a feat: add workflow tool protocol`
- `783d395c5 feat: dispatch workflow nodes through runtime`
- `e2678a32f feat: support workflow DAG execution`
- `d8d5216f4 Add workflow loop nodes`
- `c605e47fa feat: route workflow nodes by agent capabilities`
- `fc433ad4e feat: run workflows in background`
- `packages/opencode/src/workflow/parser.ts` validates nodes, dependencies, verification references, and cycles
- `packages/opencode/src/workflow/executor.ts` stores active state in `session.dsl_context`, handles pause/resume/abort, recovers running child sessions, and routes nodes to agents
- `packages/opencode/src/tool/workflow.ts` exposes create/start behavior and returns structured status and node data

Migration assessment:

- Portability: low for implementation, medium for lessons learned.
- Conflict: high. It is tightly coupled to local `dsl_context`, local `SessionRunner`, local status model, child session recovery, and local message metadata.
- Keep: not as long-term architecture. It can be partially discarded if Agent Protocol DSL replaces the current tool-call-mediated orchestration path.

### Workflow UI panel and session logs

Files:

- `packages/app/src/pages/session/session-side-panel.tsx`
- `packages/app/src/pages/session/session-log-timeline.tsx`
- `packages/app/src/pages/session/session-log-timeline.test.ts`
- `packages/app/src/pages/session/helpers.ts`
- `packages/app/src/pages/session/helpers.test.ts`
- `packages/opencode/src/session/log.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/server/routes/session.ts`

Evidence:

- `38a77a7d5 feat(app): show session log stats`
- `485ae3a92 feat: show workflow run history in side panel`
- `1a011c5b6 feat: sync workflow panel node status`
- `a283c01d2 feat: enhance session timeline display`
- `packages/app/src/pages/session/session-side-panel.tsx` reads `info()?.dsl_context`, derives workflow runs, and adds a `workflow` tab when runs exist
- `packages/app/src/pages/session/session-log-timeline.tsx` formats `workflow.started`, `workflow.paused`, `workflow.completed`, `workflow.failed`, and LLM/tool stream log records
- `packages/opencode/src/session/processor.ts` emits debug records such as `reasoning.start`, `tool.input.start`, `tool.result`, `step.start`, and text events through `SessionLog`

Migration assessment:

- Portability: low-medium. UI ideas can port, but upstream app has changed heavily and now includes `message-timeline.data.ts`, large rewrites of `message-timeline.tsx`, `session-side-panel.tsx`, app sync, layout, titlebar, and E2E structure.
- Conflict: high for direct patch application.
- Keep: yes as product experience, but redesign against upstream’s newer projection/data model.

### Dev scripts and startup logic

Files:

- `package.json`
- `script/dev-web.ts`

Evidence:

- `59905f2fd feat: rewrite opencode agent runtime` and `d6d159629 feat: adapt webui agent runtime` touch package/app scripts
- current root `package.json` adds `dev:web:full: bun script/dev-web.ts`
- uncommitted `script/dev-web.ts` change restarts the server child if it exits while keeping the app process alive
- upstream root scripts do not include `dev:web:full`

Migration assessment:

- Portability: high.
- Conflict: low.
- Keep: yes if local web development still depends on paired app/server startup.

### Session runner, message-v2, and tool result return path

Files:

- `packages/opencode/src/session/runner.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/tool/registry.ts`
- `packages/opencode/src/tool/workflow.ts`

Evidence:

- `ac9cc2743 feat(session): persist runtime logs`
- `cd92bff49 fix(session): include detailed runtime logs`
- `af041f516 add structured workflow status messages`
- `58661166e Surface backend execution failures`
- uncommitted `message-v2.ts` filters provider metadata through a `meta()` guard before passing `providerMetadata` / `callProviderMetadata` back to AI SDK model messages
- upstream has since extracted tool resolution into `session/tools.ts` and LLM request preparation into `session/llm/request.ts`

Migration assessment:

- Portability: low.
- Conflict: high. These are exactly the files upstream has refactored most aggressively.
- Keep: conceptually yes. Implementation should be rewritten on top of upstream primitives if migrating.

## Migration Cost And Risk

Overall migration risk: high.

Reasons:

- The fork is `2959` commits behind upstream `dev`.
- Upstream moved package boundaries by adding `packages/core`, `packages/llm`, `packages/effect-drizzle-sqlite`, and `packages/http-recorder`.
- Upstream has major session architecture changes: `session/index.ts` deleted, `session/session.ts` introduced, LLM request prep split, tool resolution split, projectors introduced, native runtime added.
- Current workflow code stores state in local `dsl_context`, but upstream session row mapping currently does not show that field.
- Current fork deletes skills; upstream still has `skill.ts` and `skill.txt`.
- App UI changed substantially; direct port of the right-side workflow panel is unlikely to apply cleanly.

Risk by area:

| Area | Risk | Why |
| --- | --- | --- |
| dev script | Low | Mostly standalone root/script change |
| agent config files | Medium | Config shape can port, but upstream agent semantics changed |
| agent registry/runtime switch | Medium-high | Upstream agent and subagent permission behavior changed |
| skill removal | High | Product-level divergence from upstream current behavior |
| workflow runner dispatch | High | Coupled to local session runner that upstream replaced/refactored |
| workflow executor/state | High | Coupled to `dsl_context`, local child session/status semantics |
| workflow UI panel | High | Upstream app session UI and sync architecture changed substantially |
| session log/timeline | Medium-high | Concept portable, storage/projection path conflicts |
| message/tool result metadata handling | High | Upstream moved model message prep and tool execution boundaries |

## Agent Protocol DSL Baseline Assessment

Current fork is easier for a v1 proof of concept because:

- It already has file-based custom agents and capability metadata.
- It already has `workflow-runner` as an orchestration entry point.
- It already has a workflow tool/runtime pattern to learn from or selectively reuse.
- It already has `dsl_context` and UI projection through the side panel.
- It already has session logs and debug events useful for protocol projection.

Upstream/dev may be better for a durable v2 baseline because:

- `LLMRequestPrep.prepare()` gives a cleaner place to inject protocol-specific system/message/tool preparation.
- `SessionTools.resolve()` gives a cleaner tool execution boundary for protocol actions and tool-result metadata.
- `projectors.ts` / `projectors-next.ts` suggest a better path for protocol state projection than ad hoc `dsl_context` mutation.
- `packages/llm` and the native runtime split may reduce future coupling to the AI SDK message format.
- App UI has newer session timeline data structures that may be better for protocol projection once understood.

Upstream does not make v1 automatically cheaper because:

- It does not contain the local custom agent template registry.
- It still has skills, which conflicts with the fork’s “all agent” policy.
- It does not have current local workflow/DAG/loop/runtime state.
- It would require rebuilding the UI integration against a heavily changed app.

## What To Keep, Port, Or Drop

Easy or likely worth porting:

- `dev:web:full` style script, if still needed.
- Agent config directory concept and authoring files.
- Agent management UX concept, but not the exact implementation.
- Session log / protocol event timeline concept.

High-conflict, rewrite rather than port:

- `SessionRunner` workflow dispatch.
- `WorkflowExecutor` coupling to `session.dsl_context`.
- Workflow UI panel implementation.
- Tool-result/message metadata patches.
- Skill removal patches.

Likely discard or demote because Agent Protocol DSL supersedes the current tool-call-mediated control path:

- Old workflow DSL schema as final public protocol.
- `workflow-runner` prompt as the primary long-term control surface.
- DAG/loop executor details that are specific to the old workflow representation.

Must preserve as current product experience until replaced:

- Agent list/config loading and agent selection.
- Ability to run multi-agent orchestrated work.
- Visible workflow/progress/status feedback in the app.
- Local dev startup flow.

## Recommended Phases

### Phase 1: Current fork minimal Agent Protocol DSL experiment

Goal: prove the protocol shape without fighting upstream migration.

Suggested limits:

- Implement only a minimal protocol projection over existing local surfaces.
- Do not deepen dependency on old workflow DSL unless needed for the experiment.
- Treat existing workflow runtime as a test harness, not a permanent architecture.
- Keep UI projection small: protocol state visible enough to validate user experience.

Decision criteria:

- Can Agent Protocol DSL express current workflow-runner/tool-call use cases more cleanly?
- Can it replace `dsl_context` shape rather than extend it indefinitely?
- Can model-visible protocol/tool results be made reliable without more AI SDK metadata hacks?

### Phase 2: Isolated upstream migration spike

Goal: build a throwaway branch/worktree from `upstream/dev` and answer implementation questions with tiny prototypes.

Suggested worktree:

```sh
git worktree add ../opencode-upstream-spike upstream/dev
```

Prototype only these seams:

- Where protocol state should live if not `dsl_context`.
- Whether `SessionTools.resolve()` can host protocol actions cleanly.
- Whether `LLMRequestPrep.prepare()` can inject protocol instructions and filter model messages.
- Whether upstream app timeline/session data can display protocol events without porting the old workflow panel.
- Whether agent config can be layered on upstream without deleting skills first.

Do not attempt to port the full workflow executor in this phase.

### Phase 3: Formal migration decision point

Migrate only if the upstream spike proves:

- Agent Protocol DSL v1 can be implemented with less or equal complexity than current fork.
- Protocol state has a clear upstream-native persistence/projection path.
- Agent config can coexist with or intentionally replace upstream skills.
- Minimal UI projection is practical in upstream app.
- The required product features can be restored without porting all old workflow code.

If these are not true, continue current fork through Agent Protocol DSL v1 and revisit upstream after the protocol stabilizes.

## Open Questions

- What is the intended long-term upstream replacement, if any, for skills and custom agents?
- Does upstream have an accepted session extension field or event store suitable for protocol state, or would a migration require schema changes?
- Is upstream’s `isWorkflow` flag in `LLMRequestPrep.prepare()` a stable concept or an internal transition point?
- How should protocol events be projected in upstream: message parts, session projectors, session logs, or a new table?
- Can the current agent `meta.json` fields (`entry`, `capability`, `runner`) be preserved without conflicting with upstream `Agent.Info`?
- Which workflow UI behaviors are truly product-critical versus temporary debugging aids?
- Can the Agent Protocol DSL replace the current workflow DAG/loop state and tool-call trigger path before a migration, reducing the porting surface?

## Evidence Commands

Representative commands used:

```sh
git status --short --branch
git rev-list --left-right --count HEAD...upstream/dev
git merge-base HEAD upstream/dev
git diff --stat --find-renames upstream/dev...HEAD -- packages/opencode/src/session packages/opencode/src/tool packages/opencode/src/agent packages/app packages/web
git diff --stat --find-renames HEAD...upstream/dev -- packages/opencode/src/session packages/opencode/src/tool packages/opencode/src/agent packages/app packages/web
git diff --name-status --find-renames HEAD...upstream/dev -- packages/opencode/src/session packages/opencode/src/tool packages/opencode/src/agent
git log --oneline -- packages/opencode/src/workflow packages/opencode/src/session/runner.ts packages/opencode/src/tool/workflow.ts
git show upstream/dev:packages/opencode/src/session/session.ts
git show upstream/dev:packages/opencode/src/session/llm/request.ts
git show upstream/dev:packages/opencode/src/session/tools.ts
git show upstream/dev:packages/opencode/src/session/projectors.ts
```
