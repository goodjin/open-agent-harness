# Upstream Migration Guide

This guide describes the behavioral differences between upstream opencode and this fork for users moving an existing configuration or workspace.

## Package and CLI

The fork package is named `jin-opencode` and exposes the `jin` binary. Existing upstream installs can keep their data directories, but scripts that call `opencode` should be updated to call `jin` when they depend on fork behavior.

## Agents

Agents are first-class configuration units. Move reusable role prompts and model defaults into `config/agents/<id>/` for packaged defaults, or `.opencode/agents` for user and project overrides.

Agent authorship is explicit:

- core agents come from packaged config
- user agents come from the user config directory
- project agents come from the workspace
- session agent switches are stored on the session and do not mutate the agent definition

When an upstream setup relied on plugin or skill hooks to alter prompts, migrate that behavior into agent prompt templates, command prompts, custom tools, or MCP servers.

## Skills

The fork removes the upstream skill runtime. `.opencode/skill`, `.opencode/skills`, and top-level `skills` config are unsupported.

Migration paths:

- prompts and procedures: move to `.opencode/command` or `.opencode/commands`
- reusable agent behavior: move to `.opencode/agents` or packaged `config/agents/<id>/`
- executable behavior: move to `.opencode/tool` or `.opencode/tools`
- external integrations: use MCP servers or dedicated fork features

Legacy `permission.skill` entries should be removed because the skill tool is no longer registered.

## Plugins

The fork removes the upstream plugin runtime. JavaScript and TypeScript files in `.opencode/plugin` or `.opencode/plugins` are not loaded, and top-level `plugin` config is rejected so stale configuration fails visibly.

Migration paths:

- custom tools: move plugin tool hooks to `.opencode/tools/*.ts`
- provider auth: use `jin auth login`, environment variables, or the `provider` config block
- shell environment hooks: set environment variables before launching `jin`, or pass explicit env through API calls
- automation hooks: use commands, workflows, MCP servers, or first-class fork APIs

## Permissions

Permissions are evaluated through the fork policy model instead of plugin or skill hook overrides. Configure permissions through agent policy, inherited policy, and six-dimension capability checks.

When migrating, review any upstream allow/deny assumptions around:

- shell commands
- file edits
- network access
- provider or credential use
- session and project scope

The fork records permission decisions in audit events and exposes permission inspection routes for server clients.

## Sessions

Sessions carry more state than upstream opencode. The fork tracks agent selection, directory binding, status, timeline metadata, checkpoints, and restore state.

Migration notes:

- the resolved `directory` is the workspace boundary for session list, get, fork, restore, workflow, memory, audit, and permission approval
- user-facing `workspaceID`, `?workspace=`, and `x-opencode-workspace` are deprecated for normal clients
- stored sessions with old `workspaceID` metadata still load, but access is decided by `session.directory`
- agent switches are preserved as session state
- checkpoint restore is explicit and audited
- prompt compaction uses fork agent configuration and memory context

Existing upstream sessions may not have all fork metadata. Treat missing fork fields as legacy data and let the application hydrate them on next use.

## Workflow

The fork adds workflow definitions and server routes for workflow execution. Use workflows for repeatable multi-step procedures that were previously handled by plugin event chains or external scripts.

Workflow definitions should live in the fork workflow config directories and be invoked through the workflow API or UI. Keep command prompts for single prompt actions; use workflows when state, progress, or multiple steps matter.

The workflow design is described in `docs/harness-protocol/08-workflow-durable-orchestration-adapter.md`. The target model treats workflow files as durable DAG run records: Planner / Orchestrator agents may generate them for complex tasks, static definitions may be authored by humans, Workers update only their assigned node state files, and actual concurrency is controlled by the runtime rather than the DSL.

## Memory

The fork adds a memory subsystem with extraction, storage, and prompt integration. Memory is separate from skills and plugins.

Migration notes:

- store durable user or project facts in the memory system
- avoid embedding long-lived facts in command prompts when they should be shared across sessions
- review memory adapter configuration before enabling shared or persistent storage
- audit memory capture behavior for sensitive projects

## Validation Checklist

- Run `bun typecheck` from `packages/opencode`.
- Run the package test suite from `packages/opencode`.
- Regenerate the SDK with `./packages/sdk/js/script/build.ts`.
- Run SDK typecheck from `packages/sdk/js`.
- Remove stale `skills` and `plugin` config before release.
