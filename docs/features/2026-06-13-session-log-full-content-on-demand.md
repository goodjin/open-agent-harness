# Session Log Full Content On Demand

## User Goal

Session logs should show complete content when needed. The log list can stay compact, but clicking a log detail control should load the corresponding full content instead of showing empty request sections.

## Scope

- Keep the session log list lightweight.
- Preserve existing log rows and compact summaries.
- For LLM request details, load full referenced message content on demand from the message API.
- Use existing persisted message parts as the source of truth for large prompt/tool content.
- Show loading and error states inside the detail panel.

## Implementation Plan

1. Add a detail loader state to the session log timeline.
2. Detect LLM request detail sections that reference a user message id or assistant message id.
3. Fetch those messages only when the user opens the relevant detail section.
4. Render full message parts, including text, tool inputs, outputs, and errors.
5. Keep raw log data visible for debugging.

## Verification Plan

- Update session log timeline tests for on-demand full content sections.
- Run package app tests and typecheck.
- Run the app smoke test because this changes session-side UI behavior.
