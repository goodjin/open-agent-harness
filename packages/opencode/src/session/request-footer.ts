import { ActionResult } from "./action-result"

export namespace RequestFooter {
  type Vars = Record<string, string | undefined>

  export function render(prompt: string, vars: Vars) {
    return prompt.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => vars[key] ?? "")
  }

  export function variables(input: {
    actionResult?: {
      action?: string
      target?: string
      verifier?: boolean
    }
    sessionID: string
    agent: string
    mode: string
    delegation?: Record<string, unknown>
  }) {
    const action = input.actionResult?.action ?? text(input.delegation?.action_id)
    const tool = text(input.delegation?.result_tool)
    const target = input.actionResult?.verifier ? input.actionResult.target ?? targetAction(input.delegation) : undefined
    return {
      session_id: input.sessionID,
      agent: input.agent,
      mode: input.mode,
      action_id: action,
      target_action_id: target,
      result_tool: tool,
      action_result_example: example(action, target),
    }
  }

  function example(action: string | undefined, target: string | undefined) {
    if (target) return JSON.stringify(ActionResult.sample({ verifier: true, action, target }), null, 2)
    return JSON.stringify(ActionResult.sample({ action }), null, 2)
  }

  function targetAction(input: Record<string, unknown> | undefined) {
    const meta = object(input?.metadata)
    const verification = object(meta.verification)
    const worker = text(verification.worker)
    if (worker) return worker
    const deps = input?.depends_on
    const dep = Array.isArray(deps) ? deps.map(text).find((item): item is string => Boolean(item)) : undefined
    if (dep) return dep
    return infer(text(input?.action_id))
  }

  function object(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) return {}
    return input as Record<string, unknown>
  }

  function text(input: unknown) {
    return typeof input === "string" && input.trim() ? input.trim() : undefined
  }

  function infer(input: string | undefined) {
    if (!input) return
    for (const suffix of ["_test", "_review"]) {
      if (input.endsWith(suffix)) return input.slice(0, -suffix.length)
    }
  }
}
