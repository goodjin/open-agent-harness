import { Identifier } from "@/id/id"
import { AgentProtocol } from "./schema"

export namespace AgentProtocolExecutor {
  export type ToolResult = {
    title: string
    output: string
    metadata: Record<string, unknown>
  }

  export type Agent = {
    id: string
    name?: string
    entry?: {
      hidden?: boolean
      delegable?: boolean
    }
    capability?: {
      purpose?: string
      tags?: string[]
      writes?: boolean
    }
  }

  export type Input = {
    declaration: AgentProtocol.Declaration
    sections?: Record<string, string>
    execute?: (action: AgentProtocol.Action, prompt: string | undefined) => Promise<ToolResult | undefined>
    agents?: Agent[]
    runID?: string
  }

  export async function run(input: Input): Promise<AgentProtocol.Result> {
    const started = Date.now()
    const runID = input.runID ?? Identifier.ascending("log").replace(/^log_/, "apr_")
    const done: AgentProtocol.ResultAction[] = []

    const actions = input.declaration.payload.type === "action_graph" ? input.declaration.payload.actions : []
    const refs = new Set(actions.map((item) => item.id))
    const ok = new Set<string>()
    const wait = new Set<string>()
    const queue = [...actions]
    while (queue.length > 0) {
      const index = queue.findIndex((item) => item.depends_on.every((dep) => !refs.has(dep) || ok.has(dep)))
      const item = index >= 0 ? queue.splice(index, 1)[0] : undefined
      if (!item) {
        const start = Date.now()
        const end = Date.now()
        done.push(
          ...queue.splice(0).map((stuck) => {
            const wait = stuck.depends_on.filter((dep) => refs.has(dep) && !ok.has(dep))
            return {
              id: stuck.id,
              title: stuck.title,
              operation: stuck.operation,
              executor: stuck.executor,
              input: stuck.input,
              depends_on: stuck.depends_on,
              verification: stuck.verification,
              status: "blocked" as const,
              summary: `Action '${stuck.id}' is waiting for unfinished dependencies: ${wait.join(", ")}`,
              error: `Action '${stuck.id}' is waiting for unfinished dependencies: ${wait.join(", ")}`,
              tool_call_ids: [],
              duration_ms: end - start,
              time: {
                started: start,
                completed: end,
              },
            }
          }),
        )
        break
      }
      if (wait.size > 0 && item.executor.type === "human") {
        queue.unshift(item)
        const start = Date.now()
        const end = Date.now()
        done.push(
          ...queue.splice(0).map((stuck) => ({
            id: stuck.id,
            title: stuck.title,
            operation: stuck.operation,
            executor: stuck.executor,
            input: stuck.input,
            depends_on: stuck.depends_on,
            verification: stuck.verification,
            status: "blocked" as const,
            summary: `Action '${stuck.id}' is waiting for delegated actions: ${Array.from(wait).join(", ")}`,
            error: `Action '${stuck.id}' is waiting for delegated actions: ${Array.from(wait).join(", ")}`,
            tool_call_ids: [],
            duration_ms: end - start,
            time: {
              started: start,
              completed: end,
            },
          })),
        )
        break
      }
      const start = Date.now()
      const prompt = item.prompt_ref?.startsWith("md:") ? input.sections?.[item.prompt_ref.slice(3)] : undefined
      const result = (await input.execute?.(item, prompt)) ?? defaults(item, prompt, input.agents ?? [])
      const failed = result.metadata.failed === true
      const stop = result.metadata.blocked === true
      const delegated = result.metadata.delegated === true
      const skipped = result.metadata.skipped === true
      const end = Date.now()
      done.push({
        id: item.id,
        title: item.title,
        operation: item.operation,
        executor: item.executor,
        input: item.input,
        depends_on: item.depends_on,
        verification: item.verification,
        status: stop || delegated ? "blocked" : failed ? "failed" : skipped ? "skipped" : "completed",
        summary: result.output,
        output: stop || failed ? undefined : result.output,
        error: stop || failed ? result.output : undefined,
        sessionID: session(result.metadata),
        tool_call_ids: ids(result.metadata),
        duration_ms: end - start,
        time: {
          started: start,
          completed: end,
        },
      })
      if (stop) break
      if (delegated) wait.add(item.id)
      if (!delegated && !failed) ok.add(item.id)
    }

    const status = done.some((item) => item.status === "failed")
      ? "failed"
      : done.some((item) => item.status === "blocked")
        ? "blocked"
        : "completed"
    const raw = done.reduce((sum, item) => sum + (item.output ?? item.error ?? item.summary).length, 0)
    const summary = done.map((item) => `${item.title}: ${item.status}`).join("\n")
    const end = Date.now()
    return {
      type: "agent.protocol.result",
      version: "1",
      run_id: runID,
      status,
      title: input.declaration.title,
      actions: done,
      summary,
      time: {
        started,
        completed: end,
      },
      metrics: {
        actions: done.length,
        internal_tool_calls: done.reduce((sum, item) => sum + item.tool_call_ids.length, 0),
        direct_model_tool_calls: 0,
        model_visible_bytes: summary.length,
        raw_output_bytes: raw,
        duration_ms: end - started,
      },
    }
  }

  export function select(action: AgentProtocol.Action, agents: Agent[]) {
    if (action.executor.type !== "agent") return
    if (action.executor.target !== "auto") {
      return agents.find((agent) => agent.id === action.executor.target && visible(agent))
    }
    const wants = new Set(action.executor.capabilities)
    return agents
      .filter(visible)
      .map((agent) => ({
        agent,
        score:
          (agent.capability?.purpose === action.operation ? 3 : 0) +
          (agent.capability?.purpose && wants.has(agent.capability.purpose) ? 3 : 0) +
          (agent.capability?.tags ?? []).filter((tag) => wants.has(tag)).length,
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.agent
  }

  function visible(agent: Agent) {
    return agent.entry?.delegable !== false && agent.entry?.hidden !== true
  }

  function defaults(action: AgentProtocol.Action, prompt: string | undefined, agents: Agent[]): ToolResult {
    const agent = select(action, agents)
    if (action.executor.type === "agent" && !agent) {
      return {
        title: action.title,
        output: `No delegable agent matched '${action.operation}'.`,
        metadata: { blocked: true },
      }
    }
    if (action.executor.type === "agent") {
      return {
        title: action.title,
        output: prompt ? `agent:${agent?.id}: ${prompt}` : `agent:${agent?.id}: ${action.title}`,
        metadata: { agentID: agent?.id },
      }
    }
    return {
      title: action.title,
      output: prompt ? `${action.operation}: ${prompt}` : `${action.operation}: ${action.title}`,
      metadata: { callID: `call_${action.id}` },
    }
  }

  function ids(input: Record<string, unknown>) {
    const id = typeof input.callID === "string" ? input.callID : undefined
    const ids = Array.isArray(input.toolCallIDs) ? input.toolCallIDs.filter((item) => typeof item === "string") : []
    return id ? [id, ...ids] : ids
  }

  function session(input: Record<string, unknown>) {
    const id = input.childSessionID
    if (typeof id === "string" && id.length > 0) return id
    return undefined
  }
}
