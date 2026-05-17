# Memory System

The memory system stores durable session summaries and selected message chunks in local JSON storage, then retrieves them through the `MemoryAdapter` contract. The default test/runtime adapter is in-memory and has no external Qdrant dependency.

## Records

- `session` records summarize a session.
- `chunk` records store selected text/tool-output chunks below the size policy.
- File, snapshot, patch, and oversized content are excluded from chunks.
- Root sessions default to `project` privacy.
- Subagent sessions default to `session` privacy.

## Retrieval

`POST /memory/search` accepts a query plus optional `sessionID`, `topics`, and `limit`. Results include rank scores and source session ids.

Subagent isolation is enforced before semantic ranking: private child-session memories are only visible inside that child session, while explicitly shared project memories are visible to the parent project scope.
