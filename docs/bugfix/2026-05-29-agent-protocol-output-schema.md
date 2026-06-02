# Bug Fix: DeepSeek Rejected AgentProtocolOutput Schema

## Problem

- Date: 2026-05-29
- Severity: High
- Scope: standalone `open-agent-harness web` on port `4196`

The standalone package appeared to keep asking `default` to call `todoWrite`. After several attempts the UI reported that the tool did not exist or stayed in the same failure loop.

## Root Cause

The visible `todowrite` messages came from conversation history and tool registry logs. The current failing request was blocked earlier by the provider.

The provider error was:

```text
Error from provider (DeepSeek): Invalid schema for function 'AgentProtocolOutput': schema must be a JSON Schema of 'type: "object"', got 'type: null'.
```

`AgentProtocolOutput` used `z.toJSONSchema(AgentProtocol.Structured)`, which produced a top-level `anyOf` schema. DeepSeek rejected that tool schema before generating a response, so the runtime never reached the normal protocol output path.

## Fix

- `packages/opencode/src/protocol/schema.ts` now exposes `AgentProtocol.OutputSchema`, a top-level JSON Schema object for `{ kind, message, calls }`.
- `packages/opencode/src/session/llm.ts` now uses that object schema for the native `AgentProtocolOutput` tool.

## Verification

1. `bun typecheck` in `packages/opencode`
2. `bun run script/build.ts --single --skip-install` in `packages/opencode`
3. Copied the package to `/Users/jin/bin`
4. Re-signed `/Users/jin/bin/open-agent-harness` with ad-hoc codesigning
5. Restarted `fun.agentlab.open-agent-harness.4196`
6. Verified health:

```text
GET http://127.0.0.1:4196/global/health
{"healthy":true,"version":"0.0.0-dev-202605290353"}
```

7. Sent a smoke prompt to `default`; it called only `AgentProtocolOutput`:

```json
{
  "kind": "answer",
  "message": "ok"
}
```

The latest 4196 log has no `Invalid schema`, `Error from provider`, or `todowrite` tool-call failure for that smoke session.
