import type { AssistantMessage, Message, Session, SessionStatus, UserMessage } from "@open-agent-harness/sdk/v2/client"

export type AgentMeta = {
  schema_version?: string
  agent_version?: string
  contracts?: {
    input?: unknown[]
    output?: unknown[]
  }
  collaboration?: {
    edges?: unknown[]
  }
  runtime_boundary?: {
    resource_classes?: unknown[]
  }
  completion?: {
    required_artifacts?: unknown[]
  }
}

export function short(id?: string) {
  if (!id) return ""
  const parts = id.split("_")
  return parts.at(-1)?.slice(0, 8) || id.slice(0, 8)
}

export function total(msg?: AssistantMessage) {
  if (!msg) return 0
  return msg.tokens.input + msg.tokens.output + msg.tokens.reasoning + msg.tokens.cache.read + msg.tokens.cache.write
}

export function totals(messages: Message[] = []) {
  return messages.reduce(
    (acc, msg) => {
      if (msg.role !== "assistant") return acc
      acc.input += msg.tokens.input
      acc.output += msg.tokens.output
      acc.reasoning += msg.tokens.reasoning
      acc.cache += msg.tokens.cache.read + msg.tokens.cache.write
      acc.cost += msg.cost
      return acc
    },
    { input: 0, output: 0, reasoning: 0, cache: 0, cost: 0 },
  )
}

export function lastUser(messages: Message[] = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "user") return msg
  }
}

export function lastAssistant(messages: Message[] = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "assistant") return msg
  }
}

export function agentName(input: { user?: UserMessage; assistant?: AssistantMessage; fallback?: string }) {
  return input.user?.agent || input.assistant?.agent || input.fallback || "default"
}

export function modelName(input: {
  user?: UserMessage
  assistant?: AssistantMessage
  providers?: {
    id: string
    name?: string
    models: Record<string, { name?: string } | undefined>
  }[]
}) {
  const providerID = input.user?.model.providerID || input.assistant?.providerID
  const modelID = input.user?.model.modelID || input.assistant?.modelID
  if (!providerID || !modelID) return "No model"
  const provider = input.providers?.find((item) => item.id === providerID)
  return provider?.models[modelID]?.name || modelID
}

export function statusName(status?: SessionStatus) {
  if (status?.type === "user_completed") return "用户标记完成"
  return status?.type ?? "idle"
}

export function timeAgo(time?: number, now = Date.now()) {
  if (!time) return ""
  const diff = Math.max(0, now - time)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return "now"
  if (min < 60) return `${min}m ago`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}h ago`
  return `${Math.floor(hour / 24)}d ago`
}

export function metaSummary(meta?: AgentMeta) {
  if (!meta) return []
  const count = (list?: unknown[]) => list?.length ?? 0
  return [
    meta.schema_version ? `schema ${meta.schema_version}` : undefined,
    meta.agent_version ? `agent ${meta.agent_version}` : undefined,
    count(meta.contracts?.input) || count(meta.contracts?.output)
      ? `contracts ${count(meta.contracts?.input)} in / ${count(meta.contracts?.output)} out`
      : undefined,
    count(meta.collaboration?.edges) ? `edges ${count(meta.collaboration?.edges)}` : undefined,
    count(meta.runtime_boundary?.resource_classes) ? `resources ${count(meta.runtime_boundary?.resource_classes)}` : undefined,
    count(meta.completion?.required_artifacts) ? `artifacts ${count(meta.completion?.required_artifacts)}` : undefined,
  ].filter((item): item is string => !!item)
}

export function parentLabel(session?: Pick<Session, "parentID">, parent?: Pick<Session, "title" | "id">) {
  if (!session?.parentID) return ""
  return parent?.title || `Parent ${short(session.parentID)}`
}
