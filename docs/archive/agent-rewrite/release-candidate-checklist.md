# MOD-16 Release Candidate Checklist

This document prepares the release candidate step for `feature-mod-16-release-hardening`. Do not create a branch or tag until the maintainer accepts the candidate.

## Scope

- T-1601: package manifests contain only intentional fork fields
- T-1602: dead imports and obsolete dependencies are removed or documented
- T-1603: SDK is regenerated after final API changes
- T-1604: upstream migration guide is available
- T-1605: `packages/opencode` test suite is attempted from the package directory
- T-1606: repo-level build checks are run or blockers are documented
- T-1607: style guide and atomic scope review findings are fixed or tracked
- T-1608: release candidate branch/tag is prepared but not created

## Required Commands

Run from the repository root unless the command specifies a package directory.

```sh
./packages/sdk/js/script/build.ts
cd packages/sdk/js && bun typecheck
cd packages/opencode && bun typecheck
cd packages/opencode && ./bin/jin --version
cd packages/opencode && npm pack --dry-run --json
cd packages/opencode && bun test --timeout 30000
cd packages/opencode && bun run gate:mod15
cd packages/opencode && bun run build
bun run typecheck
if rg -n "ghostty-web.*20bd361" bun.lock; then exit 1; fi
```

## Acceptance Step

After maintainers accept the release candidate, create the branch or tag at the verified commit.

Recommended branch name:

```sh
git branch release/mod-16-rc <verified-commit>
```

Recommended tag name:

```sh
git tag mod-16-rc.1 <verified-commit>
```

Do not push either artifact until the acceptance decision names the expected branch or tag.

## Known Review Points

- Keep `jin-opencode` package name and `packages/opencode/bin/jin` as the intentional `jin` binary artifact. `git status --short packages/opencode/bin/jin` should show the new file before staging, and `npm pack --dry-run --json` should list `bin/jin` with executable mode.
- Keep unrelated `ghostty-web` lockfile drift out of the release diff unless a package manifest change explicitly requires it.
- Keep plugin and skill removal as intentional fork behavior.
- Keep generated SDK files in sync with `packages/sdk/openapi.json`.
- Confirm normal API, SDK, and TUI flows do not require `workspaceID`, `?workspace=`, or `x-opencode-workspace`; directory selection is the workspace boundary.
- Record any unrelated test blockers with command, failing test name, and likely owner.
