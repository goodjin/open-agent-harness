# WebUI Agent Runtime Adaptation Plan

Mission ID: `opencode-webui-agent-runtime-adaptation`

## Objective

Adapt `packages/app` Web/App UI to the rewritten opencode agent runtime:

- Treat nested sessions as first-class interactive objects.
- Add an Agent Manager UI for viewing, creating, editing, enabling, and disabling agents.
- Preserve the post MOD-17 contract: the working directory is the runtime project boundary; no user-facing `workspaceID` concept is reintroduced.

## Scope

### MOD-W01 Session Tree Workbench

The WebUI must display session parent-child relationships as a real tree, including multi-level nesting. Every child session should be navigable and should open the same interactive session composer as a root session.

Expected behavior:

- Sidebar/session navigation can render root sessions, child sessions, and deeper descendants.
- Child sessions show status, pending permission/question indicators, unread/error state, and agent tint consistently.
- Parent session view exposes its child sessions clearly.
- Opening any child session routes to `/:dir/session/:id` and allows normal follow-up interaction unless the server reports a blocking state.
- Deleting or archiving a parent handles descendants predictably.

### MOD-W02 Agent Manager

The WebUI must expose a first-class agent management surface in Settings.

Expected behavior:

- Settings includes an Agents tab.
- Users can list agents with source, role/entry flags, permission mode, and enabled/disabled state.
- Users can create a new project/user agent.
- Users can edit agent metadata, identity/rules content, model defaults, entry flags, and custom permissions.
- Users can disable or re-enable an agent without deleting its config.
- The UI uses directory-scoped project context and does not introduce `workspaceID`.

## Non-Goals

- Do not redesign the whole app shell.
- Do not replace the existing provider/model settings.
- Do not remove legacy worktree/sandbox UI in this mission unless it blocks the new directory-as-boundary contract.
- Do not add cloud synchronization for agent configs.

## Execution Order

1. Research current WebUI/session/agent API gaps.
2. Finalize feature queue and tests.
3. Implement Session Tree Workbench.
4. Review and fix Session Tree Workbench.
5. Implement Agent Manager backend API and SDK support if missing.
6. Implement Agent Manager WebUI.
7. Review and fix Agent Manager.
8. Run package-level typecheck/tests from package directories.
9. Final code review and mission closure.

## Product Decisions

- Session tree nodes come from explicit `parentID` child sessions produced by task/subagent execution.
- `fork` sessions remain independent root sessions in this mission.
- Every loaded child or descendant session is still a normal interactive session route: `/:dir/session/:id`.
- Agent editing writes user/project template overrides. Package/builtin templates are not modified in place.
- Disabled agents must remain visible in Agent Manager but disappear from normal pickers and `@agent` mention suggestions.

## MOD-W01 Atomic Tasks

| Task | Type | Description | Verification |
|------|------|-------------|--------------|
| T-W0101 | backend | Add recursive session descendants/tree query under directory guard. | Server route tests cover multi-level descendants and 403 directory isolation. |
| T-W0102 | sdk | Regenerate OpenAPI/JS SDK for descendants/tree route. | SDK build succeeds and generated client exposes the new operation. |
| T-W0103 | app-data | Load descendant sessions after root session list and merge them into directory store. | Global sync tests show roots + descendants are retained. |
| T-W0104 | app-data | Extend trim logic to preserve full descendant closure for kept roots. | `session-trim` tests cover grandchildren. |
| T-W0105 | app-ui | Build recursive session tree renderer with active-lineage auto expansion. | Component/unit tests cover multi-level rendering and collapse. |
| T-W0106 | app-ui | Adapt sidebar prefetch/nav order to flattened visible tree. | Navigation tests cover child/grandchild click routes. |
| T-W0107 | app-ui | Ensure child/grandchild session pages remain fully interactive. | Submit test or e2e confirms prompt sends to child session only. |
| T-W0108 | qa | Run focused backend/app tests and typechecks. | Package-level commands pass or blockers are documented. |

## MOD-W02 Atomic Tasks

| Task | Type | Description | Verification |
|------|------|-------------|--------------|
| T-W0201 | backend | Define management schema for agent templates, sources, disabled state, diagnostics, identity, and rules. | Agent schema tests cover package/user/project sources and invalid diagnostics. |
| T-W0202 | backend | Add agent management list/get endpoints that include disabled agents. | Route tests show `/agent` hides disabled while manage list includes them. |
| T-W0203 | backend | Add validate/create/update endpoints for user/project agent templates. | Tests verify `meta.json`, `identity.md`, and `rules.md` are written. |
| T-W0204 | backend | Add enable/disable endpoint using existing config overlay semantics. | Route tests verify disable/re-enable and default-agent fallback constraints. |
| T-W0205 | sdk | Regenerate OpenAPI/JS SDK for agent management routes. | SDK build and typecheck pass. |
| T-W0206 | app-data | Add WebUI API helpers/context for agent management list/detail/save/state. | Unit tests cover optimistic refresh/error handling. |
| T-W0207 | app-ui | Add Settings Agents tab and searchable list. | Component tests render source, badges, enabled state. |
| T-W0208 | app-ui | Add create/edit form for meta, identity, rules, entry flags, model defaults, and permissions. | Form tests save valid data and show validation errors. |
| T-W0209 | app-ui | Switch prompt primary picker to `entry.primary` semantics. | Tests cover hidden/non-primary exclusion. |
| T-W0210 | app-ui | Switch `@agent` suggestions to `entry.mentionable` semantics. | Prompt autocomplete tests cover mentionable-only agents. |
| T-W0211 | app-ui | Handle disabling the currently selected agent with fallback. | Local selection tests cover fallback behavior. |
| T-W0212 | qa | Run focused backend/app/sdk tests and typechecks. | Package-level commands pass or blockers are documented. |

## Testing Strategy

- Add unit tests for tree construction and recursive rendering helpers.
- Add WebUI component tests around nested session navigation.
- Add tests confirming child sessions remain interactive.
- Add backend route tests for agent list/write/disable if new routes are needed.
- Regenerate SDK after API changes.
- Run `bun typecheck` from affected package directories.
