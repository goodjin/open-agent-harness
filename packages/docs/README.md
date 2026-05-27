# Open Agent Harness Mintlify Docs

`packages/docs` is a Mintlify documentation workspace inherited from the upstream repository.

This package is not currently the canonical Open Agent Harness documentation surface. Treat it as a candidate docs site until the project decides whether to keep Mintlify, Astro/Starlight in `packages/web`, or a smaller docs set under the repository root.

## Development

Install the Mintlify CLI if you need to preview this package:

```bash
npm i -g mint
```

Run from `packages/docs`, where `docs.json` lives:

```bash
cd packages/docs
mint dev
```

## Review Before Publishing

Before publishing this docs workspace:

- Confirm all pages describe Open Agent Harness rather than upstream opencode.
- Confirm navigation in `docs.json` matches the current product scope.
- Remove starter content and unused examples.
- Validate API references against the generated Open Agent Harness OpenAPI file.
