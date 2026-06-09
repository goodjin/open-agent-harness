export type AgentConcurrencyConfig = {
  concurrency?: number
}

type Row = {
  action_id?: string
  agent?: string
}

export namespace AgentConcurrency {
  export function limit(input: { agent: string; kind?: string; cfg?: AgentConcurrencyConfig }) {
    if (input.cfg?.concurrency) return Math.max(1, input.cfg.concurrency)
    if (input.agent === "feature-planner") return 2
    if (input.kind === "planner") return 1
    if (input.kind === "worker") return 3
    return
  }

  export function running(agent: string, pending: readonly Row[]) {
    return pending.filter((item) => item.agent === agent).length
  }

  export function block(input: {
    action: string
    agent: string
    kind?: string
    depends: readonly string[]
    completed: ReadonlySet<string>
    done: readonly Row[]
    pending: readonly Row[]
    running: number
    cfg?: AgentConcurrencyConfig
  }) {
    const done = new Set([
      ...input.completed,
      ...input.done.map((item) => item.action_id).filter((item): item is string => !!item),
    ])
    const pending = new Set(input.pending.map((item) => item.action_id).filter((item): item is string => !!item))
    const missing = input.depends.filter((id) => !done.has(id) || pending.has(id))
    if (missing.length > 0) {
      return {
        reason: "agent_dependency_pending" as const,
        limit: 0,
        running: input.running,
        missing,
        message: [
          `Agent action ${input.action} is waiting for dependency action(s): ${missing.join(", ")}.`,
          "The runtime did not start this agent yet.",
        ].join("\n"),
      }
    }
    const limit = AgentConcurrency.limit(input)
    if (!limit) return
    if (input.running < limit) return
    return {
      reason: "agent_concurrency_limit" as const,
      limit,
      running: input.running,
      missing: [],
      message: [
        `Agent action ${input.action} was not started because ${input.agent} already has ${input.running} running task(s) in this project.`,
        `Configured agent concurrency limit: ${limit}.`,
        "The runtime will continue when a running result returns and the parent session declares the next runnable package.",
      ].join("\n"),
    }
  }
}
