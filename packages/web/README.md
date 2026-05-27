# Open Agent Harness Web Docs

`packages/web` contains the Astro/Starlight documentation site inherited from the upstream codebase.

The content under `src/content/docs` still needs a product-scope review before public Open Agent Harness release. Many pages are upstream opencode documentation and should either be migrated, archived, or removed.

## Development

```bash
bun run --cwd packages/web dev
```

## Build

```bash
bun run --cwd packages/web build
```

## Preview

```bash
bun run --cwd packages/web preview
```

## Content

Starlight reads documentation from:

```text
packages/web/src/content/docs
```

When editing this package, check for stale opencode branding, upstream URLs, package names, and install instructions before publishing.
