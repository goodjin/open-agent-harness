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

This repository is currently a modified opencode codebase. The public identity, package name, CLI entry, license, and documentation have been changed to Open Agent Harness, while some internal workspace package names and compatibility paths may still reference opencode during the migration.

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

Open Agent Harness is distributed under the PolyForm Noncommercial License 1.0.0. Noncommercial use is permitted under that license. Commercial use requires a separate commercial license from the Open Agent Harness copyright holder.

This project includes source code derived from opencode, which was originally distributed under the MIT License. The original opencode copyright notice and MIT license text are preserved in [LICENSE](./LICENSE).

Open Agent Harness is not built by the OpenCode team and is not affiliated with OpenCode, opencode.ai, or anomalyco.

## Third-Party Licenses

The runtime depends on third-party packages under MIT, Apache-2.0, BSD-3-Clause, ISC, BlueOak-1.0.0, and related permissive licenses. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for the current dependency license inventory and the module that introduces each license.
