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

The right-side session panel owns Review, Logs, Graph or Protocol, file tree, context, and file tabs. Its tab strip includes a collapse control that closes the whole right panel through `reviewPanel.close()`, allowing the timeline and composer to reclaim the width. The topbar keeps a side-panel toggle next to the file-tree control, so a collapsed panel still has a visible expand entry. Topbar Review and file-tree controls also reopen the panel before selecting their target tab.

## Session Logs

Session status transitions emit `session.status.changed` log records. Each record includes the previous status type, new status type, full previous and new status payloads, and a reason derived from the transition context or status message. The logs panel exposes a Status filter so state-machine changes can be inspected separately from LLM, tool, and protocol activity.
