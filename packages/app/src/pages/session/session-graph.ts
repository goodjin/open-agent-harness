type Status = "ready" | "pending" | "running" | "completed" | "failed" | "skipped" | "cancelled"

type Log = {
  id: string
  sessionID?: string
  messageID?: string
  level?: string
  type: string
  data: Record<string, unknown>
  time: number
}

export type GraphVerification = {
  role?: "test" | "review"
  worker?: string
  required?: boolean
  reason?: string
  system?: boolean
}

export type GraphNode = {
  id: string
  title: string
  type: string
  status: Status
  deps: string[]
  after: string[]
  executor: string
  verification?: GraphVerification
  sessionID?: string
  attempt?: number
  output?: string
  error?: string
  time?: {
    started?: number
    updated?: number
    completed?: number
  }
  raw?: unknown
}

export type GraphNodeLayout = GraphNode & {
  rank: number
  row: number
  x: number
  y: number
  width: number
  height: number
}

export type GraphEdgeLayout = {
  from: string
  to: string
  x1: number
  y1: number
  x2: number
  y2: number
}

export type GraphLayout = {
  nodes: GraphNodeLayout[]
  edges: GraphEdgeLayout[]
  width: number
  height: number
}

export type GraphRun = {
  id: string
  title: string
  source: "workflow" | "protocol"
  status: Status | "blocked"
  total: number
  completed: number
  nodes: GraphNode[]
  error?: string
  pause?: {
    type: string
    step: string
    reason?: string
  }
  variables?: Record<string, unknown>
  metadata?: Record<string, unknown>
  declaration?: unknown
  items?: unknown[]
  raw?: string
  time?: {
    started?: number
    updated?: number
    completed?: number
  }
}

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function list(input: unknown) {
  if (!Array.isArray(input)) return []
  return input.filter((item): item is string => typeof item === "string")
}

function str(input: unknown, fallback = "") {
  return typeof input === "string" ? input : fallback
}

function num(input: unknown, fallback = 0) {
  return typeof input === "number" ? input : fallback
}

function dict(input: unknown) {
  if (!record(input)) return {}
  return input
}

function verify(input: unknown): GraphVerification | undefined {
  const data = dict(input)
  const role = data.role === "test" || data.role === "review" ? data.role : undefined
  const worker = str(data.worker) || undefined
  const reason = str(data.reason) || undefined
  if (!role && !worker && !reason) return
  return {
    role,
    worker,
    required: typeof data.required === "boolean" ? data.required : undefined,
    reason,
    system: typeof data.system === "boolean" ? data.system : undefined,
  }
}

function unique(input: string[]) {
  return [...new Set(input)]
}

function parse(input: unknown) {
  if (typeof input !== "string") return
  try {
    return JSON.parse(input)
  } catch {
    return
  }
}

function state(input: unknown): Status | "blocked" {
  if (input === "active") return "running"
  if (input === "error") return "failed"
  if (
    input === "ready" ||
    input === "pending" ||
    input === "running" ||
    input === "completed" ||
    input === "failed" ||
    input === "skipped" ||
    input === "cancelled" ||
    input === "blocked"
  )
    return input
  return "pending"
}

function current(input: unknown) {
  const item = dict(input)
  const data = dict(item.workflow)
  if (!str(data.runID)) return
  if (!str(data.workflowID)) return
  return data
}

function workflows(input: unknown) {
  const data = dict(input)
  const runs = Array.isArray(data.workflows) ? data.workflows : []
  return [...runs, current(input)]
    .filter(record)
    .filter((item) => str(item.runID) && str(item.workflowID) && str(item.workflowName))
    .filter((item, index, all) => all.findIndex((run) => str(run.runID) === str(item.runID)) === index)
}

function status(input: unknown): Status {
  const out = state(input)
  return out === "blocked" ? "failed" : out
}

function step(input: Record<string, unknown>, runs: Record<string, unknown>): GraphNode {
  const id = str(input.id)
  const run = dict(runs[id])
  const deps = unique([...list(input.depends_on), ...list(run.depends_on)])
  return {
    id,
    title: str(input.description, id),
    type: str(input.type, "task"),
    status: status(run.status ?? input.status),
    deps,
    after: [],
    executor: str(run.agent ?? input.agent, "auto"),
    sessionID: str(run.sessionID) || undefined,
    attempt: typeof run.attempt === "number" ? run.attempt : undefined,
    output: str(run.output) || undefined,
    error: str(run.error) || undefined,
    time: dict(run.time) as GraphNode["time"],
    raw: input,
  }
}

function wnodes(run: Record<string, unknown>) {
  const nodes = run.nodes
  const map = record(nodes) && !Array.isArray(nodes) ? nodes : {}
  const source = Array.isArray(run.steps) ? run.steps : Array.isArray(nodes) ? nodes : []
  const base = source.filter(record).map((item) => step(item, map))
  const seen = new Set(base.map((item) => item.id))
  const extra = unique([...Object.keys(map), ...Object.keys(dict(run.statuses))])
    .filter((id) => !seen.has(id))
    .map((id) => step({ id }, map))
  const all = [...base, ...extra].map((node) => ({
    ...node,
    status: status(dict(run.statuses)[node.id] ?? node.status),
  }))
  const out = new Map<string, string[]>()
  for (const node of all) for (const dep of node.deps) out.set(dep, unique([...(out.get(dep) ?? []), node.id]))
  return all.map((node) => ({ ...node, after: out.get(node.id) ?? [] }))
}

function workflow(run: Record<string, unknown>): GraphRun {
  const nodes = wnodes(run)
  return {
    id: str(run.runID),
    title: str(run.workflowName, str(run.workflowID, "Workflow run")),
    source: "workflow",
    status: state(run.status),
    total: Math.max(num(run.total, nodes.length), nodes.length),
    completed: nodes.filter((node) => node.status === "completed").length,
    nodes,
    error: str(run.error) || undefined,
    pause: record(run.pause) ? (run.pause as GraphRun["pause"]) : undefined,
    variables: record(run.variables) ? run.variables : undefined,
    metadata: {
      workflowID: str(run.workflowID),
      workflowName: str(run.workflowName),
    },
    time: record(run.time) ? (run.time as GraphRun["time"]) : undefined,
  }
}

function protocols(input: unknown) {
  const data = dict(dict(input).protocol)
  const runs = Array.isArray(data.runs) ? data.runs : []
  return runs.filter(record).filter((run) => str(run.runID) && str(run.title) && Array.isArray(run.actions))
}

function rawitems(input: unknown, declaration: unknown) {
  const data = dict(input)
  if (Array.isArray(data.items)) return data.items
  if (Array.isArray(data.calls)) return data.calls
  const payload = dict(dict(declaration).payload)
  if (Array.isArray(payload.actions)) return payload.actions
  if (payload.type === "message") {
    const decl = dict(declaration)
    return [
      {
        id: "response",
        kind: str(decl.outcome, str(decl.intent, "message")),
        title: str(decl.title, str(decl.intent, "Response")),
        message: str(decl.message),
        depends: [],
      },
    ]
  }
  return []
}

function item(input: unknown): GraphNode {
  const data = dict(input)
  const exec = dict(data.executor)
  const kind = str(data.kind, str(data.operation, str(data.type, "item")))
  const target = str(data.target) || str(data.name) || str(data.tool) || str(exec.target)
  return {
    id: str(data.id, target || kind),
    title: str(data.title, str(data.id, target || kind)),
    type: kind,
    status: status(data.status),
    deps: unique([...list(data.depends), ...list(data.depends_on), ...list(data.after)]),
    after: [],
    executor: exec.type ? `${str(exec.type, "runtime")}:${str(exec.target, "auto")}` : target ? `${kind}:${target}` : kind,
    verification: verify(data.verification),
    output: str(data.summary) || str(data.message) || undefined,
    error: str(data.error) || undefined,
    time: record(data.time) ? (data.time as GraphNode["time"]) : undefined,
    raw: input,
  }
}

function logstatus(type: string): Status | "blocked" | undefined {
  if (type === "protocol.action.completed") return "completed"
  if (type === "protocol.action.failed") return "failed"
  if (type === "protocol.action.blocked") return "blocked"
  if (type === "protocol.action.skipped") return "skipped"
}

function logruns(input: Log[]): GraphRun[] {
  const map = new Map<string, Log[]>()
  for (const log of input) {
    if (!log.type.startsWith("protocol.")) continue
    const id = str(log.data.runID)
    if (!id) continue
    map.set(id, [...(map.get(id) ?? []), log])
  }
  return [...map.entries()]
    .flatMap(([id, rows]) => {
      const sorted = rows.slice().sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
      const valid = sorted.find((row) => row.type === "protocol.validated")
      if (!valid) return []
      const done = sorted.find((row) => row.type === "protocol.completed" || row.type === "protocol.failed")
      const declaration = valid.data.declaration
      const raw = str(valid.data.raw) || undefined
      const items = rawitems(parse(raw), declaration)
      const by = new Map(
        sorted.flatMap((row) => {
          const action = str(row.data.actionID)
          return action ? [[action, row] as const] : []
        }),
      )
      const nodes = items.map(item).map((node) => {
        const row = by.get(node.id)
        const value = row ? logstatus(row.type) ?? state(row.data.status) : node.status
        const exec = dict(row?.data.executor)
        return {
          ...node,
          status: value === "blocked" ? "failed" : value,
          executor: exec.type ? `${str(exec.type, "runtime")}:${str(exec.target, "auto")}` : node.executor,
          verification: verify(row?.data.verification) ?? node.verification,
          time: node.time ?? (record(row?.data.time) ? (row?.data.time as GraphNode["time"]) : undefined),
        }
      })
      const out = new Map<string, string[]>()
      for (const node of nodes) for (const dep of node.deps) out.set(dep, unique([...(out.get(dep) ?? []), node.id]))
      const all = nodes.map((node) => ({ ...node, after: out.get(node.id) ?? [] }))
      const result = dict(done?.data.result)
      const run = {
        id,
        title: str(dict(declaration).title, str(result.title, "AgentProtocolOutput")),
        source: "protocol" as const,
        status: done?.type === "protocol.failed" ? "failed" : done ? state(result.status ?? "completed") : "running",
        total: all.length,
        completed: all.filter((node) => node.status === "completed").length,
        nodes: all,
        declaration,
        items,
        raw,
        metadata: {
          recovered: valid.data.recovered,
          messageID: valid.messageID,
          logID: valid.id,
          metrics: dict(done?.data.metrics),
        },
        time: {
          started: valid.time,
          updated: sorted.at(-1)?.time,
          completed: done?.time,
        },
      } satisfies GraphRun
      return [run]
    })
}

function action(input: Record<string, unknown>): GraphNode {
  const exec = dict(input.executor)
  return {
    id: str(input.id),
    title: str(input.title, str(input.id)),
    type: str(input.operation, "action"),
    status: status(input.status),
    deps: list(input.depends_on),
    after: [],
    executor: `${str(exec.type, "runtime")}:${str(exec.target, "auto")}`,
    verification: verify(input.verification),
    sessionID: str(input.sessionID) || child(input),
    output: str(input.summary) || undefined,
    error: str(input.error) || undefined,
    time: record(input.time) ? (input.time as GraphNode["time"]) : undefined,
    raw: input,
  }
}

function child(input: Record<string, unknown>) {
  const text = `${str(input.summary)}\n${str(input.output)}`
  const match = text.match(/\bChild session:\s*(ses_[A-Za-z0-9]+)/)
  return match?.[1]
}

function protocol(run: Record<string, unknown>): GraphRun {
  const nodes = (Array.isArray(run.actions) ? run.actions : []).filter(record).map(action)
  const out = new Map<string, string[]>()
  for (const node of nodes) for (const dep of node.deps) out.set(dep, unique([...(out.get(dep) ?? []), node.id]))
  return {
    id: str(run.runID),
    title: str(run.title, "Protocol run"),
    source: "protocol",
    status: state(run.status),
    total: num(run.total, nodes.length),
    completed: num(run.completed, nodes.filter((node) => node.status === "completed").length),
    nodes: nodes.map((node) => ({ ...node, after: out.get(node.id) ?? [] })),
    metadata: record(run.metrics) ? run.metrics : undefined,
    declaration: run.declaration,
    items: Array.isArray(run.items) ? run.items : undefined,
    raw: str(run.raw) || undefined,
    time: record(run.time) ? (run.time as GraphRun["time"]) : undefined,
  }
}

function nodes(prev: GraphNode[] | undefined, next: GraphNode[]) {
  if (next.length === 0) return prev ?? []
  const map = new Map((prev ?? []).map((node) => [node.id, node]))
  return next.map((node) => {
    const old = map.get(node.id)
    return {
      ...old,
      ...node,
      deps: node.deps.length > 0 ? node.deps : old?.deps ?? [],
      after: node.after.length > 0 ? node.after : old?.after ?? [],
      verification: node.verification ?? old?.verification,
      raw: node.raw ?? old?.raw,
    }
  })
}

function merge(a: GraphRun[], b: GraphRun[]) {
  const map = new Map<string, GraphRun>()
  for (const run of [...a, ...b]) {
    const prev = map.get(run.id)
    map.set(run.id, {
      ...prev,
      ...run,
      total: Math.max(prev?.total ?? 0, run.total),
      completed: Math.max(prev?.completed ?? 0, run.completed),
      nodes: nodes(prev?.nodes, run.nodes),
      metadata: {
        ...(record(prev?.metadata) ? prev?.metadata : {}),
        ...(record(run.metadata) ? run.metadata : {}),
      },
      declaration: run.declaration ?? prev?.declaration,
      items: run.items ?? prev?.items,
      raw: run.raw ?? prev?.raw,
      time: {
        ...(record(prev?.time) ? prev?.time : {}),
        ...(record(run.time) ? run.time : {}),
      },
    })
  }
  return [...map.values()]
}

export function graphRuns(input: unknown, records: Log[] = []): GraphRun[] {
  return [...workflows(input).map(workflow), ...merge(logruns(records), protocols(input).map(protocol))].sort((a, b) => {
    const left = a.time?.started ?? 0
    const right = b.time?.started ?? 0
    if (left !== right) return left - right
    return a.id.localeCompare(b.id)
  })
}

export function graphLayout(run: GraphRun): GraphLayout {
  const width = 184
  const height = 82
  const gapx = 32
  const gapy = 52
  const pad = 24
  const ids = new Set(run.nodes.map((node) => node.id))
  const by = new Map(run.nodes.map((node) => [node.id, node]))
  const memo = new Map<string, number>()
  const rank = (id: string, seen = new Set<string>()): number => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    if (seen.has(id)) return 0
    const node = by.get(id)
    if (!node) return 0
    const deps = node.deps.filter((dep) => ids.has(dep))
    const value = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => rank(dep, new Set([...seen, id])))) + 1
    memo.set(id, value)
    return value
  }
  const nodes = run.nodes.map((node) => ({ ...node, rank: rank(node.id) }))
  const ranks = [...new Set(nodes.map((node) => node.rank))].sort((a, b) => a - b)
  const rows = new Map(
    ranks.flatMap((item) =>
      nodes
        .filter((node) => node.rank === item)
        .map((node, index) => [`${node.id}`, index] as const),
    ),
  )
  const laid = nodes.map((node) => ({
    ...node,
    row: rows.get(node.id) ?? 0,
    x: pad + (rows.get(node.id) ?? 0) * (width + gapx),
    y: pad + node.rank * (height + gapy),
    width,
    height,
  }))
  const placed = new Map(laid.map((node) => [node.id, node]))
  const edges = laid.flatMap((node) =>
    node.deps
      .map((dep) => placed.get(dep))
      .filter((dep): dep is GraphNodeLayout => !!dep)
      .map((dep) => ({
        from: dep.id,
        to: node.id,
        x1: dep.x + dep.width / 2,
        y1: dep.y + dep.height,
        x2: node.x + node.width / 2,
        y2: node.y,
      })),
  )
  return {
    nodes: laid,
    edges,
    width: Math.max(1, ...laid.map((node) => node.x + node.width + pad)),
    height: Math.max(1, ...laid.map((node) => node.y + node.height + pad)),
  }
}
