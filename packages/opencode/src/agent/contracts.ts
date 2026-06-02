import type { ArtifactRecord } from "./artifact"

export type InputContract = {
  name?: string
  id?: string
  required?: boolean
  source?: string
  sources?: readonly string[]
  content_type?: string
  content_types?: readonly string[]
  artifact_type?: string
  artifact_types?: readonly string[]
  visibility?: string | readonly string[]
}

export type OutputContract = {
  name?: string
  id?: string
  required?: boolean
  type?: string
  artifact_type?: string
  content_type?: string
  required_evidence?: readonly string[]
}

export type InputValue = {
  name: string
  source?: string
  content_type?: string
  artifact_type?: string
  visibility?: string
}

export type ArtifactValue = InputValue

export type Edge = {
  target?: string
  mode?: string
  type?: string
  provides?: readonly string[]
  inputs?: readonly string[]
}

export type InputReason = {
  input: string
  code: "missing_input" | "source_denied" | "content_type_mismatch" | "artifact_type_mismatch" | "visibility_denied"
  message: string
  expected?: string | readonly string[]
  actual?: string
}

export type OutputReason = {
  artifact: string
  code: "missing_artifact" | "artifact_type_mismatch" | "content_type_mismatch" | "missing_evidence" | "invalid_artifact"
  message: string
  expected?: string
  actual?: string
}

export type InputDecision = {
  status: "ready" | "block" | "waiting_user" | "prerequisite"
  reasons: InputReason[]
  missing_inputs: string[]
  prerequisite?: {
    target: string
    inputs: string[]
    edge: Edge
  }
}

export type OutputDecision = {
  status: "valid" | "invalid" | "partial"
  reasons: OutputReason[]
  missing_artifacts: string[]
  missing_evidence: string[]
}

export type InputContext = {
  meta?: {
    contracts?: {
      input?: readonly InputContract[]
    }
    collaboration?: {
      edges?: readonly Edge[]
    }
  }
  contracts?: {
    input?: readonly InputContract[]
  }
  collaboration?: {
    edges?: readonly Edge[]
  }
  inputs?: readonly InputValue[]
  artifacts?: readonly ArtifactValue[]
  visibility?: string
}

export type OutputContext = {
  meta?: {
    contracts?: {
      output?: readonly OutputContract[]
    }
    completion?: {
      required_evidence?: readonly string[]
    }
  }
  contracts?: {
    output?: readonly OutputContract[]
  }
  artifacts?: readonly ArtifactRecord[]
}

export function validateInput(ctx: InputContext): InputDecision {
  const contracts = ctx.contracts?.input ?? ctx.meta?.contracts?.input ?? []
  const values = [...(ctx.inputs ?? []), ...(ctx.artifacts ?? [])]
  const required = contracts.filter((item) => item.required === true)
  const reasons = required.flatMap((item) => validate(item, values, ctx.visibility))
  const missing = reasons.filter((item) => item.code === "missing_input").map((item) => item.input)
  const prereq = prerequisite(ctx.collaboration?.edges ?? ctx.meta?.collaboration?.edges ?? [], missing)

  if (prereq) {
    return {
      status: "prerequisite",
      reasons,
      missing_inputs: missing,
      prerequisite: prereq,
    }
  }

  if (reasons.some((item) => item.code === "visibility_denied")) {
    return {
      status: "waiting_user",
      reasons,
      missing_inputs: missing,
    }
  }

  return {
    status: reasons.length ? "block" : "ready",
    reasons,
    missing_inputs: missing,
  }
}

export function validateOutput(ctx: OutputContext): OutputDecision {
  const contracts = ctx.contracts?.output ?? ctx.meta?.contracts?.output ?? []
  const artifacts = ctx.artifacts ?? []
  const reasons = [
    ...artifacts.filter((item) => item.status === "invalid" || !item.name || !item.type).map(invalid),
    ...contracts.flatMap((item) => output(item, artifacts, ctx.meta?.completion?.required_evidence ?? [])),
  ]
  const missing = reasons.filter((item) => item.code === "missing_artifact").map((item) => item.artifact)
  const proof = reasons
    .filter((item) => item.code === "missing_evidence" && item.expected !== undefined)
    .map((item) => `${item.artifact}:${item.expected}`)

  return {
    status: reasons.some((item) => item.code === "invalid_artifact" || item.code === "artifact_type_mismatch" || item.code === "content_type_mismatch")
      ? "invalid"
      : reasons.length
        ? "partial"
        : "valid",
    reasons,
    missing_artifacts: missing,
    missing_evidence: proof,
  }
}

function validate(item: InputContract, values: readonly InputValue[], visibility?: string): InputReason[] {
  const name = item.name ?? item.id
  if (!name) return []
  const found = values.filter((val) => val.name === name)
  if (!found.length) return [reason(name, "missing_input", "Required input is missing")]

  const reasons = found.map((value) => check(item, value, name, visibility))
  if (reasons.some((item) => item.length === 0)) return []
  return reasons.find((item) => item.length)?.slice(0, 1) ?? []
}

function output(item: OutputContract, artifacts: readonly ArtifactRecord[], proof: readonly string[]): OutputReason[] {
  const name = item.name ?? item.id
  if (!name) return []
  const found = artifacts.filter((val) => val.name === name && val.status !== "invalid")
  const available = found.filter((val) => val.status === "available")
  if (!available.length && item.required === true) return [out(name, "missing_artifact", "Required output artifact is missing")]
  if (!available.length) return []

  const reasons = available.map((value) => inspect(item, value, name, proof))
  if (reasons.some((item) => item.length === 0)) return []
  return reasons.find((item) => item.length)?.slice() ?? []
}

function inspect(item: OutputContract, value: ArtifactRecord, name: string, proof: readonly string[]): OutputReason[] {
  return [
    differ(name, "artifact_type_mismatch", "Output artifact type is not allowed", item.type ?? item.artifact_type, value.type),
    differ(name, "content_type_mismatch", "Output content type is not allowed", item.content_type, value.content_type),
    ...[...(item.required_evidence ?? []), ...proof]
      .filter((val) => !evidence(value, val))
      .map((val) => out(name, "missing_evidence", "Required output evidence is missing", val)),
  ].filter((item): item is OutputReason => item !== undefined)
}

function differ(name: string, code: OutputReason["code"], message: string, expected: string | undefined, actual?: string) {
  if (!expected || actual === expected) return undefined
  return out(name, code, message, expected, actual)
}

function evidence(value: ArtifactRecord, required: string) {
  return value.evidence.some((item) => item.kind === required || item.id === required || item.title === required)
}

function invalid(item: ArtifactRecord) {
  return out(item.name, "invalid_artifact", "Artifact record is invalid")
}

function check(item: InputContract, value: InputValue, name: string, visibility?: string): InputReason[] {
  return [
    mismatch(name, "source_denied", "Input source is not allowed", list(item.sources, item.source), value.source),
    mismatch(name, "content_type_mismatch", "Input content type is not allowed", list(item.content_types, item.content_type), value.content_type),
    mismatch(name, "artifact_type_mismatch", "Input artifact type is not allowed", list(item.artifact_types, item.artifact_type), value.artifact_type),
    visibility && !visible(item.visibility, value.visibility, visibility)
      ? reason(name, "visibility_denied", "Input visibility does not allow model access", visibility, value.visibility)
      : undefined,
  ].filter((item): item is InputReason => item !== undefined)
}

function mismatch(name: string, code: InputReason["code"], message: string, expected: readonly string[], actual?: string) {
  if (!expected.length || (actual && expected.includes(actual))) return undefined
  return reason(name, code, message, expected, actual)
}

function prerequisite(edges: readonly Edge[], missing: readonly string[]) {
  const set = new Set(missing)
  const edge = edges.find((item) => (item.mode === "prerequisite" || item.type === "prerequisite") && item.target && provided(item).some((name) => set.has(name)))
  if (!edge?.target) return undefined
  return {
    target: edge.target,
    inputs: provided(edge).filter((name) => set.has(name)),
    edge,
  }
}

function provided(edge: Edge) {
  return [...(edge.provides ?? []), ...(edge.inputs ?? [])]
}

function list(values?: readonly string[], value?: string) {
  return [...(values ?? []), ...(value ? [value] : [])]
}

function visible(policy: InputContract["visibility"], value: string | undefined, required: string) {
  if (Array.isArray(policy) && !policy.includes(required)) return false
  if (typeof policy === "string" && policy !== required) return false
  return value === required
}

function reason(input: string, code: InputReason["code"], message: string, expected?: string | readonly string[], actual?: string): InputReason {
  return {
    input,
    code,
    message,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
  }
}

function out(artifact: string, code: OutputReason["code"], message: string, expected?: string, actual?: string): OutputReason {
  return {
    artifact,
    code,
    message,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
  }
}
