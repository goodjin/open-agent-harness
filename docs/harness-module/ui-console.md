# UI Console Module

## Prompt Shell Detection

The app prompt input supports two shell paths:

- explicit shell mode, entered from the mode control or the leading `!` shortcut,
- automatic shell detection while the prompt remains in normal mode.

Automatic detection is intentionally anchored to the start of the trimmed prompt. A normal-mode prompt is auto-submitted as shell only when the first token is a known shell command, or when the prompt starts with an environment assignment followed by a command-like value.

Text that contains shell snippets later in the sentence stays normal chat. Examples such as `please run npm test && bun typecheck`, `帮我运行 rg foo | head`, or `content includes shell: git status` must not switch the composer into shell execution.

The detection function is shared by the composer affordance and submit path, so UI state and actual routing stay aligned.

## Session Workspace Layout

Desktop session pages keep global workspace controls in the app titlebar right slot. Status, session tree, terminal, review, file-tree, and side-panel toggle controls should not live in the sticky session title row.

The sticky session title row remains scoped to the active conversation: parent navigation, title editing, context usage, and the session menu.

The session title row also shows compact runtime statistics for the active conversation: model, current status name, token usage, and cost. These values are derived from the active session messages and session status map, not from legacy session tree metadata.

The turn filter row for all, thinking, input, output, and tool calls is part of the sticky title area and must use an opaque background. Timeline content should not be visible through the filter row while scrolling.

When a turn creates delegated child sessions, the timeline renders the child session list from the parent session protocol state. Pending and completed delegation rows share one list, and each row reads the live `session.status` map so running, waiting, interrupted, failed, blocked, user-completed, and completed children update without waiting for a parent reply. Every child row keeps an Open action so ended sessions remain inspectable. Live children expose Pause; interrupted children expose Restore. Unfinished children may be marked user-completed by explicit user action. Ended children do not show a generic Continue action.

The child session list footer includes two parent-run actions. "Stop waiting" calls the parent-session delegation submit route with force enabled, which sends current child results and statuses back to the parent as one aggregate handoff while allowing pending children to continue independently. "Cancel children and continue" writes a cancellation command into each pending child session, cancels their active prompts, marks them aborted, and then submits the aggregate handoff to the parent.

The session title menu exposes "mark as user completed" for unfinished, interrupted, failed, blocked, paused, waiting, timeout, and aborted sessions. The UI label must distinguish this state from natural runtime completion.

The right-side session panel owns Review, Logs, Graph or Protocol, file tree, context, and file tabs. Its tab strip includes a collapse control that closes the whole right panel through `reviewPanel.close()`, allowing the timeline and composer to reclaim the width. The topbar keeps a side-panel toggle next to the file-tree control, so a collapsed panel still has a visible expand entry. Topbar Review and file-tree controls also reopen the panel before selecting their target tab.

## Session Logs

Session status transitions emit `session.status.changed` log records. Each record includes the previous status type, new status type, full previous and new status payloads, and a reason derived from the transition context or status message. The logs panel exposes a Status filter so state-machine changes can be inspected separately from LLM, tool, and protocol activity.

LLM request rows keep the timeline lightweight by showing the provider/model summary, message count, tool count, logged byte count, and a large-payload reference in the list. The expanded detail view still treats logs as inspectable records: when a request log only contains persisted message IDs and summary byte counts, the Messages and User sections expose a full-content action that fetches the corresponding session messages and renders their parts on demand.

The final provider request payload is stored outside the log row under a session-scoped payload id. The Payload section loads it on demand and shows the transformed provider params plus the final active tool list, including native runtime tools such as `ActionResult`. This keeps large system prompts, message arrays, and tool schemas out of the default list render while preserving the exact request evidence needed for request forensics.
