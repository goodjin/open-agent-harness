import type { Agent } from "@open-agent-harness/sdk/v2"

type Entry = {
  mode?: Agent["mode"]
  hidden?: boolean
  entry?: Agent["entry"]
}

type Label = {
  name: string
  displayName?: string
  identityName?: string
  personaName?: string
  identity_name?: string
  persona_name?: string
}

const defaults: Record<string, string> = {
  ask: "var(--icon-agent-ask-base)",
  build: "var(--icon-agent-build-base)",
  docs: "var(--icon-agent-docs-base)",
  plan: "var(--icon-agent-plan-base)",
}

export function agentHidden(item: Entry) {
  return item.entry?.hidden === true || item.hidden === true
}

export function agentPrimary(item: Entry) {
  return (item.entry?.primary ?? item.mode !== "subagent") && !agentHidden(item)
}

export function agentVisible(item: Entry) {
  return !agentHidden(item)
}

export function agentMentionable(item: Entry) {
  return (item.entry?.mentionable ?? item.mode !== "primary") && !agentHidden(item)
}

export function agentDelegable(item: Entry) {
  return (item.entry?.delegable ?? item.mode !== "primary") && !agentHidden(item)
}

export function agentColor(name: string, custom?: string) {
  if (custom) return custom
  return defaults[name] ?? defaults[name.toLowerCase()]
}

export function agentLabel(agent: Label | undefined) {
  if (!agent) return undefined
  const identity = agent.identityName ?? agent.identity_name
  const persona = agent.personaName ?? agent.persona_name
  if (identity && persona) return `${identity}-${persona}`
  return agent.displayName ?? agent.name
}

export function agentLabelByName(name: string | undefined, agents: readonly Label[]) {
  if (!name) return undefined
  return agentLabel(agents.find((agent) => agent.name === name)) ?? name
}

export function messageAgentColor(
  list: readonly { role: string; agent?: string }[] | undefined,
  agents: readonly { name: string; color?: string }[],
) {
  if (!list) return undefined
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i]
    if (item.role !== "user" || !item.agent) continue
    return agentColor(item.agent, agents.find((agent) => agent.name === item.agent)?.color)
  }
}
