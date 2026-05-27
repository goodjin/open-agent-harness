# Open Agent Harness Electron Desktop

This package is the Electron desktop shell for Open Agent Harness. It uses `electron-vite` and is separate from the Tauri desktop package in `packages/desktop`.

## Development

From the repository root:

```bash
bun install
bun run --cwd packages/desktop-electron dev
```

## Build

Create the production Electron bundle:

```bash
bun run --cwd packages/desktop-electron build
```

Package platform artifacts:

```bash
bun run --cwd packages/desktop-electron package
bun run --cwd packages/desktop-electron package:mac
bun run --cwd packages/desktop-electron package:win
bun run --cwd packages/desktop-electron package:linux
```

## Native Helper

If the native helper changes, build it from this package:

```bash
bun run --cwd packages/desktop-electron native:build
```
