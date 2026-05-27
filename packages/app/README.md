# Open Agent Harness App

`packages/app` contains the shared Solid/Vite web UI used by the browser app and desktop shells.

The UI talks to a running Open Agent Harness server. During migration, the backend package path is still `packages/opencode`.

## Development

Start the harness server from the repository root:

```bash
bun dev serve
```

Start the web app:

```bash
bun run --cwd packages/app dev
```

The Vite server prints the local URL, usually `http://localhost:3000` or another available port.

## Build

```bash
bun run --cwd packages/app build
```

## Type Checking

```bash
bun run --cwd packages/app typecheck
```

## Unit Tests

```bash
bun run --cwd packages/app test:unit
```

## E2E Tests

Playwright starts the Vite dev server automatically via `webServer`. UI tests need a harness backend, defaulting to `localhost:4096`.

Use the local runner to create a temporary sandbox, seed data, and run tests:

```bash
bunx playwright install
bun run --cwd packages/app test:e2e:local
bun run --cwd packages/app test:e2e:local -- --grep "settings"
```

Environment options:

- `PLAYWRIGHT_SERVER_HOST`: backend host, default `localhost`.
- `PLAYWRIGHT_SERVER_PORT`: backend port, default `4096`.
- `PLAYWRIGHT_PORT`: Vite dev server port, default `3000`.
- `PLAYWRIGHT_BASE_URL`: override base URL, default `http://localhost:<PLAYWRIGHT_PORT>`.
