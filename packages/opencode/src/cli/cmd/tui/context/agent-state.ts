import type { Agent } from "@open-agent-harness/sdk/v2"
import { AgentEntry } from "@/agent/entry"

export type LocalAgentItem = {
  name: string
  description: string
  mode: "all" | "primary" | "subagent"
  native: boolean
  hidden: boolean
  permission: Agent["permission"]
  color: string | undefined
  model: { providerID: string; modelID: string } | undefined
}

export namespace LocalAgent {
  export function list(input: readonly Agent[]): LocalAgentItem[] {
    return input
      .filter((item) => AgentEntry.primary(item))
      .map((item) => ({
        name: item.name,
        description: item.description ?? "",
        mode: item.mode,
        native: item.native ?? false,
        hidden: item.hidden ?? false,
        permission: item.permission,
        color: item.color,
        model: item.model,
      }))
  }

  export function pick(input: { list: readonly LocalAgentItem[]; config?: string; current?: string }) {
    if (input.current && input.list.some((item) => item.name === input.current)) return input.current
    if (input.config && input.list.some((item) => item.name === input.config)) return input.config
    if (input.list.some((item) => item.name === "default")) return "default"
    return input.list[0]?.name ?? "default"
  }

  export function fallback(input: readonly LocalAgentItem[]): LocalAgentItem[] {
    if (input.length > 0) return [...input]
    return [
      {
        name: "default",
        description: "Default agent",
        mode: "all",
        native: false,
        hidden: false,
        permission: [],
        color: undefined,
        model: undefined,
      },
    ]
  }
}
