const record = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input)

const parse = (input: string) => {
  try {
    return JSON.parse(input)
  } catch {
    return undefined
  }
}

const unwrap = (input: unknown): unknown => {
  if (!record(input)) return input
  if (typeof input.input === "string") return parse(input.input) ?? input.input
  return input
}

const protocol = (input: unknown) => {
  const value = unwrap(input)
  if (!record(value)) return value
  if (typeof value.kind === "string") return value
  if (record(value.protocol) && typeof value.protocol.kind === "string") return value.protocol
  if (record(value.declaration) && typeof value.declaration.kind === "string") return value.declaration
  return value
}

const shown = (input: unknown) => {
  if (typeof input === "string") return input.trim()
  return JSON.stringify(input ?? {}, null, 2)
}

export function protocolText(input: {
  input?: unknown
  output?: string
  metadata?: Record<string, unknown>
  title?: string
}) {
  const candidates = [
    input.input,
    input.metadata?.input,
    input.metadata?.raw,
    input.metadata?.protocol,
    input.output,
    input.title,
  ]

  const value = candidates
    .map(protocol)
    .find((item) => {
      if (typeof item === "string") return item.trim().length > 0
      if (!record(item)) return false
      return Object.keys(item).length > 0
    })

  if (typeof value === "string") return value.trim()
  return JSON.stringify(value ?? {}, null, 2)
}

export function protocolMeta(input: unknown) {
  const value = protocol(input)
  if (!record(value)) return {}
  const kind = typeof value.kind === "string" && value.kind ? value.kind : undefined
  const calls = Array.isArray(value.calls) ? String(value.calls.length) : undefined
  return { kind, calls }
}

export function invalidProtocol(input: { input?: unknown; metadata?: Record<string, unknown>; output?: string }) {
  if (!record(input.input)) return undefined
  if (input.input.tool !== "AgentProtocolOutput") return undefined
  const raw = [input.input.raw, input.metadata?.raw]
    .find((item): item is string => typeof item === "string" && item.trim().length > 0)
    ?.trim()
  if (raw) return { type: "解析输出失败", output: raw }
  const marker = "Raw protocol output:"
  const text = typeof input.output === "string" ? input.output : ""
  const idx = text.indexOf(marker)
  const output = idx >= 0 ? text.slice(idx + marker.length).trim() : ""
  return { type: "解析输出失败", output }
}

export function actionResult(input: { tool?: string; input?: unknown; metadata?: Record<string, unknown> }) {
  if (input.tool !== "ActionResult") return undefined
  const raw = input.metadata?.rawInput
  return {
    type: "解析结果失败",
    output: typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : shown(input.input),
  }
}
