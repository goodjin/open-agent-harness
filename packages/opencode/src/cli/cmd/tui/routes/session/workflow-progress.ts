export namespace WorkflowProgress {
  type State = {
    workflowName?: unknown
    status?: unknown
    current?: unknown
    step?: unknown
    total?: unknown
    pause?: {
      reason?: unknown
    }
  }

  export function label(context: Record<string, unknown> | undefined) {
    const state = context?.workflow as State | undefined
    if (!state || typeof state.workflowName !== "string") return
    if (typeof state.current !== "string") return
    if (typeof state.step !== "number") return
    if (typeof state.total !== "number") return

    const base = `${state.workflowName} ${state.step + 1}/${state.total}: ${state.current}`
    if (state.status === "waiting_user" || state.status === "waiting_permission") {
      const reason = typeof state.pause?.reason === "string" ? state.pause.reason : state.status
      return `${base} (${reason})`
    }
    return base
  }
}
