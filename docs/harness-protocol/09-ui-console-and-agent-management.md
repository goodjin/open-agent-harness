# UI Console And Agent Management

## Purpose

Harness UI 的目标是让用户管理、观察和使用 Harness 系统。UI 不从自然语言 transcript 推断状态，而是读取 Runtime Projection，并把用户操作提交为 Command 或受控 Action。

UI 由三个主要 surface 组成：

- **Harness Console**：管理 Run、Task、Assignment、Artifact、Gate、Decision、Event、Memory、Concept。
- **Session Tree Workbench**：把 root session、child session、descendant session 展示成可导航树。
- **Agent Manager**：管理 agent 模板、entry、capability、permission、启用状态和 authoring 内容。

## Design Boundaries

- 主聊天界面和 Harness Console 是两个独立 surface。
- 前端不直接修改状态文件、数据库或 projection。
- 所有状态变化都通过 Runtime Command、受控 Action 或 adapter API。
- UI 以 Projection 为主要数据源，Event Log 和 raw trace 作为审计入口。
- Project Memory 位于 project-local Harness store；Team/Global Memory 通过 Memory Service 引用。
- Provider/model settings、worktree/sandbox settings 是独立配置 surface。
- Working directory 是 runtime project boundary；UI 不引入 user-facing `workspaceID`。

## Core Objects

Harness Console 必须能展示这些对象：

- `Run`
- `Task`
- `Assignment`
- `Agent Session`
- `Artifact`
- `Gate`
- `Decision`
- `Event`
- `Memory`
- `Concept`

## Architecture

```txt
主聊天界面
  -> session/message/tool API

Harness Console
  -> Harness API
  -> Harness Runtime
  -> Command/Event/Projection/Gate
  -> run-scoped store + governance store

Session Tree Workbench
  -> session tree API
  -> root/child/descendant session projection

Agent Manager
  -> agent management API
  -> package/user/project agent templates

共享底层
  -> provider / tool / workspace / storage / permission
```

## Harness Console

### Read-Only Console

Goal: users can inspect structured Harness state without executing operations.

Backend:

- define read schema for Run, Task, Assignment, Artifact, Decision, Event, and Projection envelope
- read `.opencode/harness/runs/<run>/...`
- return empty lists when Harness data is absent
- expose read routes:
  - `GET /harness/runs`
  - `GET /harness/runs/:id`
  - `GET /harness/runs/:id/tasks`
  - `GET /harness/runs/:id/assignments`
  - `GET /harness/runs/:id/artifacts`
  - `GET /harness/runs/:id/decisions`
  - `GET /harness/runs/:id/events`

Frontend:

- add independent Harness Console route
- show Run list, Run detail, Task list, Artifact list, Decision list, Event list
- display loading, empty, and error states clearly
- display Projection source and update time

Acceptance:

- users can see run status, blockers, evidence, and pending decisions
- UI does not parse chat text to infer state
- missing Harness store renders a valid empty state

### Operable Console

Goal: users can advance a Run through controlled operations.

Command types:

- `run.create`
- `run.pause`
- `run.resume`
- `run.abort`
- `task.retry`
- `task.cancel`
- `decision.answer`
- `verify.rerun`

Backend:

- define Command schema and required authority
- validate schema, authority, gate conditions, and run mutability
- append Event before updating Projection
- return updated Projection summary
- expose command route such as `POST /harness/commands`

Frontend:

- provide create Run form
- provide pause/resume/abort controls
- provide task retry/cancel controls
- render Decision Request as human-readable options
- show Gate rejection reason without mutating client state optimistically beyond the accepted projection

Acceptance:

- all UI operations become Command or controlled Action
- completed runs cannot be resumed arbitrarily
- non-pending decisions cannot be answered
- failed commands do not create half state

### Governance Console

Goal: users can inspect governance state, authority, memory, and concept changes.

Capabilities:

- Memory Query across `run`, `project`, `team`, and `global`
- Project/Team/Global Memory scope display
- Concept Detail
- Concept Replacement Request
- Impact Scan
- Authority View
- Gate Detail

Rules:

- current Projection overrides historical memory
- Concept replacement requires `new_information`
- replacement requests must show impacted refs, evidence, owner, and gate result
- Authority View must distinguish capability from granted authority

Acceptance:

- users can see why a concept is active, superseded, or historical
- users can see which tasks or files are affected by a concept replacement
- UI blocks concept replacement when required evidence is missing

### Visualization And Audit

Goal: users can inspect complex runs and export audit evidence.

Views:

- Task Graph
- Concept Graph
- Event Explorer
- Projection Rebuild debug entry
- Run Comparison
- Audit Export

Rules:

- graph views are projections, not state sources
- raw JSON is available for inspection but not the primary experience
- audit export respects redaction policy
- projection rebuild is a debug action and requires appropriate authority

Acceptance:

- users can trace Command -> Event -> Projection
- users can compare runs by duration, status, action count, tool calls, and failure reasons
- users can export audit material with redaction applied

## Session Tree Workbench

Goal: nested sessions are first-class interactive objects.

Expected behavior:

- sidebar/session navigation renders root sessions, child sessions, and deeper descendants
- child sessions show status, pending permission/question indicators, unread/error state, and agent tint consistently
- parent session view exposes child sessions clearly
- opening any child session routes to `/:dir/session/:id`
- child and descendant sessions remain interactive unless runtime reports a blocking state
- deleting or archiving a parent handles descendants predictably

Implementation tasks:

- add recursive session descendants/tree query under directory guard
- regenerate SDK after route shape changes
- load descendant sessions after root session list and merge them into directory store
- preserve full descendant closure for retained roots
- build recursive session tree renderer with active-lineage expansion
- adapt sidebar prefetch/nav order to flattened visible tree
- test child/grandchild rendering, navigation, and prompt submission isolation

## Agent Manager

Goal: users can manage agents as governed runtime objects.

Expected behavior:

- Settings includes an Agents tab
- list agents with source, persona, entry flags, capability, permission mode, enabled state, diagnostics
- create user/project agent templates
- edit metadata, identity/rules content, model defaults, entry flags, and custom permissions
- disable or re-enable an agent without deleting its config
- package/builtin templates are visible but not modified in place
- disabled agents remain visible in Agent Manager and disappear from normal pickers and `@agent` suggestions

Implementation tasks:

- define management schema for package/user/project sources, disabled state, diagnostics, identity, and rules
- add list/get endpoints that include disabled agents
- add validate/create/update endpoints for user/project templates
- add enable/disable endpoint using config overlay semantics
- regenerate SDK after route shape changes
- add WebUI API helpers/context for agent management
- add create/edit form for `meta.json`, `identity.md`, `rules.md`, entry flags, model defaults, and permissions
- switch primary picker to `entry.primary`
- switch `@agent` suggestions to `entry.mentionable`
- handle disabling selected agent with deterministic replacement

Acceptance:

- `/agent` style runtime selection hides disabled agents
- management list includes disabled agents with source and diagnostics
- form validation catches invalid template metadata before write
- picker and mention tests cover primary, mentionable, hidden, and disabled combinations

## UI Protocol Run Panel

Protocol runs should be visible without exposing raw logs by default.

Requirements:

- show a Protocol tab only when protocol run metadata or protocol logs exist
- show run title, status, action graph list, selected action detail, executor, summary, artifacts, and block/failure reason
- expose view/copy/export for full protocol trace JSON
- show comparison metrics when available: direct toolCall count, protocol action count, internal tool calls, model-visible bytes, raw output bytes, duration
- keep Protocol distinct from Workflow, Logs, Review, file, and context tabs

## Testing Strategy

- API contract tests for Harness read/command routes
- Command -> Event -> Projection chain tests
- Decision Answer, Task Retry, pause/resume/abort tests
- component tests for Harness Console loading, empty, error, list, and detail states
- session tree tests for recursive rendering and child interaction
- agent manager tests for list/get/create/update/disable/enable
- protocol panel/log tests for action detail and export controls
- package-level typechecks from affected package directories

## Acceptance Summary

UI is accepted when:

- users can independently enter Harness Console
- all visible state comes from Projection, Event, or runtime trace APIs
- all state-changing actions go through Runtime
- users can inspect run status, blockers, evidence, decisions, memory, concepts, and authority
- users can navigate nested sessions and continue work in child sessions
- users can manage agents without editing files manually
- audit/export flows respect visibility and redaction policy
