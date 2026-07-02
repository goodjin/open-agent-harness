# Runtime Paths Module

## Harness Root

Packaged Open Agent Harness uses `/Users/jin/.open-agent-harness` as its local runtime root. The root is intentionally separate from the official `opencode` XDG directories so both runtimes can coexist on the same machine.

Runtime paths are resolved by `packages/opencode/src/global/index.ts`:

- `config`: `/Users/jin/.open-agent-harness/config`
- `data`: `/Users/jin/.open-agent-harness/data`
- `log`: `/Users/jin/.open-agent-harness/log`
- `cache`: `/Users/jin/.open-agent-harness/cache`
- `state`: `/Users/jin/.open-agent-harness/state`
- `bin`: `/Users/jin/.open-agent-harness/data/bin`

`Global.Path.home` remains the user's home directory. It is not the harness root, because workspace display, home-relative paths, and imported user assets still need the real user home.

## Historical Data Migration

The local migration copies existing OpenCode-backed runtime files into the harness root without removing the source directories:

- `/Users/jin/.config/opencode` -> `/Users/jin/.open-agent-harness/config`
- `/Users/jin/.local/share/opencode` -> `/Users/jin/.open-agent-harness/data`
- `/Users/jin/.cache/opencode` -> `/Users/jin/.open-agent-harness/cache`
- `/Users/jin/.local/state/opencode` -> `/Users/jin/.open-agent-harness/state`

The old directories are left intact for the official `opencode` runtime. Future Open Agent Harness restarts should read and write only under `/Users/jin/.open-agent-harness` unless a caller explicitly sets custom config environment variables such as `OPENCODE_CONFIG` or `OPENCODE_CONFIG_DIR`.

## Test Isolation

Tests continue to use `OPENCODE_TEST_HOME`. When that environment variable is set before `Global.Path` is imported, the harness root is created under that test home instead of the real user home.
