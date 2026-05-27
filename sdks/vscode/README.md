# Open Agent Harness VS Code Extension

This package contains the VS Code extension for Open Agent Harness.

The extension opens the harness CLI in an integrated terminal, starts new sessions, and can insert file references from the active editor into the terminal prompt.

## Prerequisites

Install dependencies inside the extension package:

```bash
cd sdks/vscode
bun install
```

For runtime use, the Open Agent Harness CLI must be available on `PATH`. During local repository development, run the CLI from `packages/opencode`:

```bash
bun run --cwd packages/opencode --conditions=browser ./src/index.ts --help
```

## Features

- Quick launch: `Cmd+Esc` on macOS or `Ctrl+Esc` on Windows/Linux opens or focuses a harness terminal.
- New session: `Cmd+Shift+Esc` on macOS or `Ctrl+Shift+Esc` on Windows/Linux starts a separate terminal session.
- Context sharing: selected editor text and active files can be sent to the terminal.
- File references: `Cmd+Option+K` on macOS or `Alt+Ctrl+K` on Windows/Linux inserts references such as `@File#L37-42`.

## Development

1. Open `sdks/vscode` in VS Code. Do not open the repository root for extension debugging.
2. Run `bun install` in `sdks/vscode`.
3. Press `F5` to launch an Extension Development Host.

Type-check, lint, and package:

```bash
bun run check-types
bun run lint
bun run package
```

During debugging, the TypeScript and esbuild watchers run in the VS Code terminal. Reload the Extension Development Host with `Developer: Reload Window` after changes.

## Migration Notes

The extension package name and display name have been migrated to Open Agent Harness. Some command identifiers may still use the historical `opencode.*` namespace for compatibility with existing keybindings and extension state. Rename those identifiers only as part of a deliberate extension migration.
