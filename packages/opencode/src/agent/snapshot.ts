import { createHash } from "crypto"

export type SnapshotText = {
  content?: string
  hash?: string
}

export type SnapshotInstruction = {
  path: string
  resolved?: string
  role?: string
  required?: boolean
  content?: string
  hash?: string
}

export type SnapshotSource = {
  dir?: string
  package?: string
  revision?: string
}

export type SnapshotLifecycle = {
  status?: string
  deprecated?: boolean
  replacement?: string
  replaced_by?: string
}

export type SnapshotMeta = {
  id?: string
  agent_version?: string
  schema_version?: string
  lifecycle?: SnapshotLifecycle
  [key: string]: unknown
}

export type SnapshotInput = {
  meta: SnapshotMeta
  identity?: SnapshotText
  rules?: SnapshotText
  instructions?: readonly SnapshotInstruction[]
  source?: SnapshotSource
}

export type SnapshotRecord = {
  agent_id: string
  agent_version: string
  schema_version: string
  agent_snapshot_hash: string
  agent_snapshot_ref: string
}

export type LifecycleRoute = {
  status: string
  deprecated: boolean
  replacement?: string
  action: "use" | "replace" | "warn" | "block"
}

export namespace AgentSnapshot {
  export function create(input: SnapshotInput): SnapshotRecord {
    const id = input.meta.id ?? "unknown"
    const version = input.meta.agent_version ?? "0.0.0"
    const schema = input.meta.schema_version ?? "agent.metadata.v1"
    const hash = digest({
      meta: input.meta,
      identity: input.identity,
      rules: input.rules,
      instructions: input.instructions ?? [],
      source: input.source ?? {},
    })

    return {
      agent_id: id,
      agent_version: version,
      schema_version: schema,
      agent_snapshot_hash: hash,
      agent_snapshot_ref: `agent://${id}@${version}#${hash}`,
    }
  }

  export function route(input: { meta?: SnapshotMeta; lifecycle?: SnapshotLifecycle }): LifecycleRoute {
    const life = input.lifecycle ?? input.meta?.lifecycle ?? {}
    const replacement = life.replacement ?? life.replaced_by
    const status = life.status ?? (life.deprecated ? "deprecated" : "active")
    if (status === "retired" || status === "rejected") {
      return {
        status,
        deprecated: true,
        action: "block",
      }
    }
    if (replacement) {
      return {
        status,
        deprecated: life.deprecated ?? (status === "deprecated" || status === "replaced"),
        replacement,
        action: "replace",
      }
    }
    if (life.deprecated || status === "deprecated" || status === "replaced") {
      return {
        status,
        deprecated: true,
        action: "warn",
      }
    }
    return {
      status,
      deprecated: false,
      action: "use",
    }
  }
}

function digest(input: unknown) {
  return createHash("sha256").update(JSON.stringify(stable(input))).digest("hex")
}

function stable(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(stable)
  if (!input || typeof input !== "object") return input
  return Object.fromEntries(
    Object.entries(input)
      .filter((item) => item[1] !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => [key, stable(val)]),
  )
}
