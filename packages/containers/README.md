# CI Containers

This package defines prebuilt Linux container images for GitHub Actions jobs. The images bake in slow-to-install dependencies used by Open Agent Harness CI.

## Images

- `base`: Ubuntu 24.04 with common build tools and utilities.
- `bun-node`: `base` plus Bun and Node.js 24.
- `rust`: `bun-node` plus stable Rust.
- `tauri-linux`: `rust` plus Tauri Linux build dependencies.
- `publish`: `bun-node` plus Docker CLI and AUR tooling.

## Build

```bash
REGISTRY=ghcr.io/goodjin TAG=24.04 bun ./packages/containers/script/build.ts
REGISTRY=ghcr.io/goodjin TAG=24.04 bun ./packages/containers/script/build.ts --push
```

Adjust `REGISTRY` for the target GitHub organization before publishing.

## Workflow Usage

```yaml
jobs:
  build-cli:
    runs-on: ubuntu-latest
    container:
      image: ghcr.io/goodjin/build/bun-node:24.04
```

## Notes

- These images only help Linux jobs. macOS and Windows jobs cannot run inside Linux containers.
- `--push` publishes multi-arch images using Buildx.
- Jobs that use Docker Buildx need access to the host Docker daemon or a privileged Docker-in-Docker setup.
