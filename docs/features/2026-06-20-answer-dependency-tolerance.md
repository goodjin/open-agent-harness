# Answer Dependency Tolerance

## User Goal

Allow an Agent Protocol v2 package to continue execution when an executable item depends on a same-package `kind: "answer"` item.

## Scope

- Treat `depends` entries that reference same-package `answer` items as non-blocking.
- Preserve validation for dependencies that point to missing executable or historical action ids.
- Keep the behavior limited to `answer` items.

## Implementation Plan

- Collect same-package v2 `answer` ids during protocol normalization.
- Remove those ids from executable action `depends_on` arrays.
- Add schema coverage for the normalized dependency shape.

## Affected Modules

- `packages/opencode/src/protocol/schema.ts`
- `packages/opencode/test/protocol/schema.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- Run the focused protocol schema test.
- Run package typecheck if the focused test passes.
