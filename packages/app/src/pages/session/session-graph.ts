type Status = "ready" | "pending" | "running" | "completed" | "failed" | "skipped" | "cancelled"

type Node = {
  id: string
  title: string
  type: string
  status: Status
  deps: string[]
  after: string[]
  executor: string
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

export type GraphRun = {
  id: string
  title: string
  source: "workflow" | "protocol"
  status: Status | "blocked"
  total: number
  completed: number
  nodes: Node[]
  error?: string
  pause?: {
    type: string
    step: string
    reason?: string
  }
  variables?: Record<string, unknown>
  metadata?: Record<string, unknown>
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

function unique(input: string[]) {
  return [...new Set(input)]
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

function step(input: Record<string, unknown>, runs: Record<string, unknown>): Node {
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
    time: dict(run.time) as Node["time"],
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

function action(input: Record<string, unknown>): Node {
  const exec = dict(input.executor)
  return {
    id: str(input.id),
    title: str(input.title, str(input.id)),
    type: str(input.operation, "action"),
    status: status(input.status),
    deps: list(input.depends_on),
    after: [],
    executor: `${str(exec.type, "runtime")}:${str(exec.target, "auto")}`,
    output: str(input.summary) || undefined,
    error: str(input.error) || undefined,
    time: record(input.time) ? (input.time as Node["time"]) : undefined,
    raw: input,
  }
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
    time: record(run.time) ? (run.time as GraphRun["time"]) : undefined,
  }
}

export function graphRuns(input: unknown): GraphRun[] {
  return [...workflows(input).map(workflow), ...protocols(input).map(protocol)].sort((a, b) => {
    const left = a.time?.started ?? 0
    const right = b.time?.started ?? 0
    if (left !== right) return left - right
    return a.id.localeCompare(b.id)
  })
}
