export type ArtifactStatus = "expected" | "available" | "invalid" | "missing"

export type ArtifactEvidence = {
  kind: string
  id?: string
  title?: string
  [key: string]: unknown
}

export type ArtifactRecord = {
  name: string
  type: string
  content_type: string
  status: ArtifactStatus
  evidence: ArtifactEvidence[]
  source: string
  visibility: string
  content?: unknown
  required?: boolean
}

export type ArtifactContract = {
  name?: string
  id?: string
  type?: string
  artifact_type?: string
  content_type?: string
  required?: boolean
  source?: string
  visibility?: string
}

export type ArtifactInput = {
  name?: string
  id?: string
  type?: string
  artifact_type?: string
  content_type?: string
  content?: unknown
  evidence?: readonly ArtifactEvidence[]
  source?: string
  visibility?: string
}

export type ArtifactResult =
  | string
  | {
      content?: unknown
      text?: unknown
      message?: unknown
      source?: string
      metadata?: {
        artifact?: ArtifactInput
        artifacts?: readonly ArtifactInput[]
        evidence?: readonly ArtifactEvidence[]
      }
    }

export type ArtifactContext = {
  meta?: {
    contracts?: {
      output?: readonly ArtifactContract[]
    }
  }
  contracts?: {
    output?: readonly ArtifactContract[]
  }
  artifacts?: readonly ArtifactInput[]
  results?: readonly ArtifactResult[]
}

export namespace AgentArtifact {
  export function records(ctx: ArtifactContext) {
    const vals = values(ctx)
    const recs = vals.map((item) => record(item.value, item.evidence, item.source))
    const out = contracts(ctx).map((item) => {
      const name = item.name ?? item.id ?? ""
      const found = recs.find((rec) => rec.status === "available" && rec.name === name)
      if (found) return { ...found, required: item.required === true }
      return expected(item)
    })
    const names = new Set(contracts(ctx).map((item) => item.name ?? item.id ?? ""))
    return [...out, ...recs.filter((item) => !names.has(item.name))]
  }
}

function contracts(ctx: ArtifactContext) {
  return ctx.contracts?.output ?? ctx.meta?.contracts?.output ?? []
}

function expected(item: ArtifactContract): ArtifactRecord {
  return {
    name: item.name ?? item.id ?? "",
    type: item.type ?? item.artifact_type ?? "artifact",
    content_type: item.content_type ?? "text/plain",
    status: item.required === true ? "missing" : "expected",
    evidence: [],
    source: item.source ?? "agent",
    visibility: item.visibility ?? "model",
    required: item.required === true,
  }
}

function values(ctx: ArtifactContext) {
  const expected = contracts(ctx)
  return [
    ...(ctx.artifacts ?? []).map((item) => ({ value: item, evidence: [] as ArtifactEvidence[], source: undefined })),
    ...(ctx.results ?? []).flatMap((item) => result(item, expected)),
  ]
}

function result(item: ArtifactResult, expected: readonly ArtifactContract[]) {
  const single = expected.length === 1 ? expected[0] : undefined
  if (typeof item === "string") {
    return [
      {
        value: {
          name: single?.name ?? single?.id ?? "result",
          type: single?.type ?? single?.artifact_type ?? "text",
          content_type: single?.content_type ?? "text/plain",
          content: item,
          source: "result",
          visibility: single?.visibility,
        },
        evidence: [] as ArtifactEvidence[],
        source: "result",
      },
    ]
  }

  const evidence = item.metadata?.evidence ?? []
  const artifacts = [item.metadata?.artifact, ...(item.metadata?.artifacts ?? [])].filter((val): val is ArtifactInput => val !== undefined)
  if (artifacts.length) return artifacts.map((val) => ({ value: val, evidence, source: item.source }))

  const content = item.content ?? item.text ?? item.message
  if (content === undefined) return []

  return [
    {
      value: {
        name: single?.name ?? single?.id ?? "result",
        type: single?.type ?? single?.artifact_type ?? "text",
        content_type: single?.content_type ?? "text/plain",
        content,
        source: item.source ?? "result",
        visibility: single?.visibility,
      },
      evidence,
      source: item.source,
    },
  ]
}

function record(item: ArtifactInput, proof: readonly ArtifactEvidence[], source?: string): ArtifactRecord {
  const name = item.name ?? item.id ?? ""
  const type = item.type ?? item.artifact_type ?? ""
  const invalid = !name || !type
  return {
    name,
    type,
    content_type: item.content_type ?? "text/plain",
    status: invalid ? "invalid" : "available",
    evidence: [
      ...proof,
      ...(item.evidence ?? []),
      ...(invalid
        ? [
            {
              kind: "normalizer",
              title: "Artifact is missing name or type",
            },
          ]
        : []),
    ],
    source: item.source ?? source ?? "agent",
    visibility: item.visibility ?? "model",
    ...(item.content === undefined ? {} : { content: item.content }),
  }
}
