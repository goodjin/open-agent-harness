import z from "zod"

export namespace Harness {
  const HandoffVisibilityDefault = {
    model: "summary",
    user: "summary",
    logs: "full",
    trace: "summary",
    future_runs: "ref",
  } as const

  export const Status = z
    .enum(["drafting", "ready", "running", "paused", "blocked", "reviewing", "verifying", "reworking", "completed", "failed", "aborted"])
    .meta({ ref: "HarnessRunStatus" })
  export type Status = z.infer<typeof Status>

  export const TaskStatus = z
    .enum([
      "draft",
      "ready",
      "assigned",
      "running",
      "submitted",
      "reviewing",
      "review_rejected",
      "review_approved",
      "verifying",
      "verify_failed",
      "approved",
      "merged",
      "blocked",
      "failed",
      "cancelled",
    ])
    .meta({ ref: "HarnessTaskStatus" })
  export type TaskStatus = z.infer<typeof TaskStatus>

  export const DecisionStatus = z.enum(["pending", "answered", "rejected", "cancelled"]).meta({ ref: "HarnessDecisionStatus" })
  export type DecisionStatus = z.infer<typeof DecisionStatus>

  export const Event = z
    .object({
      id: z.string(),
      run_id: z.string().optional(),
      type: z.string(),
      actor: z.string().default("runtime"),
      time: z.number(),
      summary: z.string().optional(),
      payload: z.record(z.string(), z.unknown()).default({}),
    })
    .strict()
    .meta({ ref: "HarnessEvent" })
  export type Event = z.infer<typeof Event>

  export const Gate = z
    .object({
      id: z.string(),
      status: z.enum(["pending", "passed", "failed", "blocked"]).default("pending"),
      required: z.array(z.string()).default([]),
      evidence: z.array(z.string()).default([]),
      reason: z.string().optional(),
    })
    .strict()
    .meta({ ref: "HarnessGate" })
  export type Gate = z.infer<typeof Gate>

  export const Assignment = z
    .object({
      id: z.string(),
      task_id: z.string(),
      actor: z.string(),
      role: z.string(),
      status: z.enum(["pending", "running", "completed", "failed", "cancelled"]).default("pending"),
      capabilities: z.array(z.string()).default([]),
      authority: z.record(z.string(), z.unknown()).default({}),
      context: z.string().optional(),
      updated_at: z.number(),
    })
    .strict()
    .meta({ ref: "HarnessAssignment" })
  export type Assignment = z.infer<typeof Assignment>

  export const Artifact = z
    .object({
      id: z.string(),
      run_id: z.string(),
      task_id: z.string().optional(),
      kind: z.string(),
      path: z.string(),
      summary: z.string().optional(),
      created_event: z.string().optional(),
      created_at: z.number(),
    })
    .strict()
    .meta({ ref: "HarnessArtifact" })
  export type Artifact = z.infer<typeof Artifact>

  export const HandoffStatus = z.enum(["completed", "partial", "blocked", "failed"]).meta({ ref: "HarnessHandoffStatus" })
  export type HandoffStatus = z.infer<typeof HandoffStatus>

  export const HandoffCause = z
    .enum(["assignment_terminal", "downstream_next", "model_intent", "policy", "user", "context_budget", "workflow_fan_in", "final_continuation"])
    .meta({ ref: "HarnessHandoffCause" })
  export type HandoffCause = z.infer<typeof HandoffCause>

  export const HandoffSource = z
    .object({
      run_id: z.string(),
      session_id: z.string().optional(),
      assignment_id: z.string().optional(),
      agent_id: z.string().optional(),
    })
    .strict()
    .meta({ ref: "HarnessHandoffSource" })
  export type HandoffSource = z.infer<typeof HandoffSource>

  export const HandoffTarget = z
    .object({
      executor: z.string().default("agent"),
      capability: z.string().optional(),
      agent_id: z.string().optional(),
      owner: z.string().optional(),
    })
    .strict()
    .meta({ ref: "HarnessHandoffTarget" })
  export type HandoffTarget = z.infer<typeof HandoffTarget>

  export const HandoffFact = z
    .object({
      text: z.string(),
      refs: z.array(z.string()).default([]),
      confidence: z.enum(["evidenced", "note", "assumption"]).default("evidenced"),
    })
    .strict()
    .meta({ ref: "HarnessHandoffFact" })
  export type HandoffFact = z.infer<typeof HandoffFact>

  export const HandoffArtifact = z
    .object({
      ref: z.string(),
      type: z.string().default("artifact"),
      status: z.enum(["available", "missing", "redacted"]).default("available"),
      summary: z.string().optional(),
    })
    .strict()
    .meta({ ref: "HarnessHandoffArtifact" })
  export type HandoffArtifact = z.infer<typeof HandoffArtifact>

  export const HandoffNext = z
    .object({
      goal: z.string(),
      depends_on: z.array(z.string()).default([]),
    })
    .strict()
    .meta({ ref: "HarnessHandoffNext" })
  export type HandoffNext = z.infer<typeof HandoffNext>

  export const HandoffVisibility = z
    .object({
      model: z.enum(["summary", "structured", "full", "ref", "none"]).default("summary"),
      user: z.enum(["summary", "structured", "full", "ref", "none"]).default("summary"),
      logs: z.enum(["summary", "structured", "full", "ref", "none"]).default("full"),
      trace: z.enum(["summary", "structured", "full", "ref", "none"]).default("summary"),
      future_runs: z.enum(["summary", "structured", "full", "ref", "none"]).default("ref"),
    })
    .strict()
    .meta({ ref: "HarnessHandoffVisibility" })
  export type HandoffVisibility = z.infer<typeof HandoffVisibility>

  export const Handoff = z
    .object({
      type: z.literal("handoff"),
      version: z.literal("1"),
      id: z.string(),
      source: HandoffSource,
      target: HandoffTarget.default({ executor: "agent" }),
      status: HandoffStatus,
      goal: z.string(),
      summary: z.string(),
      facts: z.array(HandoffFact).default([]),
      notes: z.array(z.string()).default([]),
      artifacts: z.array(HandoffArtifact).default([]),
      decisions: z.array(z.string()).default([]),
      constraints: z.array(z.string()).default([]),
      risks: z.array(z.string()).default([]),
      unresolved: z.array(z.string()).default([]),
      next: z.array(HandoffNext).default([]),
      raw_refs: z.array(z.string()).default([]),
      visibility: HandoffVisibility.default(HandoffVisibilityDefault),
      created_by: z.string().default("runtime"),
      created_at: z.number(),
    })
    .strict()
    .meta({ ref: "HarnessHandoff" })
  export type Handoff = z.infer<typeof Handoff>

  export const CreateHandoff = z
    .object({
      source: HandoffSource,
      target: HandoffTarget.default({ executor: "agent" }),
      status: HandoffStatus,
      goal: z.string(),
      summary: z.string(),
      facts: z.array(HandoffFact.omit({ confidence: true })).default([]),
      notes: z.array(z.string()).default([]),
      artifacts: z.array(HandoffArtifact.omit({ status: true }).extend({ status: HandoffArtifact.shape.status.optional() })).default([]),
      decisions: z.array(z.string()).default([]),
      constraints: z.array(z.string()).default([]),
      risks: z.array(z.string()).default([]),
      unresolved: z.array(z.string()).default([]),
      next: z.array(z.union([z.string(), HandoffNext])).default([]),
      raw_refs: z.array(z.string()).default([]),
      visibility: HandoffVisibility.default(HandoffVisibilityDefault),
    })
    .strict()
    .meta({ ref: "HarnessCreateHandoff" })
  export type CreateHandoff = z.input<typeof CreateHandoff>

  export const HandoffTrace = z
    .object({
      seq: z.number().int().min(1),
      type: z.string(),
      status: z.string().optional(),
      summary: z.string().optional(),
      refs: z.array(z.string()).default([]),
      time: z.number().optional(),
    })
    .strict()
    .meta({ ref: "HarnessHandoffTrace" })
  export type HandoffTrace = z.infer<typeof HandoffTrace>

  export const HandoffSelfReport = z
    .object({
      summary: z.string().optional(),
      done: z.array(z.string()).default([]),
      artifacts: z.array(z.string()).default([]),
      unresolved: z.array(z.string()).default([]),
      risks: z.array(z.string()).default([]),
      next: z.array(z.string()).default([]),
    })
    .strict()
    .meta({ ref: "HarnessHandoffSelfReport" })
  export type HandoffSelfReport = z.infer<typeof HandoffSelfReport>

  export const HandoffSourceBundle = z
    .object({
      type: z.literal("handoff.source"),
      version: z.literal("1"),
      id: z.string(),
      source: HandoffSource,
      status: HandoffStatus,
      goal: z.string(),
      self_report: HandoffSelfReport.optional(),
      timeline: z.array(HandoffTrace).default([]),
      artifacts: z.array(HandoffArtifact).default([]),
      decisions: z.array(z.string()).default([]),
      unresolved: z.array(z.string()).default([]),
      raw_refs: z.array(z.string()).default([]),
    })
    .strict()
    .meta({ ref: "HarnessHandoffSourceBundle" })
  export type HandoffSourceBundle = z.infer<typeof HandoffSourceBundle>

  export const BuildHandoffSource = z
    .object({
      run_id: z.string(),
      source: HandoffSource.optional(),
      status: HandoffStatus,
      goal: z.string().optional(),
      self_report: HandoffSelfReport.optional(),
      raw_refs: z.array(z.string()).default([]),
    })
    .strict()
    .meta({ ref: "HarnessBuildHandoffSource" })
  export type BuildHandoffSource = z.input<typeof BuildHandoffSource>

  export const PlanHandoff = z
    .object({
      run_id: z.string(),
      source: HandoffSource.optional(),
      status: HandoffStatus.optional(),
      assignment_status: z.string().optional(),
      next: z.array(z.string()).default([]),
      intent: z.boolean().default(false),
      policy: z.boolean().default(false),
      user: z.boolean().default(false),
      budget: z.boolean().default(false),
      fan_in: z.boolean().default(false),
      final: z.boolean().default(false),
      target: HandoffTarget.optional(),
      request_self_report: z.boolean().optional(),
    })
    .strict()
    .meta({ ref: "HarnessPlanHandoff" })
  export type PlanHandoff = z.input<typeof PlanHandoff>

  export const HandoffPlan = z
    .object({
      type: z.literal("handoff.plan"),
      run_id: z.string(),
      source: HandoffSource,
      target: HandoffTarget.optional(),
      trigger: z.boolean(),
      reasons: z.array(HandoffCause).default([]),
      request_self_report: z.boolean(),
      status: HandoffStatus.optional(),
      prompt: z.string().optional(),
    })
    .strict()
    .meta({ ref: "HarnessHandoffPlan" })
  export type HandoffPlan = z.infer<typeof HandoffPlan>

  export const RequestHandoffSelfReport = z
    .object({
      run_id: z.string(),
      source: HandoffSource.optional(),
      status: HandoffStatus.default("partial"),
      reasons: z.array(HandoffCause).default([]),
      goal: z.string().optional(),
    })
    .strict()
    .meta({ ref: "HarnessRequestHandoffSelfReport" })
  export type RequestHandoffSelfReport = z.input<typeof RequestHandoffSelfReport>

  export const HandoffSelfReportRequest = z
    .object({
      type: z.literal("handoff.self_report_request"),
      id: z.string(),
      source: HandoffSource,
      status: HandoffStatus,
      reasons: z.array(HandoffCause).default([]),
      prompt: z.string(),
      created_at: z.number(),
    })
    .strict()
    .meta({ ref: "HarnessHandoffSelfReportRequest" })
  export type HandoffSelfReportRequest = z.infer<typeof HandoffSelfReportRequest>

  export const Decision = z
    .object({
      id: z.string(),
      run_id: z.string(),
      task_id: z.string().optional(),
      level: z.enum(["L0", "L1", "L2", "L3", "L4"]).default("L3"),
      status: DecisionStatus.default("pending"),
      question: z.string(),
      options: z
        .array(
          z
            .object({
              id: z.string(),
              label: z.string(),
              tradeoff: z.string().optional(),
            })
            .strict(),
        )
        .default([]),
      recommended: z.string().optional(),
      answer: z.string().optional(),
      created_at: z.number(),
      updated_at: z.number(),
    })
    .strict()
    .meta({ ref: "HarnessDecision" })
  export type Decision = z.infer<typeof Decision>

  export const Task = z
    .object({
      id: z.string(),
      run_id: z.string(),
      title: z.string(),
      type: z.string().default("task"),
      status: TaskStatus.default("ready"),
      goal: z.string(),
      depends_on: z.array(z.string()).default([]),
      acceptance: z.array(z.string()).default([]),
      gates: z.array(Gate).default([]),
      assignment: Assignment.optional(),
      artifacts: z.array(z.string()).default([]),
      created_at: z.number(),
      updated_at: z.number(),
    })
    .strict()
    .meta({ ref: "HarnessTask" })
  export type Task = z.infer<typeof Task>

  export const Run = z
    .object({
      id: z.string(),
      name: z.string(),
      status: Status.default("ready"),
      goal: z.string(),
      mode: z.string().default("development"),
      constraints: z.array(z.string()).default([]),
      memory_scopes: z.array(z.enum(["run", "project", "team", "global"])).default(["project"]),
      automation: z.enum(["manual", "guided", "auto"]).default("guided"),
      progress: z
        .object({
          completed: z.number().int().min(0).default(0),
          total: z.number().int().min(0).default(0),
        })
        .strict()
        .default({ completed: 0, total: 0 }),
      active_assignments: z.number().int().min(0).default(0),
      pending_decisions: z.number().int().min(0).default(0),
      created_at: z.number(),
      updated_at: z.number(),
    })
    .strict()
    .meta({ ref: "HarnessRun" })
  export type Run = z.infer<typeof Run>

  export const Concept = z
    .object({
      id: z.string(),
      kind: z.string(),
      scope: z.enum(["run", "project", "team", "global"]).default("project"),
      namespace: z.string(),
      status: z.enum(["draft", "active", "deprecated", "replaced", "retired", "rejected"]).default("active"),
      version: z.number().int().min(1).default(1),
      summary: z.string(),
      source: z.string().optional(),
      refs: z.array(z.string()).default([]),
      replaces: z.array(z.string()).default([]),
      replaced_by: z.array(z.string()).default([]),
      new_information: z.string().optional(),
      evidence: z.array(z.string()).default([]),
      updated_at: z.number(),
    })
    .strict()
    .meta({ ref: "HarnessConcept" })
  export type Concept = z.infer<typeof Concept>

  export const Memory = z
    .object({
      id: z.string(),
      scope: z.enum(["run", "project", "team", "global"]),
      namespace: z.string(),
      kind: z.string(),
      status: z.enum(["current", "historical", "superseded"]).default("current"),
      summary: z.string(),
      evidence: z.array(z.string()).default([]),
      supersedes: z.array(z.string()).default([]),
      updated_at: z.number(),
    })
    .strict()
    .meta({ ref: "HarnessMemory" })
  export type Memory = z.infer<typeof Memory>

  export const CreateRun = z
    .object({
      goal: z.string().min(1),
      name: z.string().optional(),
      mode: z.string().optional(),
      constraints: z.array(z.string()).default([]),
      memory_scopes: z.array(z.enum(["run", "project", "team", "global"])).default(["project"]),
      automation: z.enum(["manual", "guided", "auto"]).default("guided"),
    })
    .strict()
  export type CreateRun = z.infer<typeof CreateRun>

  export const Command = z
    .object({
      type: z.enum([
        "run.create",
        "run.pause",
        "run.resume",
        "run.abort",
        "task.retry",
        "task.cancel",
        "decision.answer",
        "verify.rerun",
        "handoff.plan",
        "handoff.self_report.request",
        "concept.replace.request",
        "concept.replace.approve",
        "concept.replace.reject",
      ]),
      run_id: z.string().optional(),
      task_id: z.string().optional(),
      decision_id: z.string().optional(),
      concept_id: z.string().optional(),
      actor: z.string().default("user"),
      payload: z.record(z.string(), z.unknown()).default({}),
    })
    .strict()
    .meta({ ref: "HarnessCommand" })
  export type Command = z.infer<typeof Command>

  export const Summary = z
    .object({
      run: Run,
      tasks: z.array(Task),
      assignments: z.array(Assignment),
      artifacts: z.array(Artifact),
      handoffs: z.array(Handoff),
      decisions: z.array(Decision),
      events: z.array(Event),
    })
    .strict()
    .meta({ ref: "HarnessSummary" })
  export type Summary = z.infer<typeof Summary>
}
