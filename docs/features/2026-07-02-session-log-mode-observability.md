# Session Log Mode Observability

## User Goal

The session page should keep the current timeline as the default main view, and add a log mode in the main session area for request forensics. Log mode must make each model request, model response, and tool call easy to inspect, including MCP tool calls.

The detailed content should be split by readable semantic structure instead of stored and rendered as one large JSON blob. System prompts, tool definitions, skills, turns, response text, tool calls, and MCP results should each be independently inspectable.

## Agreed Scope

- Add a main-session view switch between the current timeline view and a log mode.
- Keep logs scoped to a single session. Each session owns its own observation records.
- Use session-local immutable chunks for large structured content.
- Save each request/response as a lightweight manifest that references semantic chunks.
- Reuse the same manifest/chunk data for the main-session log mode and the existing logs panel timeline.
- Show detailed sections with newline-aware text rendering, Markdown rendering, and JSON rendering.
- Include a first-class "Tool calls" log category covering normal runtime tool calls and MCP calls.
- Preserve historical request/response/tool evidence across compaction and pruning.

Out of scope for the first implementation:

- Cross-session chunk deduplication.
- Refcount-based garbage collection.
- Migration of existing v1 payload files into chunk manifests.
- Changing the default conversation timeline into a log-first UI.

## Current Behavior

The main session area renders synchronized `message` and `part` data. It groups assistant output by user turns and uses those parts as the visible conversation history.

The logs panel reads `session_log` rows. Large provider request/response payloads are currently stored under session log payload ids and loaded on demand. The log row stores compact metadata, while the full payload is fetched only when expanded.

Compaction can add summary assistant messages and prune old tool outputs or large protocol transcript text from `part` records. Therefore, message/part data is not a reliable immutable audit source for "what was sent to the provider at that time" or "what the tool returned at that time".

## Proposed Data Model

### Observation Manifest

Each LLM request or response saves one manifest. The manifest is a session-local index, not the full payload.

```json
{
  "id": "payload_...",
  "version": 2,
  "kind": "llm.request",
  "sessionID": "ses_...",
  "time": 123456789,
  "meta": {
    "providerID": "provider",
    "modelID": "model",
    "agent": "default",
    "mode": "build",
    "attempt": 0
  },
  "sections": [
    {
      "id": "system",
      "label": "System Prompt",
      "chunks": ["chunk_sha256_..."]
    },
    {
      "id": "tools",
      "label": "Tools",
      "chunks": ["chunk_sha256_..."]
    },
    {
      "id": "skills",
      "label": "Skills",
      "chunks": ["chunk_sha256_..."]
    },
    {
      "id": "turns",
      "label": "Turns",
      "chunks": ["chunk_sha256_..."]
    },
    {
      "id": "raw",
      "label": "Raw Provider Params",
      "chunks": ["chunk_sha256_..."]
    }
  ]
}
```

Response manifests use the same shape with sections such as `text`, `reasoning`, `tool_calls`, `mcp`, and `raw_events`.

### Observation Chunk

Each chunk is one immutable readable structure. When a structure changes later, a new chunk is written and historical manifests continue to point to the old chunk.

```json
{
  "id": "chunk_sha256_...",
  "sessionID": "ses_...",
  "kind": "system_prompt",
  "format": "markdown",
  "title": "Base system prompt",
  "hash": "sha256...",
  "data": "...",
  "bytes": 12345,
  "time": 123456789
}
```

First-pass chunk kinds:

- `system_prompt`
- `developer_prompt`
- `agent_identity`
- `agent_rules`
- `skill`
- `tool_definition`
- `mcp_tool_definition`
- `turn`
- `message_part`
- `tool_call`
- `tool_result`
- `mcp_tool_call`
- `mcp_result`
- `response_text`
- `response_reasoning`
- `provider_params`
- `provider_raw`

The hash is computed from normalized content. Deduplication is limited to the same session.

### Log Event References

Session log rows stay lightweight and reference manifests or chunks:

```json
{
  "type": "llm.start",
  "refs": [
    {
      "role": "request_manifest",
      "id": "payload_..."
    }
  ]
}
```

Tool log rows may reference tool input and output chunks directly. MCP calls use the same mechanism but get their own kind and label so they are filterable.

## UI Design

### Main Session Area

The main session area gets a view switch:

- `Timeline`: current default conversation timeline.
- `Logs`: session-local log mode.

Timeline mode remains optimized for conversation reading. It continues to render message/part data.

Logs mode is optimized for inspection. It groups records into:

- `Requests`: each provider request, with sections for system prompt, tools, skills, turns, provider params, and raw JSON.
- `Responses`: response text, reasoning, tool-call output, MCP response events, raw stream events, tokens, and finish metadata.
- `Tool calls`: normal tools and MCP tools, with input, result, error, metadata, duration, and linked message/part ids.

### Detail Rendering

Detail sections render by chunk `format`:

- `markdown`: use the existing Markdown renderer.
- `json`: pretty print JSON and preserve line breaks.
- `text`: preserve line breaks and whitespace.
- `raw`: pretty print when parseable, otherwise show text.

Long sections load on demand. The list rows show summaries, byte counts, labels, status, and references without loading all chunks.

### Existing Logs Panel

The existing logs panel should reuse the same section/chunk rendering helpers. It remains useful as a side panel and mobile tab, while the main-session Logs mode provides a wider forensic view.

## Compaction Behavior

Compaction and pruning may change message/part content used for timeline display and future model context. They must not mutate observation chunks.

When pruning removes an old tool result or large protocol transcript from message/part records, the log event and chunk reference remain available. Timeline may show the compacted placeholder, while Logs mode can still load the original tool result or request content from chunks.

Compaction itself should also create log events:

- `compaction.started`
- `compaction.summary.created`
- `compaction.pruned`
- `compaction.finished`

`compaction.pruned` should include affected message/part ids and references to any preserved chunks.

## Affected Modules

- `packages/opencode/src/session/log.ts`
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/compaction.ts`
- `packages/opencode/src/server/routes/session.ts`
- `packages/app/src/pages/session.tsx`
- `packages/app/src/pages/session/message-timeline.tsx`
- `packages/app/src/pages/session/session-log-timeline.tsx`
- `packages/app/src/pages/session/session-log-timeline.test.ts`
- `packages/sdk/js/src/v2/gen/*` after route/schema changes
- `docs/harness-module/ui-console.md`
- `docs/harness-module/protocol-runtime.md` if protocol/MCP logging semantics change

## Implementation Plan

1. Add session-local observation manifest/chunk helpers behind the existing session log payload API.
2. Keep v1 full payload reads compatible.
3. Save provider request payloads as v2 manifests with semantic chunks.
4. Save provider response payloads as v2 manifests with response text, tool-call, MCP, and raw-event chunks.
5. Add tool/MCP call chunk references to tool lifecycle log rows where large input/output exists.
6. Extract reusable log detail section rendering helpers from the current logs panel.
7. Add the main session view switch and Logs mode.
8. Update existing logs panel to read and render v2 manifests/chunks.
9. Add compaction/prune log events that point to preserved chunks.
10. Update module documentation.

## Verification Plan

- Unit tests for manifest/chunk normalization, same-session dedupe, and v1 payload compatibility.
- Unit tests for log detail section grouping: requests, responses, normal tool calls, MCP calls.
- UI tests for the session log mode switch and detail rendering helpers.
- Existing `session-log-timeline.test.ts` coverage updated for v2 manifests.
- Run `bun typecheck` from affected package directories.
- If app UI changes are made, run from `packages/app`: `bun test:e2e:local -- app/smoke.spec.ts`.
