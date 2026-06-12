# Protocol Invalid Raw Output

## User Goal

When a protocol runner emits a malformed `AgentProtocolOutput` package, the session should show the raw protocol output that failed parsing. This lets the operator see the exact malformed fragment and refine the protocol instructions.

## Agreed Scope

- Cover malformed native `AgentProtocolOutput` tool-call arguments handled by the LLM invalid tool sink.
- Preserve the existing protocol retry behavior.
- Add the raw protocol fragment to the invalid tool result output and metadata for UI details and copy actions.
- Log the streamed tool-call arguments before provider parsing or repair replaces the call with the internal `invalid` tool.

## Implementation Plan

- Extract the parser `Text:` fragment from the malformed tool-call error when available.
- Include that fragment in the `Invalid Protocol Tool Call` output under a clear raw section.
- Store the same fragment in tool metadata.
- Accumulate `tool-input-delta` events on the pending tool part and log the bounded raw input at `tool.input.end` and `tool.start`.
- Add a focused regression test for malformed `AgentProtocolOutput` arguments.
- Add a processor regression test that verifies raw streamed arguments are logged beside the repaired `invalid` call.

## Affected Modules

- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/test/session/llm.test.ts`
- `packages/opencode/test/session/session.test.ts`
- `docs/harness-module/protocol-runtime.md`

## Verification Plan

- Run the focused LLM invalid-output test from `packages/opencode`.
- Run the focused session processor raw-input logging test from `packages/opencode`.
- Run `bun typecheck` from `packages/opencode` if the focused test passes.
