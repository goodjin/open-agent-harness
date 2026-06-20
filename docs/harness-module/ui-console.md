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

The composer area owns the live bottom status line for the active session. It derives a compact label and description from the synchronized `session.status` map, active session messages, and streamed message parts. Running sessions should show a precise state such as request queued, request sent, responding, thinking, running a tool, replying with text, rate limited, waiting on permission, waiting on user input, or waiting on child sessions. Completed, user-completed, archived, or idle sessions do not show the live line. A latest user turn with `metadata.turn.status === "done"` also suppresses the generic responding line, even if stale assistant parts are still present in the local message cache.

Rate-limited status copy must distinguish concurrency from request frequency. `kind: "concurrency"` means an active provider, model, or agent slot count is full and should show active/limit. `kind: "rpm"` means the rolling request window is full and should be described as request frequency rather than concurrent sessions.

Session turn rendering groups assistant messages by `assistant.parentID === user.id`, not by a simple contiguous user/assistant block. Follow-up user messages, manual continues, retries, or failed tool-call recovery can append assistant messages after later user messages while still belonging to an earlier turn. The timeline and its thinking/output/tool filters must preserve those parent-linked assistant parts so streamed thinking, text output, failed tools, and final error cards remain visible after the session ends.

When a turn creates delegated child sessions, the timeline renders the child session list from the parent session protocol state. Pending and completed delegation rows share one list, and each row reads the live `session.status` map so running, waiting, interrupted, failed, blocked, user-completed, and completed children update without waiting for a parent reply. Every child row keeps an Open action so ended sessions remain inspectable. Live children expose Pause; interrupted children expose Restore. Unfinished children may be marked user-completed by explicit user action. Ended children do not show a generic Continue action.

Failed or blocked delegated children expose a Confirm Result action. It opens a dialog populated from the child's latest assistant text, explains that the model did not submit a native `ActionResult`, and lets the user edit the content before submitting it as a fallback result. Confirmation sends the edited text to the child-session fallback endpoint, refreshes both child and parent sessions, and leaves the child marked as user-completed.

The child session list footer includes two parent-run actions. "Stop waiting" calls the parent-session delegation submit route with force enabled, which sends current child results and statuses back to the parent as one aggregate handoff while allowing pending children to continue independently. "Cancel children and continue" writes a cancellation command into each pending child session, cancels their active prompts, marks them aborted, and then submits the aggregate handoff to the parent.

Sidebar parent-session summaries show recursive child progress as completed/total. Lightweight session-tree loads must carry child `status` values into the synchronized `session_status` map, because the sidebar does not load full child messages for every row. Child session creation also invalidates the directory session-tree cache so later reloads can refresh descendant totals instead of relying on stale root-loaded markers.

The session title menu exposes "mark as user completed" for unfinished, interrupted, failed, blocked, paused, waiting, timeout, and aborted sessions. The UI label must distinguish this state from natural runtime completion.

The right-side session panel owns Review, Logs, Graph or Protocol, file tree, context, and file tabs. Its tab strip includes a collapse control that closes the whole right panel through `reviewPanel.close()`, allowing the timeline and composer to reclaim the width. The topbar keeps a side-panel toggle next to the file-tree control, so a collapsed panel still has a visible expand entry. Topbar Review and file-tree controls also reopen the panel before selecting their target tab.

## Session Logs

Session status transitions emit `session.status.changed` log records. Each record includes the previous status type, new status type, full previous and new status payloads, and a reason derived from the transition context or status message. The logs panel exposes a Status filter so state-machine changes can be inspected separately from LLM, tool, and protocol activity.

LLM request rows keep the timeline lightweight by showing the provider/model summary, message count, tool count, logged byte count, and a large-payload reference in the list. The expanded detail view still treats logs as inspectable records: when a request log only contains persisted message IDs and summary byte counts, the Messages and User sections expose a full-content action that fetches the corresponding session messages and renders their parts on demand.

The final provider request payload is stored outside the log row under a session-scoped payload id. The Payload section loads it on demand and shows the transformed provider params plus the final active tool list, including native runtime tools such as `ActionResult`. This keeps large system prompts, message arrays, and tool schemas out of the default list render while preserving the exact request evidence needed for request forensics.
