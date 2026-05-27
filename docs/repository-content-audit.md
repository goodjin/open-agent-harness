# Repository Content Audit

Date: 2026-05-27

## Scope

This audit covers the repository layout, dot-prefixed directories, README alignment, and documentation that still appears to describe upstream opencode instead of Open Agent Harness.

The current repository is a Bun monorepo derived from opencode. The top-level package name is `open-agent-harness`, the default branch is `dev`, and the main runtime still lives under `packages/opencode` while the migration is in progress.

## Directory Map

| Path                                                                 | Role                                                 | Notes                                                                                                                                |
| -------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/opencode`                                                  | Main Open Agent Harness runtime and CLI package      | Package name is already `open-agent-harness`; path still uses `opencode` for migration compatibility.                                |
| `packages/app`                                                       | Solid/Vite web UI used by browser and desktop shells | README rewritten for Open Agent Harness app development.                                                                             |
| `packages/desktop`                                                   | Tauri desktop shell                                  | README rewritten for Open Agent Harness desktop development.                                                                         |
| `packages/desktop-electron`                                          | Electron desktop shell                               | README rewritten for the Electron desktop package.                                                                                   |
| `packages/sdk`                                                       | Generated OpenAPI and SDK artifacts                  | JavaScript SDK regeneration should use `./packages/sdk/js/script/build.ts`.                                                          |
| `packages/plugin`, `packages/script`, `packages/util`, `packages/ui` | Workspace support packages inherited from opencode   | Workspace package namespace has been migrated to `@open-agent-harness/*`; directory paths remain unchanged for now.                  |
| `packages/web/src/content/docs`                                      | Starlight documentation site content                 | Large upstream opencode docs set remains; package README now marks this as a product-scope decision.                                 |
| `packages/docs`                                                      | Mintlify documentation workspace                     | README rewritten and marks this package as a candidate docs surface.                                                                 |
| `github`                                                             | GitHub Action package                                | README rewritten for Open Agent Harness with explicit legacy trigger notes.                                                          |
| `sdks/vscode`                                                        | VS Code extension                                    | README rewritten for Open Agent Harness with command namespace migration notes.                                                      |
| `docs/harness-protocol`                                              | Current Harness governance protocol docs             | Numbered protocol documents with support material under `support/`.                                                                  |
| `docs/archive/agent-rewrite`                                         | Historical rewrite planning docs                     | Migration-relevant archive; many mission ids still include opencode intentionally as history.                                        |
| `docs/bugfix`                                                        | Historical fix notes                                 | Mostly useful as engineering history; opencode path mentions are usually code-path references.                                       |
| `infra`, `packages/console`, `packages/enterprise`, `packages/slack` | Upstream console/cloud/community surfaces            | Need a product decision: either migrate to Open Agent Harness identity or remove from distribution if not part of the harness scope. |

## Dot Directory Audit

| Path              | Git status                         | Recommendation                                                                                                                                                                                                 |
| ----------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.git`            | Local Git metadata                 | Keep local only; never sync.                                                                                                                                                                                   |
| `.github`         | Retained with reduced workflow set | High-risk publish, deploy, signing, bot, issue/PR mutation, notification, auto-commit, and upstream opencode workflows were removed. Remaining workflows are `test`, `typecheck`, `nix-eval`, and `storybook`. |
| `.husky`          | 1 tracked file retained            | `pre-push` now checks Bun version and runs package-level typechecks from `packages/opencode` and `packages/app`.                                                                                               |
| `.opencode`       | Removed from working tree          | Upstream opencode project agents, commands, tools, glossary, and local dependency artifacts were removed. The path is ignored to avoid reintroducing local agent config by accident.                           |
| `.claude`         | Removed from working tree          | Local orchestration state should not be synced to GitHub. Durable plans should live under `docs/`.                                                                                                             |
| `.signpath`       | Removed from working tree          | The tracked opencode signing policy was removed. Add a new Open Agent Harness policy only if signing is reintroduced.                                                                                          |
| `.vscode`         | Removed from working tree          | Editor-specific settings and examples were removed from Git-tracked content.                                                                                                                                   |
| `.zed`            | Removed from working tree          | Editor-specific settings were removed from Git-tracked content.                                                                                                                                                |
| `.turbo`          | ignored cache                      | Deleted locally; keep ignored.                                                                                                                                                                                 |
| `.worktrees`      | ignored local workspace            | Deleted locally; keep ignored.                                                                                                                                                                                 |
| `.playwright-mcp` | untracked local browser logs       | Deleted locally and added to `.gitignore`.                                                                                                                                                                     |
| `.DS_Store`       | ignored macOS metadata             | Deleted locally; keep ignored.                                                                                                                                                                                 |

## README Alignment

Top-level `README.md` is already written for Open Agent Harness and explains the opencode-derived status, protocol-driven runtime, multi-agent harness direction, installation, and licensing.

Open Agent Harness is not maintaining multilingual landing docs yet. The obsolete translated top-level README files were removed, except for `README.zh.md`.

`README.zh.md` is retained as the Simplified Chinese translation of the canonical `README.md`.

## Documentation Identity Cleanup

Rewritten files:

| Path                                  | Issue                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `CONTRIBUTING.md`                     | Rewritten for Open Agent Harness contribution, package layout, checks, and migration constraints.                  |
| `SECURITY.md`                         | Rewritten for Open Agent Harness threat model while documenting retained `OPENCODE_SERVER_PASSWORD` compatibility. |
| `github/README.md`                    | Rewritten as an experimental Open Agent Harness GitHub Action document with legacy trigger notes.                  |
| `sdks/vscode/README.md`               | Rewritten for Open Agent Harness VS Code extension development.                                                    |
| `packages/desktop/README.md`          | Rewritten as the Tauri Open Agent Harness desktop package.                                                         |
| `packages/desktop-electron/README.md` | Rewritten as the Electron Open Agent Harness desktop package.                                                      |
| `packages/app/README.md`              | Rewritten as the shared Open Agent Harness Solid/Vite app.                                                         |
| `packages/web/README.md`              | Rewritten as the Astro/Starlight docs package and marks content migration as pending.                              |
| `packages/docs/README.md`             | Rewritten as the inherited Mintlify docs package and marks publishing review requirements.                         |
| `packages/opencode/src/acp/README.md` | Rewritten as the Open Agent Harness ACP implementation documentation.                                              |
| `packages/containers/README.md`       | Rewritten for Open Agent Harness CI containers.                                                                    |
| `packages/slack/README.md`            | Rewritten for Open Agent Harness Slack integration while documenting retained compatibility names.                 |

Remaining content requiring product decisions:

| Path                              | Issue                                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/web/src/content/docs`   | 630 tracked `.md/.mdx` docs with roughly 19k opencode-branded lines. This is effectively the upstream docs site and should be migrated or removed as a product decision. |
| `docs/DEVELOPMENT_PLAN.md`        | Rewritten as the current Open Agent Harness migration and release-readiness plan.                                                                                        |
| `docs/harness-protocol/support/*` | Research and evaluation support material, not normative protocol source.                                                                                                 |
| `docs/archive/agent-rewrite/*`    | Historical planning archive; opencode-era titles and mission ids are acceptable historical context.                                                                      |

Acceptable opencode references:

| Path                      | Reason                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`               | Mentions opencode as upstream provenance and compatibility context.                                                                          |
| `README.zh.md`            | Mirrors `README.md` upstream provenance and compatibility context.                                                                           |
| `LICENSE`                 | Must preserve upstream opencode MIT notice.                                                                                                  |
| `THIRD_PARTY_NOTICES.md`  | Mentions inherited package names and source paths intentionally.                                                                             |
| Rewritten package READMEs | Mention `packages/opencode`, `OPENCODE_*`, `.opencode`, or `/opencode` only as current compatibility details requiring deliberate migration. |
| `docs/bugfix/*`           | Mostly historical notes and code-path references.                                                                                            |

## Suggested Cleanup Order

1. Make a product-scope decision on `packages/web/src/content/docs`, `packages/docs`, console/cloud packages, and any future signing policy before public release.
2. Keep package namespace changes scoped to `@open-agent-harness/*`; defer directory, CLI command, protocol scheme, and environment-variable renames to deliberate compatibility migrations.
