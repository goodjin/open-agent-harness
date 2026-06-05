# v2 Context Compiler

M3 builds the Context Bundle that model sessions consume. It compiles user input, current Projection summaries, Resource refs, Handoff refs, Memory refs, and Agent Session hints into a bounded record that can be previewed before it is sent to a model.

## Context Bundle

`ContextBundle` stores:

- `id`, `run_id`, optional `assignment_id`
- `goal` and `user_input`
- included records with `ref`, expansion `mode`, `summary`, `content`, `visibility`, `reason`, and token estimate
- excluded records with `ref`, requested `mode`, `visibility`, and reason
- all input `refs`
- `summary`, `token_budget`, `tokens_used`, `visibility`, `created_at`

## Expansion Modes

- `summary`: include only the record summary.
- `structured`: include metadata and evidence refs.
- `full`: include full body when visibility and budget allow it.
- `adaptive`: try full body, then downgrade to summary, then exclude if budget still fails.
- `on_demand`: exclude from the initial bundle and explain that it can be fetched later.
- `on_failure`: exclude from the initial bundle and reserve it for recovery/debug context.

## Downgrades

The compiler can exclude or downgrade records for:

- visibility mismatch
- token budget pressure
- deferred expansion mode
- unsupported future ref storage

Preview output mirrors the bundle and adds explanations so UI, Agent Session, Handoff, and Memory callers can show why a record entered context or stayed out.
