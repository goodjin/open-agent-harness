# Open Agent Harness Root Directory

## User Goal

Run the packaged Open Agent Harness with its own root directory at `/Users/jin/.open-agent-harness`, so local harness state no longer shares the official `opencode` directories.

## Agreed Scope

- Treat `/Users/jin/.open-agent-harness` as the root for harness runtime files.
- Store config under `/Users/jin/.open-agent-harness/config`.
- Store data, history, databases, storage, snapshots, tool output, and downloaded binaries under `/Users/jin/.open-agent-harness/data`.
- Store logs under `/Users/jin/.open-agent-harness/log`.
- Store cache under `/Users/jin/.open-agent-harness/cache`.
- Store state under `/Users/jin/.open-agent-harness/state`.
- Copy existing local `opencode` config/data/cache/state into the new root without deleting or mutating the old directories.
- Keep the existing `opencode` directories available for the official `opencode` runtime.

## Implementation Plan

- Change the global path resolver in `packages/opencode/src/global/index.ts` from XDG `opencode` directories to the new root directory layout.
- Preserve `Global.Path.home` as the user home path so workspace-relative behavior and user-home display remain unchanged.
- Update user-facing config path text and config loading comments that still point to `~/.config/opencode`.
- Copy existing files:
  - `/Users/jin/.config/opencode` to `/Users/jin/.open-agent-harness/config`
  - `/Users/jin/.local/share/opencode` to `/Users/jin/.open-agent-harness/data`
  - `/Users/jin/.cache/opencode` to `/Users/jin/.open-agent-harness/cache`
  - `/Users/jin/.local/state/opencode` to `/Users/jin/.open-agent-harness/state`
- Avoid deleting source files and avoid overwriting unrelated repository changes.

## Affected Modules

- `packages/opencode/src/global/index.ts`
- `packages/opencode/src/config/config.ts`
- `packages/opencode/src/cli/cmd/tui/component/tips.tsx`
- `docs/harness-module/` module documentation for runtime path behavior

## Verification Plan

- Run a direct path check from `packages/opencode` to confirm `Global.Path` resolves to `/Users/jin/.open-agent-harness`.
- Run focused config tests from `packages/opencode` when practical.
- Run `bun typecheck` from `packages/opencode`.
- Inspect copied target directories and confirm key history files such as databases and storage are present in the new data directory.
