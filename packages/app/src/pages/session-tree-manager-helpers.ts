type Draft = {
  title: string
  agent: string
  agentChanged: boolean
  providerID: string
  modelID: string
  modelChanged: boolean
  confirm: boolean
}

export type Conflict = {
  type: "agent" | "model"
  current: string
  next: string
}

export function updateBody(input: Draft) {
  const body: Record<string, unknown> = {}
  if (input.title.trim()) body.title = input.title.trim()
  if (input.agentChanged && input.agent) body.agent = input.agent
  if (input.modelChanged && input.providerID.trim() && input.modelID.trim()) {
    body.model = { providerID: input.providerID.trim(), modelID: input.modelID.trim() }
  }
  if (input.confirm && (body.agent !== undefined || body.model !== undefined)) body.confirm = true
  return body
}

export function parseConflict(text: string): Conflict | undefined {
  try {
    const data = JSON.parse(text) as { data?: { message?: string }; message?: string }
    const msg = data.data?.message ?? data.message ?? text
    const model = /has bound model "([^"]*)".*overwrite it with "([^"]*)"/.exec(msg)
    if (model) return { type: "model", current: model[1] ?? "", next: model[2] ?? "" }
    const agent = /has bound agent "([^"]*)".*overwrite it with "([^"]*)"/.exec(msg)
    if (agent) return { type: "agent", current: agent[1] ?? "", next: agent[2] ?? "" }
    return undefined
  } catch {
    return undefined
  }
}
