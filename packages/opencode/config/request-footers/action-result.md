# Deprecated Action Result Footer

Use `action-protocol.md` for new worker and verifier agent metadata. This compatibility footer keeps older metadata working.

If this delegated task is complete, blocked, failed, or needs to report a structured reply, call the native `{{result_tool}}` tool exactly once with direct JSON arguments. Do not answer in plain text instead of using the result tool.

Use this shape:

{{action_result_example}}
