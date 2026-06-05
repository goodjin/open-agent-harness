import z from "zod"

export namespace Harness {
  export const SchemaVersion = z.literal("v2.0").meta({ ref: "HarnessV2SchemaVersion" })
  export type SchemaVersion = z.infer<typeof SchemaVersion>

  export const ObjectCategory = z.enum(["fact", "view", "evidence", "resource", "context", "policy"]).meta({ ref: "HarnessV2ObjectCategory" })
  export type ObjectCategory = z.infer<typeof ObjectCategory>

  export const Visibility = z.enum(["private", "project", "team", "public"]).meta({ ref: "HarnessV2Visibility" })
  export type Visibility = z.infer<typeof Visibility>

  export const Lifecycle = z.enum(["draft", "active", "archived", "tombstoned"]).meta({ ref: "HarnessV2Lifecycle" })
  export type Lifecycle = z.infer<typeof Lifecycle>

  export const Producer = z
    .object({
      type: z.enum(["runtime", "model", "tool", "agent", "user", "system", "import"]),
      id: z.string(),
      run_id: z.string().optional(),
      action_id: z.string().optional(),
      session_id: z.string().optional(),
    })
    .strict()
    .meta({ ref: "HarnessV2Producer" })
  export type Producer = z.infer<typeof Producer>

  export const RefKind = z
    .enum(["resource", "document", "artifact", "action", "handoff", "trace", "projection", "memory", "snapshot"])
    .meta({ ref: "HarnessV2RefKind" })
  export type RefKind = z.infer<typeof RefKind>

  export const Ref = z
    .string()
    .regex(/^(resource|document|artifact|action|handoff|trace|projection|memory|snapshot):\/\/[A-Za-z0-9._~:/-]+$/)
    .meta({ ref: "HarnessV2Ref" })
  export type Ref = z.infer<typeof Ref>

  export const Object = z
    .object({
      id: z.string(),
      schema_version: SchemaVersion.default("v2.0"),
      category: ObjectCategory,
      kind: z.string(),
      producer: Producer,
      visibility: Visibility,
      lifecycle: Lifecycle.default("active"),
      created_at: z.number(),
      updated_at: z.number(),
      refs: z.array(Ref).default([]),
      summary: z.string().optional(),
      data: z.record(z.string(), z.unknown()).default({}),
    })
    .strict()
    .meta({ ref: "HarnessV2Object" })
  export type Object = z.infer<typeof Object>

  export const ResourceObject = Object.extend({
    category: z.literal("resource"),
    uri: z.string(),
    media_type: z.string().optional(),
    evidence: z.array(Ref).default([]),
  })
    .strict()
    .meta({ ref: "HarnessV2ResourceObject" })
  export type ResourceObject = z.infer<typeof ResourceObject>

  export const ResourceKind = z
    .enum(["tool_output", "model_long_output", "review_report", "test_report", "research_note", "handoff_state", "context_snapshot", "document"])
    .meta({ ref: "HarnessResourceKind" })
  export type ResourceKind = z.infer<typeof ResourceKind>

  export const ResourceRecord = z
    .object({
      id: z.string(),
      run_id: z.string(),
      kind: ResourceKind,
      uri: Ref,
      summary: z.string(),
      producer: Producer,
      source_action: z.string().optional(),
      visibility: Visibility.default("project"),
      evidence: z.array(Ref).default([]),
      lifecycle: Lifecycle.default("active"),
      media_type: z.string().default("text/plain"),
      size: z.number().int().min(0),
      created_at: z.number(),
      updated_at: z.number(),
    })
    .strict()
    .meta({ ref: "HarnessResourceRecord" })
  export type ResourceRecord = z.infer<typeof ResourceRecord>

  export const DocumentWrite = z
    .object({
      kind: ResourceKind.default("document"),
      title: z.string(),
      body: z.string(),
      media_type: z.string().default("text/plain"),
      summary: z.string().optional(),
      producer: Producer,
      source_action: z.string().optional(),
      visibility: Visibility.default("project"),
      evidence: z.array(Ref).default([]),
      threshold: z.number().int().min(0).default(4000),
      redact: z.array(z.string()).default([]),
    })
    .strict()
    .meta({ ref: "HarnessDocumentWrite" })
  export type DocumentWrite = z.infer<typeof DocumentWrite>

  export const ResourceSessionPart = z
    .object({
      type: z.literal("resource_ref"),
      title: z.string(),
      summary: z.string(),
      ref: Ref,
      next: z.array(z.string()).default([]),
    })
    .strict()
    .meta({ ref: "HarnessResourceSessionPart" })
  export type ResourceSessionPart = z.infer<typeof ResourceSessionPart>

  export const ResourceRead = z
    .object({
      resource: ResourceRecord,
      body: z.string(),
    })
    .strict()
    .meta({ ref: "HarnessResourceRead" })
  export type ResourceRead = z.infer<typeof ResourceRead>

  export const ResourcePreview = z
    .object({
      resource: ResourceRecord,
      preview: z.string(),
      truncated: z.boolean(),
    })
    .strict()
    .meta({ ref: "HarnessResourcePreview" })
  export type ResourcePreview = z.infer<typeof ResourcePreview>

  export const ContextObject = Object.extend({
    category: z.literal("context"),
    target: z.string(),
    included: z.array(Ref).default([]),
    excluded: z
      .array(
        z
          .object({
            ref: Ref,
            reason: z.string(),
          })
          .strict(),
      )
      .default([]),
    budget: z
      .object({
        tokens: z.number().int().nonnegative(),
      })
      .strict(),
  })
    .strict()
    .meta({ ref: "HarnessV2ContextObject" })
  export type ContextObject = z.infer<typeof ContextObject>

  export const RefExpansionMode = z.enum(["summary", "structured", "full", "on_failure", "on_demand", "adaptive"]).meta({ ref: "HarnessRefExpansionMode" })
  export type RefExpansionMode = z.infer<typeof RefExpansionMode>

  export const ContextRecord = z
    .object({
      ref: Ref,
      mode: RefExpansionMode,
      visibility: Visibility,
      summary: z.string(),
      content: z.string(),
      reason: z.string(),
      tokens: z.number().int().nonnegative(),
    })
    .strict()
    .meta({ ref: "HarnessContextRecord" })
  export type ContextRecord = z.infer<typeof ContextRecord>

  export const ContextExcludedRecord = z
    .object({
      ref: Ref,
      mode: RefExpansionMode,
      visibility: Visibility.optional(),
      reason: z.string(),
    })
    .strict()
    .meta({ ref: "HarnessContextExcludedRecord" })
  export type ContextExcludedRecord = z.infer<typeof ContextExcludedRecord>

  export const ContextBundle = z
    .object({
      id: z.string(),
      run_id: z.string(),
      assignment_id: z.string().optional(),
      goal: z.string(),
      user_input: z.string().default(""),
      included: z.array(ContextRecord).default([]),
      excluded: z.array(ContextExcludedRecord).default([]),
      refs: z.array(Ref).default([]),
      summary: z.string(),
      token_budget: z.number().int().nonnegative(),
      tokens_used: z.number().int().nonnegative(),
      visibility: Visibility.default("project"),
      created_at: z.number(),
    })
    .strict()
    .meta({ ref: "HarnessContextBundle" })
  export type ContextBundle = z.infer<typeof ContextBundle>

  export const ContextCompileInput = z
    .object({
      run_id: z.string(),
      assignment_id: z.string().optional(),
      goal: z.string(),
      user_input: z.string().default(""),
      refs: z.array(Ref).default([]),
      resource_refs: z.array(Ref).default([]),
      handoff_refs: z.array(Ref).default([]),
      memory_refs: z.array(Ref).default([]),
      expansion: z.record(z.string(), RefExpansionMode).default({}),
      token_budget: z.number().int().nonnegative().default(4000),
      visibility: Visibility.default("project"),
    })
    .strict()
    .meta({ ref: "HarnessContextCompileInput" })
  export type ContextCompileInput = z.infer<typeof ContextCompileInput>

  export const ContextPreview = z
    .object({
      bundle: ContextBundle,
      explanations: z.array(
        z
          .object({
            ref: Ref,
            decision: z.enum(["included", "excluded"]),
            mode: RefExpansionMode,
            reason: z.string(),
          })
          .strict(),
      ),
    })
    .strict()
    .meta({ ref: "HarnessContextPreview" })
  export type ContextPreview = z.infer<typeof ContextPreview>

  export const MemoryObject = Object.extend({
    category: z.literal("fact"),
    scope: z.enum(["run", "project", "team", "global"]),
    namespace: z.string(),
    status: z.enum(["candidate", "current", "historical", "superseded", "rejected"]).default("candidate"),
    evidence: z.array(Ref).default([]),
  })
    .strict()
    .meta({ ref: "HarnessV2MemoryObject" })
  export type MemoryObject = z.infer<typeof MemoryObject>

  export const AgentKind = z.enum(["planner", "worker", "verifier", "helper"]).meta({ ref: "HarnessAgentKind" })
  export type AgentKind = z.infer<typeof AgentKind>

  export const AgentEntry = z
    .object({
      primary: z.boolean().default(false),
      delegable: z.boolean().default(true),
      mentionable: z.boolean().default(true),
    })
    .strict()
    .meta({ ref: "HarnessAgentEntry" })
  export type AgentEntry = z.infer<typeof AgentEntry>

  export const AgentCapability = z
    .object({
      tags: z.array(z.string()).default([]),
      writes: z.boolean().default(false),
      cost: z.enum(["low", "medium", "high"]).default("medium"),
    })
    .strict()
    .meta({ ref: "HarnessAgentCapability" })
  export type AgentCapability = z.infer<typeof AgentCapability>

  export const AgentPermission = z
    .object({
      tools: z.array(z.string()).default([]),
      scopes: z.array(z.enum(["private", "project", "team", "public"])).default(["project"]),
      write: z.boolean().default(false),
    })
    .strict()
    .meta({ ref: "HarnessAgentPermission" })
  export type AgentPermission = z.infer<typeof AgentPermission>

  export const AgentTemplateRecord = z
    .object({
      id: z.string(),
      identity: z.string(),
      kind: AgentKind,
      entry: AgentEntry,
      capability: AgentCapability,
      permission: AgentPermission,
      model_preference: z
        .object({
          provider: z.string(),
          model: z.string(),
        })
        .strict()
        .optional(),
      execution_mode: z.enum(["chat", "workflow", "protocol"]).default("chat"),
      relationships: z
        .object({
          supervises: z.array(z.string()).default([]),
          peers: z.array(z.string()).default([]),
        })
        .strict(),
      orchestration_policy: z
        .object({
          max_parallel: z.number().int().min(1).default(1),
          review_required: z.boolean().default(false),
        })
        .strict(),
      availability: z.enum(["available", "busy", "disabled"]).default("available"),
      created_at: z.number().default(0),
      updated_at: z.number().default(0),
    })
    .strict()
    .meta({ ref: "HarnessAgentTemplateRecord" })
  export type AgentTemplateRecord = z.infer<typeof AgentTemplateRecord>

  export const AgentSessionRecord = z
    .object({
      id: z.string(),
      run_id: z.string(),
      template_id: z.string(),
      assignment_id: z.string(),
      action_id: z.string(),
      authority: z.record(z.string(), z.unknown()).default({}),
      context_summary: z.string(),
      trace_refs: z.array(Ref).default([]),
      status: z.enum(["pending", "running", "completed", "failed", "cancelled"]).default("pending"),
      created_at: z.number(),
      updated_at: z.number(),
    })
    .strict()
    .meta({ ref: "HarnessAgentSessionRecord" })
  export type AgentSessionRecord = z.infer<typeof AgentSessionRecord>

  export const AgentRoute = z
    .object({
      entry: z.enum(["primary", "delegable", "mentionable"]),
      capability: z.array(z.string()).default([]),
      permission: z
        .object({
          write: z.boolean().optional(),
          scopes: z.array(z.enum(["private", "project", "team", "public"])).default([]),
        })
        .strict()
        .default({ scopes: [] }),
      budget: z
        .object({
          max_cost: z.enum(["low", "medium", "high"]).default("high"),
        })
        .strict()
        .default({ max_cost: "high" }),
      projection: z.record(z.string(), z.unknown()).default({}),
    })
    .strict()
    .meta({ ref: "HarnessAgentRoute" })
  export type AgentRoute = z.infer<typeof AgentRoute>

  export const AgentAssignmentInput = z
    .object({
      action_id: z.string(),
      template_id: z.string(),
      role: z.string().default("agent"),
      authority: z.record(z.string(), z.unknown()).default({}),
      context_summary: z.string(),
      trace_refs: z.array(Ref).default([]),
    })
    .strict()
    .meta({ ref: "HarnessAgentAssignmentInput" })
  export type AgentAssignmentInput = z.infer<typeof AgentAssignmentInput>

  export const WorkflowObject = Object.extend({
    category: z.literal("policy"),
    version: z.number().int().min(1),
    nodes: z.array(Ref).default([]),
    criteria: z.array(z.string()).default([]),
  })
    .strict()
    .meta({ ref: "HarnessV2WorkflowObject" })
  export type WorkflowObject = z.infer<typeof WorkflowObject>

  export const PolicyObject = Object.extend({
    category: z.literal("policy"),
    rules: z.array(z.record(z.string(), z.string())).default([]),
  })
    .strict()
    .meta({ ref: "HarnessV2PolicyObject" })
  export type PolicyObject = z.infer<typeof PolicyObject>

  export const V1Mapping = z
    .object({
      artifact: z.array(ObjectCategory),
      context: z.array(ObjectCategory),
      memory: z.array(ObjectCategory),
      workflow: z.array(ObjectCategory),
    })
    .strict()
    .meta({ ref: "HarnessV2V1Mapping" })
  export type V1Mapping = z.infer<typeof V1Mapping>

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

  export const ActionStatus = z.enum(["ready", "blocked", "running", "completed", "failed", "cancelled"]).meta({ ref: "HarnessActionStatus" })
  export type ActionStatus = z.infer<typeof ActionStatus>

  export const RetryPolicy = z
    .object({
      max: z.number().int().min(0).default(0),
      backoff: z.enum(["none", "linear", "exponential"]).default("none"),
    })
    .strict()
    .meta({ ref: "HarnessRetryPolicy" })
  export type RetryPolicy = z.infer<typeof RetryPolicy>

  export const ActionRecord = z
    .object({
      id: z.string(),
      run_id: z.string(),
      graph_id: z.string(),
      kind: z.literal("act"),
      type: z.string().default("task"),
      title: z.string(),
      status: ActionStatus.default("ready"),
      depends_on: z.array(z.string()).default([]),
      criteria: z.array(z.string()).default([]),
      failure: z.string().optional(),
      gate: z.string().optional(),
      budget: z.record(z.string(), z.unknown()).default({}),
      visibility: Visibility.default("project"),
      expected_artifacts: z.array(Ref).default([]),
      idempotency_key: z.string().optional(),
      resource_locks: z.array(Ref).default([]),
      cancellation: z
        .object({
          allowed: z.boolean().default(true),
          reason: z.string().optional(),
        })
        .strict()
        .default({ allowed: true }),
      retry_policy: RetryPolicy.default({ max: 0, backoff: "none" }),
      created_at: z.number(),
      updated_at: z.number(),
    })
    .strict()
    .meta({ ref: "HarnessActionRecord" })
  export type ActionRecord = z.infer<typeof ActionRecord>

  export const ActionEdge = z
    .object({
      run_id: z.string(),
      graph_id: z.string(),
      from: z.string(),
      to: z.string(),
      kind: z.enum(["depends_on"]).default("depends_on"),
    })
    .strict()
    .meta({ ref: "HarnessActionEdge" })
  export type ActionEdge = z.infer<typeof ActionEdge>

  export const ActionGraph = z
    .object({
      id: z.string(),
      run_id: z.string(),
      schema_version: SchemaVersion.default("v2.0"),
      status: z.enum(["active", "completed", "blocked", "failed", "cancelled"]).default("active"),
      created_at: z.number(),
      updated_at: z.number(),
    })
    .strict()
    .meta({ ref: "HarnessActionGraph" })
  export type ActionGraph = z.infer<typeof ActionGraph>

  export const ActionAccept = z
    .object({
      id: z.string().optional(),
      kind: z.literal("act"),
      type: z.string().default("task"),
      title: z.string(),
      status: ActionStatus.default("ready"),
      depends_on: z.array(z.string()).default([]),
      criteria: z.array(z.string()).default([]),
      failure: z.string().optional(),
      gate: z.string().optional(),
      budget: z.record(z.string(), z.unknown()).default({}),
      visibility: Visibility.default("project"),
      expected_artifacts: z.array(Ref).default([]),
      idempotency_key: z.string().optional(),
      resource_locks: z.array(Ref).default([]),
      cancellation: z
        .object({
          allowed: z.boolean().default(true),
          reason: z.string().optional(),
        })
        .strict()
        .default({ allowed: true }),
      retry_policy: RetryPolicy.default({ max: 0, backoff: "none" }),
    })
    .strict()
    .meta({ ref: "HarnessActionAccept" })
  export type ActionAccept = z.infer<typeof ActionAccept>

  export const ActionGraphProjection = z
    .object({
      graph: ActionGraph,
      nodes: z.array(ActionRecord),
      edges: z.array(ActionEdge),
      blocked: z.array(
        z
          .object({
            id: z.string(),
            reason: z.string(),
          })
          .strict(),
      ),
      ready: z.array(z.string()),
      source_events: z.number().int().min(0),
    })
    .strict()
    .meta({ ref: "HarnessActionGraphProjection" })
  export type ActionGraphProjection = z.infer<typeof ActionGraphProjection>

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
        "action.accept",
        "action.cancel",
        "action.retry",
        "resource.write",
        "resource.tombstone",
        "task.retry",
        "task.cancel",
        "decision.answer",
        "verify.rerun",
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
      decisions: z.array(Decision),
      events: z.array(Event),
      graph: ActionGraph.optional(),
      actions: z.array(ActionRecord).default([]),
      edges: z.array(ActionEdge).default([]),
      resources: z.array(ResourceRecord).default([]),
      contexts: z.array(ContextBundle).default([]),
      agent_sessions: z.array(AgentSessionRecord).default([]),
    })
    .strict()
    .meta({ ref: "HarnessSummary" })
  export type Summary = z.infer<typeof Summary>
}
