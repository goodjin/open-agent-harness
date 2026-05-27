# Open Agent Harness Development Plan

Date: 2026-05-27

## Positioning

Open Agent Harness is a source-available fork of the opencode codebase. The project keeps the local coding environment, provider integrations, session storage, tool execution foundation, and UI surfaces that are still useful, while replacing the agent layer with a protocol-driven harness.

The main runtime still lives at `packages/opencode` during migration. That path is a compatibility detail, not the product identity.

## Core Decisions

| Area                 | Decision                                                                                             | Rationale                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Fork strategy        | Continue as a direct source fork                                                                     | Runtime, session, tool, and UI changes require control below plugin boundaries.                      |
| Product identity     | Use Open Agent Harness in public docs and package-facing text                                        | The fork is not affiliated with OpenCode, opencode.ai, or anomalyco.                                 |
| Runtime package path | Keep `packages/opencode` until migration risk is lower                                               | Renaming the path touches imports, generated SDKs, tests, scripts, and docs.                         |
| Agent model          | Treat agents as first-class protocol entities                                                        | Agents need explicit identity, input shape, tool scope, permissions, and handoff rules.              |
| Tool calls           | Route tool execution through the harness                                                             | Tool calls need authority, scope, audit history, and policy evaluation.                              |
| Multi-agent protocol | Define routing, delegation, review, state sharing, and handoff explicitly                            | Multi-agent work must be observable and controllable by the runtime.                                 |
| Package namespace    | Use `@open-agent-harness/*` for workspace packages                                                   | Public package identity should match Open Agent Harness even while directory paths remain unchanged. |
| Compatibility names  | Keep `OPENCODE_*`, `.opencode`, `/opencode`, and `opencode://` only where code still depends on them | Rename these in deliberate migrations, not incidental cleanups.                                      |

## Target Architecture

```text
Open Agent Harness
├── Runtime
│   ├── session lifecycle
│   ├── LLM request protocol
│   ├── structured tool-call execution
│   ├── permission and policy evaluation
│   └── audit and observability
├── Agent Layer
│   ├── agent definitions
│   ├── agent registry and loader
│   ├── routing and delegation
│   ├── handoff and review
│   └── runtime state boundaries
├── Protocol Surfaces
│   ├── HTTP API
│   ├── WebSocket events
│   ├── ACP server
│   ├── SDK generation
│   └── GitHub, Slack, and editor integrations
└── Clients
    ├── TUI
    ├── shared web app
    ├── Tauri desktop
    ├── Electron desktop
    └── VS Code extension
```

## Workstreams

### 1. Identity And Documentation

Goal: remove misleading upstream instructions and make remaining compatibility references explicit.

Status:

- Top-level `README.md` is Open Agent Harness content.
- `README.zh.md` is aligned with `README.md`.
- Obsolete translated README files were removed.
- Dot-directory cleanup removed local/editor/orchestration state from the working tree.
- Package README files have been rewritten for Open Agent Harness where feasible.

Remaining:

- Decide whether to migrate or remove `packages/web/src/content/docs`.
- Decide whether `packages/docs` remains a Mintlify docs surface.
- Keep protocol-facing docs under `docs/harness-protocol`, and keep historical migration plans under `docs/archive/agent-rewrite`.
- Review `.github` workflows for release targets, package namespaces, secrets, and upstream URLs.

### 2. Runtime And LLM Protocol

Goal: make the request and response flow explicit enough for the harness to supervise.

Scope:

- Request envelope for user input, agent identity, tool intent, runtime metadata, and coordination state.
- Message format that can represent model output, tool calls, approvals, failures, and handoffs.
- Clear reducer behavior for partial results, failed tools, and resumed sessions.
- SDK/OpenAPI regeneration after protocol changes.

Verification:

```bash
cd packages/opencode
bun typecheck
bun test test/session
./../../packages/sdk/js/script/build.ts
```

### 3. Agent Registry And Management

Goal: make agent creation and selection as repeatable as authoring a skill, but with stronger contracts.

Scope:

- Agent loader and registry.
- Agent metadata validation.
- Agent list and management API.
- UI support for selecting and inspecting agents.
- Tests for invalid definitions, directory boundaries, and runtime fallback behavior.

Verification:

```bash
cd packages/opencode
bun test test/agent test/server/agent-manage.test.ts
bun typecheck
```

```bash
cd packages/app
bun test:unit
bun typecheck
```

### 4. Tool Execution And Permissions

Goal: treat tools as governed runtime actions instead of opaque model side effects.

Scope:

- Tool call envelope.
- Permission request and approval flow.
- Tool authority and scope checks.
- Audit events for tool start, output, error, and completion.
- Compatibility with existing shell, file, MCP, and question tools.

Constraints:

- Permission prompts are workflow controls, not a security sandbox.
- Existing environment names such as `OPENCODE_SERVER_PASSWORD` remain until a compatibility migration is designed.

### 5. Multi-Agent Coordination

Goal: define how multiple agents cooperate inside one controlled runtime.

Scope:

- Delegation protocol.
- Child-agent execution records.
- State sharing rules.
- Review and handoff messages.
- Failure propagation and cancellation.
- UI representation of active, completed, failed, and archived child work.

Acceptance criteria:

- Parent and child agent runs are inspectable.
- Handoffs preserve enough context for audit and resume.
- Failed child work cannot be silently dropped from the parent timeline.

### 6. Client Surfaces

Goal: expose harness state consistently across TUI, web, desktop, editor, and automation integrations.

Scope:

- Shared web app in `packages/app`.
- Tauri desktop in `packages/desktop`.
- Electron desktop in `packages/desktop-electron`.
- VS Code extension in `sdks/vscode`.
- GitHub Action in `github`.
- Slack integration in `packages/slack`.
- ACP implementation in `packages/opencode/src/acp`.

Rules:

- Do not publish upstream opencode install instructions as Open Agent Harness docs.
- Where trigger names or command namespaces still use opencode compatibility names, document them as migration details.
- Keep generated SDK files synchronized with API changes.

## Release Readiness Checklist

- `README.md` and `README.zh.md` describe Open Agent Harness.
- No top-level obsolete translated README files remain.
- High-priority package README files no longer describe upstream OpenCode.
- `CONTRIBUTING.md` and `SECURITY.md` are fork-specific.
- `.github` workflows point to correct Open Agent Harness release and package targets.
- `packages/web/src/content/docs` is migrated, archived, or excluded from release.
- `packages/docs` is either migrated or explicitly excluded from release.
- SDK generation has been run after API changes.
- Type checks pass from changed package directories.
- Focused tests pass for changed runtime and UI surfaces.

## Command Reference

Repository root:

```bash
bun install
bun dev --help
bun dev serve
bun run --cwd packages/app dev
```

Runtime package:

```bash
cd packages/opencode
bun typecheck
bun test --timeout 30000
bun run build
```

Shared app:

```bash
cd packages/app
bun typecheck
bun test:unit
```

SDK:

```bash
./packages/sdk/js/script/build.ts
```
