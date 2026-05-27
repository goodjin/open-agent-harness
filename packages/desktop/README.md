# Open Agent Harness Desktop

This package is the Tauri desktop shell for Open Agent Harness. It wraps the shared web UI from `packages/app`.

## Prerequisites

- Bun 1.3+
- Rust toolchain
- Platform-specific Tauri dependencies

See the Tauri v2 prerequisites for operating-system setup: https://v2.tauri.app/start/prerequisites/

## Development

From the repository root:

```bash
bun install
bun run --cwd packages/desktop tauri dev
```

Run only the Vite dev server:

```bash
bun run --cwd packages/desktop dev
```

## Build

```bash
bun run --cwd packages/desktop tauri build
```

## Troubleshooting

If Rust is missing, install it with rustup:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```
