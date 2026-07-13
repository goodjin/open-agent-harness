# Delegation Results Module

## Result and Runtime State

A delegated child has two related but distinct states:

- runtime state, such as `running`, `blocked`, or `completed`,
- delivery state, such as `completed` or `partial`, recorded through `SessionResult` and the parent delegation ledger.

A blocked child may still have a delivered partial fallback. The fallback does not satisfy a verifier gate, does not convert the child runtime state to completed, and must not be presented as successful verification.

## Automatic Fallback Summary

When a terminal child cannot provide a valid `ActionResult`, delegation finalization may generate a transcript-based fallback summary. Failed `ActionResult` tool parts are included as diagnostic evidence so the summary can distinguish no handoff attempt from a rejected handoff.

Diagnostics expose only short protocol fields such as action id, target action id, role, kind, and status. Result bodies and other fields are represented by type and length rather than copied into the summary prompt. Error text and the final transcript remain length-limited.

The canonical result is stored before the slim parent and child projections are updated. The user-turn child projection carries a bounded summary and an explicit fallback flag so historical Timeline rendering does not depend on the full session result payload.

## Timeline Contract

The Timeline keeps runtime status and delivery status separate. A child can therefore show `blocked` while also showing that a fallback partial result was delivered. The fallback summary is visible for operator context, but the UI must not label the verifier as passed or treat the fallback as a satisfying result.

Older history without summary or fallback fields may be enriched from the parent `completed_delegations` projection by child session id.
