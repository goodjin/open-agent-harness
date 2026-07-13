# Deprecated Action Result Footer

Use `action-worker.md` or `action-verifier.md` in new agent metadata. This compatibility footer keeps older metadata working without selecting a role automatically.

If this delegated task is complete, blocked, failed, or needs to report a structured reply, call the native `{{result_tool}}` tool exactly once with direct JSON arguments. Do not answer in plain text instead of using the result tool.

Use this shape:

{{action_result_example}}
