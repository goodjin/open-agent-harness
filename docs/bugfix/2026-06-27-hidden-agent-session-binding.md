# Bug Fix Plan: Hidden Agent Session Binding

## Problem

- Date: 2026-06-27
- Severity: Medium
- Affected surface: session composer agent selection, follow-up send path, local model-selection cache

Sessions bound to hidden system agents, especially `summary`, can appear as `default` in the composer. Sending a follow-up then tries to overwrite the session's bound agent from `summary` to `default`, causing a `confirm=true` conflict.

Observed example:

- `ses_0f8fa01e2ffeUunYOKrf0ZFPGU`
- Title: `Fallback summary: f3_sdk_changelog`
- Persisted `session.agent`: `summary`
- Latest user message agent: `summary`
- UI selectable agent list does not include `summary`

## Root Cause

`summary` is intentionally a hidden system agent:

- `packages/opencode/config/agents/summary/meta.json`
- `entry.hidden: true`
- `entry.primary: false`
- `entry.delegable: false`
- `entry.mentionable: false`
- `entry.default: false`

The frontend's normal agent list filters hidden agents:

- `packages/app/src/context/local.tsx` builds `list` from `sync.data.agent.filter(agentVisible)`
- `agentVisible` excludes `entry.hidden === true`

When `scope()?.agent` is `summary`, `pickAgent("summary")` cannot find it in the visible list and falls back to the preferred/default primary agent. The send path then treats that fallback as the selected agent and attempts to bind it to the session before sending.

There is a second reinforcing issue: `saved.session[session]` currently has higher precedence than the durable session binding. If stale local model-selection state records `default`, later message/session sync does not correct it.

## Design Goals

1. Preserve hidden/system agent bindings for existing sessions.
2. Do not expose hidden agents as normal selectable/mentionable/delegable agents.
3. Prevent normal follow-up sends from accidentally overwriting a bound hidden agent.
4. Avoid stale local cache overriding durable `session.agent`.
5. Keep intentional user-driven agent changes possible through the existing confirmation flow.

## Proposed Approach

### 1. Separate "bound current agent" from "selectable agents"

Add a helper in `packages/app/src/context/local.tsx` that resolves the current agent in two stages:

- First, try to resolve `scope()?.agent` against all synced agents, including hidden agents.
- Then fall back to the visible selectable list for new sessions or unbound sessions.

This lets `local.agent.current()` return `summary` for an existing summary-bound session without adding `summary` to the dropdown options.

Expected behavior:

- Existing `summary` session: current agent is `summary`, but selector options still omit `summary`.
- The composer should still show the current hidden agent as the active read-only/locked agent label, so the user can see that the session is running as `summary`.
- Existing visible-agent session: current agent is the visible bound agent.
- New session with no binding: current agent remains the configured/default primary agent.

### 2. Show hidden bound agents without making them selectable

When an existing session is bound to a hidden system agent, the composer should display that bound agent as the current session agent. This is a visibility/status display, not a normal selection affordance.

Display rules:

- Show `summary` (or the agent display name, if available) as the current locked agent label.
- Keep `summary` out of the dropdown option list.
- Keep `summary` out of `@` mention autocomplete and delegation candidates.
- If the user explicitly opens the agent changer, present only visible replacement agents and keep the existing confirmation flow for any replacement.

This preserves the hidden/system boundary while making the session's actual execution identity visible.

### 3. Make send path honor durable binding

In `packages/app/src/components/prompt-input/submit.ts`, for existing sessions, compute the send agent as:

1. `info.agent` when present.
2. Otherwise `currentAgent.name`.

Only attempt `tree2.update({ agent })` when the user has actually selected a different visible agent. A hidden bound agent should not be treated as a mismatch merely because it is not selectable.

This preserves the current confirmation flow for real user-initiated agent changes while removing accidental default overwrites.

### 4. Lower stale cache authority over bound agent

Adjust `scope()` merge behavior so durable session/message agent wins over `saved.session[session].agent` for already-bound sessions. Local cache can still preserve model and variant, but it should not replace a non-empty `session.agent`.

Suggested rule:

- If `bind(info).agent` or latest user message agent exists, use that agent.
- Use `saved.session[session].agent` only when there is no durable agent.
- Keep saved `model` and `variant` as today unless they conflict with explicit session model confirmation rules.

### 5. Avoid persisting fallback agent for hidden-bound sessions

Update `write()` / `model.set()` behavior so a model-only change does not persist `agent: default` when the current session has a durable hidden agent. Model changes should write only the model/variant, or write the durable agent value.

## Files To Change

- `packages/app/src/context/local.tsx`
  - Resolve hidden bound agents separately from visible selectable agents.
  - Adjust cache merge precedence for agent.
  - Avoid writing fallback default over durable hidden agent.

- `packages/app/src/components/prompt-input/submit.ts`
  - For existing sessions, prefer bound `info.agent` as the send agent.
  - Only run agent bind update on explicit user-visible selection changes.

- `packages/app/src/components/prompt-input/submit.test.ts`
  - Add regression coverage for hidden `summary` bound session follow-up.

- Potentially `packages/app/src/context/local.test.tsx` or a new focused helper test
  - Cover current-agent resolution when `scope.agent` is hidden.
  - Cover stale saved default not overriding durable hidden agent.

## Verification Plan

1. Unit test: hidden `summary` bound session resolves current agent as `summary`.
2. Unit/UI helper test: composer displays `summary` as the active locked agent label while omitting it from dropdown options.
3. Unit test: prompt submit on `{ id: "child", agent: "summary" }` does not call `tree2.update({ agent: "default" })`.
4. Unit test: stale saved `{ agent: "default" }` does not override durable `{ agent: "summary" }`.
5. Existing tests: run from `packages/app`:

```bash
bun test src/components/prompt-input/submit.test.ts
```

6. If implementation touches session page rendering, run:

```bash
bun test:e2e:local -- app/smoke.spec.ts
```

## Open Questions

- Should the locked composer label use the raw id `summary` or the display name `Summary Agent`?
- Should session-tree manager allow manually changing hidden-agent sessions, or should it require explicit advanced/system mode?

## Recommendation

Fix this in the frontend binding layer, not by making `summary` visible. `summary` is correctly hidden as a system agent; the bug is that hidden bound agents are not treated as valid current agents for existing sessions.
