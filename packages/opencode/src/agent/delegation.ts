import { AgentEntry } from "./entry"
import { AgentArtifact, type ArtifactResult } from "./artifact"
import { AgentCollaboration } from "./collaboration"
import { evaluateCompletion } from "./completion"
import { validateInput, validateOutput, type ArtifactValue, type InputValue } from "./contracts"
import { deriveBoundary, type Boundary, type Policy } from "./boundary"
import { resolveMessages } from "./messages"
import { AgentObservability } from "./observability"
import { AgentSnapshot } from "./snapshot"
import { getRegistry } from "./registry"
import type { AgentTemplate } from "./schema"

type Mode = "all" | "primary" | "subagent"

type Item = {
  name: string
  mode?: Mode
  hidden?: boolean
  entry?: {
    primary?: boolean
    delegable?: boolean
    mentionable?: boolean
    hidden?: boolean
  }
}

type Rec = Record<string, unknown>
type Meta = Partial<AgentTemplate.Meta>
type Action = {
  id: string
  title: string
  operation: string
  executor: {
    type: string
    target: string
    capabilities?: string[]
  }
  input?: Rec
  depends_on?: string[]
  context_refs?: string[]
  result_policy?: string
}
type RuntimeInput = {
  agent: string
  meta?: Meta
  action: Action
  run?: Policy
  project?: Policy
  user?: Policy
  inputs?: readonly InputValue[]
  artifacts?: readonly ArtifactValue[]
  trigger?: unknown
}
type CompletionInput = {
  agent: string
  meta?: Meta
  result?: ArtifactResult
  results?: readonly ArtifactResult[]
  status: "completed" | "failed"
}

export namespace AgentDelegation {
  const deny: Record<string, string[]> = {
    default: ["default"],
    "milestone-planner": ["default", "milestone-planner"],
    "epic-planner": ["default", "milestone-planner", "epic-planner"],
    "feature-planner": ["default", "milestone-planner", "epic-planner", "feature-planner"],
  }

  const chain = new Set(Object.keys(deny))

  export function visible(item: Item, agent: string) {
    if (!AgentEntry.delegable(item)) return false
    return !new Set([agent, ...(deny[agent] ?? [])]).has(item.name)
  }

  export function list<T extends Item>(items: T[], agent: string) {
    return items.filter((item) => visible(item, agent))
  }

  export async function meta(agent: string): Promise<Meta | undefined> {
    return (await getRegistry().get(agent))?.meta
  }

  export function messages(input: { meta?: Meta; event: string }) {
    return resolveMessages({
      meta: input.meta,
      event: input.event,
      budget: {
        maxMessages: 8,
        maxChars: 6000,
      },
    })
  }

  export function runtime(input: RuntimeInput) {
    const vals = input.inputs ?? values(input.action.input)
    const check = validateInput({
      meta: {
        ...input.meta,
        collaboration: {
          ...input.meta?.collaboration,
          edges: (input.meta?.collaboration?.edges ?? []).map((item) => {
            const rec = item as Rec
            return {
              ...rec,
              mode: text(rec.mode) ?? text(rec.kind),
            }
          }),
        },
      },
      inputs: vals,
      artifacts: input.artifacts,
      visibility: "model",
    })
    const trig = input.trigger ?? (check.status === "ready" ? "assignment_candidate" : "missing_input")
    const plan = AgentCollaboration.plan({
      meta: input.meta,
      trigger: trig,
      source: {
        agent: input.agent,
        action: input.action.id,
        depth: 1,
      },
      projection: {
        missing_inputs: check.missing_inputs,
        status: check.status,
      },
    })
    const gated = check.status === "block" && plan.items.some((item) => item.edge_kind === "prerequisite")
      ? {
          ...check,
          status: "prerequisite" as const,
          prerequisite: {
            target: plan.items.find((item) => item.edge_kind === "prerequisite")?.target ?? "",
            inputs: check.missing_inputs,
            edge: {},
          },
        }
      : check
    const bound = deriveBoundary({
      meta: {
        runtime_boundary: input.meta?.runtime_boundary as Boundary | undefined,
      },
      action: input.action,
      run: input.run,
      project: input.project,
      user: input.user,
    })
    const obs = AgentObservability.policy({ meta: input.meta })
    const snap = AgentSnapshot.create({
      meta: input.meta ?? { id: input.agent },
    })
    const bad = bound.candidates.find((item) => item.status === "blocker" || item.status === "denied")
    const ask = bound.candidates.find((item) => item.status === "approval_required")
    const status = bad
      ? "block"
      : ask || check.status === "waiting_user"
        ? "waiting_user"
        : gated.status === "prerequisite"
          ? "prerequisite"
          : gated.status === "block"
            ? "block"
            : "ready"

    return {
      status,
      input: gated,
      collaboration: plan,
      ...(status !== "ready" && plan.items.some((item) => item.edge_kind === "fallback")
        ? { fallback: plan.items.find((item) => item.edge_kind === "fallback") }
        : {}),
      boundary: bound,
      observability: obs,
      snapshot: snap,
    }
  }

  export function complete(input: CompletionInput) {
    const recs = AgentArtifact.records({
      meta: input.meta,
      results: [...(input.results ?? []), ...(input.result ? [input.result] : [])],
    })
    const out = validateOutput({
      meta: input.meta,
      artifacts: recs,
    })
    const done = evaluateCompletion({
      meta: input.meta,
      artifacts: recs.map((item) => ({
        name: item.name,
        type: item.type,
        status: item.status,
        required: item.required,
      })),
      evidence: recs.flatMap((item) => item.evidence.map((proof) => ({
        name: proof.title ?? proof.id ?? proof.kind,
        type: proof.kind,
        status: "available",
      }))),
      validation: {
        status: out.status === "valid" ? "passed" : out.status === "invalid" ? "failed" : "pending",
        ...(out.status === "valid" || out.status === "invalid" ? { valid: out.status === "valid" } : {}),
        summary: out.reasons.map((item) => item.message).join("; "),
      },
      failure: {
        status: input.status === "failed" ? "failed" : "completed",
      },
    })
    const status = input.status === "failed" ? "failed" : done.status
    const trigger = out.status === "valid" && done.status !== "completed" ? "completion_rejected" : out.status !== "valid" ? "output_validation_failed" : undefined
    const followup = trigger
      ? AgentCollaboration.plan({
          meta: input.meta,
          trigger,
          source: {
            agent: input.agent,
            depth: 1,
          },
          projection: {
            status,
            validation: out.status,
            completion: done.status,
            missing_artifacts: [...out.missing_artifacts, ...done.missing_artifacts],
            missing_evidence: [...out.missing_evidence, ...done.missing_evidence],
            next: done.next,
          },
        })
      : undefined

    return {
      status,
      artifacts: recs,
      validation: out,
      completion: done,
      ...(followup && (followup.items.length || followup.diagnostics.length) ? { followup } : {}),
    }
  }

  function values(input: Rec | undefined): InputValue[] {
    return Object.entries(input ?? {}).map(([name, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {
          name,
          source: "protocol",
          visibility: "model",
        }
      }
      const rec = value as Rec
      return {
        name,
        source: text(rec.source) ?? "protocol",
        content_type: text(rec.content_type),
        artifact_type: text(rec.artifact_type ?? rec.type),
        visibility: text(rec.visibility) ?? "model",
      }
    })
  }

  function text(input: unknown) {
    if (typeof input === "string" && input.trim()) return input
  }
}
