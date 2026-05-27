# Contributing to Open Agent Harness

Open Agent Harness is a source-available fork of the opencode codebase. The current work is focused on turning the runtime into a protocol-driven harness for managed coding agents, structured tool execution, and multi-agent coordination.

## Current Priorities

Changes are most useful when they support the harness migration:

- Runtime, LLM, and tool-call protocol work
- Agent schema, loading, routing, and delegation behavior
- Multi-agent management, state sharing, review, and handoff flows
- Web UI and desktop UI changes that expose harness behavior clearly
- Bug fixes, type fixes, and focused regression tests
- Documentation that replaces stale upstream opencode instructions with Open Agent Harness content

Large product changes should start with an issue or design note before implementation.

## Development

Requirements:

- Bun 1.3+
- Node-compatible toolchain used by the workspace packages
- Rust and platform dependencies only when working on the Tauri desktop package

Install dependencies from the repository root:

```bash
bun install
```

Run the main runtime from the repository root:

```bash
bun dev --help
bun dev serve
bun dev web
bun dev <directory>
```

The primary runtime package still lives at `packages/opencode` during migration, but its package name and binary identity are Open Agent Harness:

```bash
bun run --cwd packages/opencode --conditions=browser ./src/index.ts --help
bun run --cwd packages/opencode --conditions=browser ./src/index.ts serve --port 4096
```

## Repository Layout

- `packages/opencode`: main Open Agent Harness runtime, CLI, server, protocol, and session logic.
- `packages/app`: shared Solid/Vite web UI.
- `packages/desktop`: Tauri desktop shell around the shared app.
- `packages/desktop-electron`: Electron desktop shell.
- `packages/sdk`: generated OpenAPI and SDK artifacts.
- `github`: GitHub Action integration package.
- `sdks/vscode`: VS Code extension package.
- `docs`: planning, migration, protocol, and audit documentation.

Workspace package names use the `@open-agent-harness/*` namespace. Directory names such as `packages/opencode`, compatibility environment variables, and protocol triggers may still use opencode-era names until those migrations are planned separately.

## Tests And Type Checking

Do not run tests from the repository root. The root `test` script is a guard.

Run checks from the package you changed:

```bash
cd packages/opencode
bun typecheck
bun test --timeout 30000
```

```bash
cd packages/app
bun typecheck
bun test:unit
```

```bash
cd packages/desktop
bun typecheck
```

For API or SDK changes, regenerate generated artifacts before finishing:

```bash
./packages/sdk/js/script/build.ts
```

## Web And Desktop Development

Start the runtime server first:

```bash
bun dev serve
```

Run the shared web UI:

```bash
bun run --cwd packages/app dev
```

Run the Tauri desktop app:

```bash
bun run --cwd packages/desktop tauri dev
```

Run the Electron desktop app:

```bash
bun run --cwd packages/desktop-electron dev
```

## Style

Follow [AGENTS.md](./AGENTS.md). In short:

- Keep changes focused.
- Prefer Bun APIs when they fit.
- Avoid `any`.
- Avoid unnecessary destructuring.
- Prefer early returns over `else`.
- Prefer `const`.
- Use short single-word local names when they remain clear.
- Use functional array methods when they improve clarity and type inference.

## Pull Requests

PRs should be small enough to review directly. Include:

- What changed
- Why it changed
- How it was verified
- Any known migration compatibility impact

Use conventional commit style for titles:

- `feat:` new behavior
- `fix:` bug fix
- `docs:` documentation
- `test:` tests
- `refactor:` behavior-preserving refactor
- `chore:` maintenance

Optional scopes are useful for package-local work, for example `fix(app):`, `docs(vscode):`, or `feat(opencode):`.

## Issues

Use issues for bugs, design discussions, protocol changes, and larger migration tasks. Include enough context for another contributor to reproduce the problem or evaluate the design.

For security issues, follow [SECURITY.md](./SECURITY.md) instead of opening a public issue.
