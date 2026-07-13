# Deprecated Agent Protocol DSL v2

Use `planner-protocol.md` for new planner and coordinator agents.

This file remains only as a compatibility name for older agent metadata. The current protocol split is:

- `planner-protocol.md`: for `runner: "protocol"` planner/coordinator agents that call `AgentProtocolOutput`.
- `action-worker.md`: for delegated worker/helper agents that call `ActionResult` through their request footer.
- `action-verifier.md`: for delegated verifier agents that call `ActionResult` through their request footer.

Do not mix the two protocols in one agent prompt.
