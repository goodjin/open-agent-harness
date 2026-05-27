# Open Agent Harness

Open Agent Harness is a source-available runtime for protocol-driven coding agents. It is built from the opencode source tree and keeps the parts that make opencode a strong local coding environment, while reshaping the agent layer around a harness: a managed space where agents, tools, requests, and runtime state can be described, routed, observed, and composed.

The core idea is simple: creating an agent should feel as lightweight as creating a skill. A skill should not be a loose prompt fragment sitting beside the system. In Open Agent Harness, skills become agents with explicit contracts, request shapes, tool boundaries, and cooperation rules.

## What Changed

Open Agent Harness focuses on four design moves:

- Rewrite the tool call mechanism so tool execution is governed by the harness instead of being treated as an opaque model side effect.
- Redefine the request format so agent input, tool intent, runtime context, and coordination metadata can travel together.
- Convert skills into first-class agents, making agent creation as simple and repeatable as authoring a skill.
- Design a multi-agent management protocol for routing, delegation, state sharing, review, and handoff inside a controlled harness environment.

The goal is not only to run a coding agent. The goal is to make agent collaboration legible enough that a runtime can supervise it.

## Harness Philosophy

Agents should be small, named, and understandable. Each agent should know its role, available tools, input contract, and output contract. The harness coordinates those agents without hiding the path work took through the system.

Tool calls should be structured actions, not just strings emitted by a model. A tool call has authority, scope, inputs, outputs, errors, and audit history. Open Agent Harness treats that structure as part of the runtime protocol.

Multi-agent systems should be designed like operating environments. The harness defines how agents are created, how they cooperate, how they ask for help, how they hand off work, and how their work can be inspected later.

## Status

This repository is currently a modified opencode codebase. The public identity, package name, CLI entry, license, and documentation have been changed to Open Agent Harness, while some compatibility paths may still reference opencode during the migration.

## Repository Layout

The repository is a Bun monorepo. The main runtime package still lives under `packages/opencode` during the migration.

| Path | Purpose |
| --- | --- |
| `packages/opencode` | Main Open Agent Harness runtime, CLI, server, session system, agent registry, tool execution, ACP support, and protocol implementation. |
| `packages/app` | Shared Solid/Vite web UI used by browser and desktop clients. |
| `packages/desktop` | Tauri desktop shell for the shared app. |
| `packages/desktop-electron` | Electron desktop shell. |
| `packages/sdk` | OpenAPI definition and generated SDK artifacts. Regenerate the JavaScript SDK with `./packages/sdk/js/script/build.ts`. |
| `packages/web` | Astro/Starlight documentation site inherited from upstream. Its content still needs product-scope review before release. |
| `packages/docs` | Mintlify documentation workspace inherited from upstream. It is not the canonical docs surface yet. |
| `packages/plugin`, `packages/script`, `packages/ui`, `packages/util` | Supporting workspace packages inherited from the upstream codebase. Some package names still use `@open-agent-harness/*` for compatibility. |
| `github` | GitHub Action integration package. Current trigger compatibility may still include legacy `/opencode` behavior. |
| `sdks/vscode` | VS Code extension package for launching and interacting with the harness from the editor. |
| `docs` | Migration plans, architecture notes, bugfix notes, audits, and protocol design material. |
| `infra` | Infrastructure definitions inherited from the upstream console/cloud surface. Review before production use. |
| `.github` | GitHub repository automation. Only low-risk CI workflows are retained; publishing, deployment, signing, bot, notification, and mutation workflows were removed pending Open Agent Harness release design. |
| `.husky` | Local Git hooks. The pre-push hook checks Bun version and runs package-level typechecks. |

## AI Agent Guidelines

AI agents working in this repository should optimize for correctness, traceability, and migration safety.

- Treat Open Agent Harness as the product identity. Mention opencode only for upstream provenance, compatibility paths, or still-unmigrated internal names.
- Preserve user changes. Do not revert unrelated work in the tree, and inspect touched files before editing around existing modifications.
- Keep changes scoped. Avoid opportunistic refactors unless they directly reduce risk for the requested change.
- Follow [AGENTS.md](./AGENTS.md) for style rules. In particular, prefer Bun APIs, avoid `any`, avoid unnecessary destructuring, prefer early returns, and keep new identifiers short when clear.
- Run checks from package directories, not from the repository root. Use `bun typecheck` inside packages such as `packages/opencode` or `packages/app`.
- Regenerate SDK artifacts after API or protocol changes with `./packages/sdk/js/script/build.ts`.
- Keep generated files synchronized with source changes. Do not hand-edit generated SDK files unless the generator is being fixed.
- Do not reintroduce upstream release, deployment, signing, docs translation, or bot automation without an explicit Open Agent Harness release decision.
- Do not add project-level `.opencode` agent, command, or tool config unless the repository intentionally ships that config.
- Document compatibility names explicitly. If a file still needs `packages/opencode`, `OPENCODE_*`, `.opencode`, `@open-agent-harness/*`, or `/opencode`, explain whether it is a migration constraint or public behavior.

## Installation

```bash
bun install
bun run --cwd packages/opencode --conditions=browser ./src/index.ts --help
```

During local development, you can run the main package directly:

```bash
bun run --cwd packages/opencode --conditions=browser ./src/index.ts --help
```

## License

Open Agent Harness is distributed under the GNU Affero General Public License v3.0, following the same open source licensing model used by MinIO. Commercial licensing exceptions may be offered separately by the Open Agent Harness copyright holder.

This project includes source code derived from opencode, which was originally distributed under the MIT License. The original opencode copyright notice and MIT license text are preserved in [LICENSE](./LICENSE).

Open Agent Harness is not built by the OpenCode team and is not affiliated with OpenCode, opencode.ai, or anomalyco.

## Third-Party Licenses

The runtime depends on third-party packages under MIT, Apache-2.0, BSD-3-Clause, ISC, BlueOak-1.0.0, and related permissive licenses. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for the current dependency license inventory and the module that introduces each license.
