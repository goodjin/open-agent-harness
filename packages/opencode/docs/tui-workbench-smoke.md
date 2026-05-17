# TUI Workbench Smoke Script

Manual coverage for `feature-mod-12-tui-workbench` / `T-1201` through `T-1208`.

Run from `packages/opencode`:

```sh
bun run dev
```

1. Start:
   - Open a session.
   - Verify the header shows the session title, current agent id, and status `ready`.

2. Prompt:
   - Send a short prompt.
   - Verify the header changes to `thinking` while work is active and returns to `ready` when complete.

3. Permission:
   - Trigger a permission-gated tool such as an edit or shell command that asks.
   - Verify the permission panel shows the requested action plus a `Decision trace` row with source, rule, result, and matched rule count.
   - Approve once and verify the session continues.
   - Repeat and reject once to verify reject feedback still works.

4. Agent switch:
   - Run `/agents` or the agent picker keybind.
   - Select a different registry-backed agent.
   - Send the next prompt.
   - Verify the new user/assistant messages use the selected agent and prior session history remains visible.

5. Error banner:
   - Trigger an error status in the current session.
   - Verify the error banner appears below the transcript.
   - Press `enter` or `esc`.
   - Verify the banner dismisses and no unrelated running session is aborted.

6. Checkpoint restore:
   - Use a session with at least one step checkpoint.
   - Run `/checkpoints`.
   - Select a checkpoint and confirm restore.
   - Verify the success toast appears and workspace files match that checkpoint.

7. Removed surfaces:
   - Open `/status` and command search.
   - Verify no stale skill or plugin panels, counts, or commands appear.
