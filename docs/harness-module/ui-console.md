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

The composer area owns the live bottom status line for the active session. It derives a compact label, description, and optional metrics from the synchronized `session.status` map, active session messages, streamed message parts, and user-turn metadata. Running sessions should show a precise state such as request queued, request sent, responding, thinking, running a tool, replying with text, rate limited, waiting on permission, waiting on user input, or waiting on child sessions. When timing data exists, the line also shows elapsed duration. While receiving model output, it shows received UTF-8 bytes from streamed text, reasoning, and completed or errored tool output. While a request has been sent but no assistant output exists yet, it shows sent UTF-8 bytes from the user-visible request parts. This request-size metric intentionally does not represent the final provider payload size, which remains available through session logs and payload inspection. Completed, user-completed, archived, or idle sessions do not show the live line. A latest user turn with `metadata.turn.status === "done"` also suppresses the generic responding line, even if stale assistant parts are still present in the local message cache.

Rate-limited status copy must distinguish concurrency from request frequency. `kind: "concurrency"` means an active provider, model, or agent slot count is full and should show active/limit. `kind: "rpm"` means the rolling request window is full and should be described as request frequency rather than concurrent sessions.

Session turn rendering groups assistant messages by `assistant.parentID === user.id`, not by a simple contiguous user/assistant block. Follow-up user messages, manual continues, retries, or failed tool-call recovery can append assistant messages after later user messages while still belonging to an earlier turn. The timeline and its thinking/output/tool filters must preserve those parent-linked assistant parts so streamed thinking, text output, failed tools, and final error cards remain visible after the session ends.

Assistant text output renders Markdown while the response is still streaming. The renderer parses the accumulated text snapshot and, for display only, temporarily closes an unmatched fenced code block so partial code output stays readable. This does not change the stored part text, copied response text, logs, or final render; once the text part or assistant message is complete, the renderer uses the original Markdown exactly as received.

Malformed protocol output and failed `ActionResult` submissions in the session timeline use compact operator-facing displays. Internal `invalid` tool calls for failed `AgentProtocolOutput` parsing show only the error type `解析输出失败` and the captured model output. Failed `ActionResult` tool calls show only `解析结果失败` and the captured model submission. Detailed metadata, payload ids, byte counts, schema diagnostics, and export controls belong in the Logs panel, not in the main conversation timeline.

Session question docks render protocol confirmation and choice prompts in the composer or timeline. The dock is width-limited to avoid covering the whole session area and uses five viewport heights as the hard upper bound. Its footer is a fixed 56px bottom action area separated from one shared scrollable content box. Confirmation text scrolls inside that content box; choice prompts keep question text, hints, and options in the same scroll box, so selected-option notes, custom answers, and expanded descriptions stay grouped with the choices without pushing the buttons out of view. Question text and option descriptions use the shared Markdown renderer, and option descriptions keep the original text intact before the visual collapsed preview is applied.

The composer dock owns the active pending question surface. When the active timeline message contains the same pending question, or a pending protocol confirmation with the same tool-call key, the timeline hides that actionable card instead of rendering a second prompt. Non-active historical timeline confirmations can still render as status or review cards.

When a turn creates delegated child sessions, the timeline renders the child session list from the parent session protocol state. Pending and completed delegation rows share one list, and each row reads the live `session.status` map so running, waiting, interrupted, failed, blocked, user-completed, and completed children update without waiting for a parent reply. Every child row keeps an Open action so ended sessions remain inspectable. Live children expose Pause; interrupted children expose Restore. Unfinished children may be marked user-completed by explicit user action. Ended children do not show a generic Continue action.

Child session creation events are refresh signals for the parent timeline, not enough data to render a current-turn delegation row by themselves. When the app receives a child `session.created` with `parentID`, it records that parent as stale and keeps the existing session-tree invalidation. The parent list is refreshed only after that parent emits `session.updated`, then the app fetches the full parent session so `dsl_context.protocol.pending_delegations` is available again. This avoids rendering from a bare child row before `SessionDelegation.assign()` has written the parent protocol state.

Failed or blocked delegated children expose a Confirm Result action. It opens a dialog populated from the child's latest assistant text, explains that the model did not submit a native `ActionResult`, and lets the user edit the content before submitting it as a fallback result. Confirmation sends the edited text to the child-session fallback endpoint, refreshes both child and parent sessions, and leaves the child marked as user-completed.

The child session list footer includes two parent-run actions. "Cancel and continue" terminates each pending child session for the run, marks it aborted, records that no child result was requested, clears the parent pending delegation entry, and resumes the parent with an aggregate handoff. "Terminate and summarize" terminates each pending child session for the run, uses any already delivered structured result, otherwise creates a transcript-based interim summary, marks the child user-completed, clears the parent pending delegation entry, and resumes the parent with the aggregate handoff. Neither action leaves pending child sessions running independently.

Sidebar parent-session summaries show recursive child progress as completed/total. Lightweight session-tree loads must carry child `status` values into the synchronized `session_status` map, because the sidebar does not load full child messages for every row. Child session creation also invalidates the directory session-tree cache so later reloads can refresh descendant totals instead of relying on stale root-loaded markers.

The session title menu exposes "mark as user completed" for unfinished, interrupted, failed, blocked, paused, waiting, timeout, and aborted sessions. The UI label must distinguish this state from natural runtime completion.

The right-side session panel owns Review, Logs, Graph or Protocol, file tree, context, and file tabs. Its tab strip includes a collapse control that closes the whole right panel through `reviewPanel.close()`, allowing the timeline and composer to reclaim the width. The topbar keeps a side-panel toggle next to the file-tree control, so a collapsed panel still has a visible expand entry. Topbar Review and file-tree controls also reopen the panel before selecting their target tab.

## Session Logs

Session status transitions emit `session.status.changed` log records. Each record includes the previous status type, new status type, full previous and new status payloads, and a reason derived from the transition context or status message. The logs panel exposes a Status filter so state-machine changes can be inspected separately from LLM, tool, and protocol activity.

LLM request rows keep the timeline lightweight by showing the provider/model summary, message count, tool count, logged byte count, and a large-payload reference in the list. The expanded detail view still treats logs as inspectable records: when a request log only contains persisted message IDs and summary byte counts, the Messages and User sections expose a full-content action that fetches the corresponding session messages and renders their parts on demand.

The final provider request payload is stored outside the log row under a session-scoped payload id. The Payload section loads it on demand and shows the transformed provider params plus the final active tool list, including native runtime tools such as `ActionResult`. This keeps large system prompts, message arrays, and tool schemas out of the default list render while preserving the exact request evidence needed for request forensics.
