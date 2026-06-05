import z from "zod"

export namespace Harness {
  export const SchemaVersion = z.literal("v2.0")
  export type SchemaVersion = z.infer<typeof SchemaVersion>

  export const ObjectCategory = z.enum(["fact", "view", "evidence", "resource", "context", "policy"])
  export type ObjectCategory = z.infer<typeof ObjectCategory>

  export const Visibility = z.enum(["private", "project", "team", "public"])
  export type Visibility = z.infer<typeof Visibility>

  export const Lifecycle = z.enum(["draft", "active", "archived", "tombstoned"])
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
    
  export type Producer = z.infer<typeof Producer>

  export const RefKind = z
    .enum(["resource", "document", "artifact", "action", "handoff", "trace", "projection", "memory", "snapshot"])
    
  export type RefKind = z.infer<typeof RefKind>

  export const Ref = z
    .string()
    .regex(/^(resource|document|artifact|action|handoff|trace|projection|memory|snapshot):\/\/[A-Za-z0-9._~:/-]+$/)
    
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
    
  export type Object = z.infer<typeof Object>

  export const ResourceObject = Object.extend({
    category: z.literal("resource"),
    uri: z.string(),
    media_type: z.string().optional(),
    evidence: z.array(Ref).default([]),
  })
    .strict()
    
  export type ResourceObject = z.infer<typeof ResourceObject>

  export const ResourceKind = z
    .enum(["tool_output", "model_long_output", "review_report", "test_report", "research_note", "handoff_state", "context_snapshot", "document"])
    
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
    
  export type ResourceSessionPart = z.infer<typeof ResourceSessionPart>

  export const ResourceRead = z
    .object({
      resource: ResourceRecord,
      body: z.string(),
    })
    .strict()
    
  export type ResourceRead = z.infer<typeof ResourceRead>

  export const ResourcePreview = z
    .object({
      resource: ResourceRecord,
      preview: z.string(),
      truncated: z.boolean(),
    })
    .strict()
    
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
    
  export type ContextObject = z.infer<typeof ContextObject>

  export const RefExpansionMode = z.enum(["summary", "structured", "full", "on_failure", "on_demand", "adaptive"])
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
    
  export type ContextRecord = z.infer<typeof ContextRecord>

  export const ContextExcludedRecord = z
    .object({
      ref: Ref,
      mode: RefExpansionMode,
      visibility: Visibility.optional(),
      reason: z.string(),
    })
    .strict()
    
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
    
  export type ContextPreview = z.infer<typeof ContextPreview>

  export const MemoryObject = Object.extend({
    category: z.literal("fact"),
    scope: z.enum(["run", "project", "team", "global"]),
    namespace: z.string(),
    status: z.enum(["candidate", "current", "historical", "superseded", "rejected"]).default("candidate"),
    evidence: z.array(Ref).default([]),
  })
    .strict()
    
  export type MemoryObject = z.infer<typeof MemoryObject>

  export const MemoryScope = z.enum(["run", "project", "team", "global"])
  export type MemoryScope = z.infer<typeof MemoryScope>

  export const MemoryStatus = z.enum(["candidate", "current", "historical", "superseded", "rejected"])
  export type MemoryStatus = z.infer<typeof MemoryStatus>

  export const MemoryFreshness = z.enum(["current", "stale", "historical"])
  export type MemoryFreshness = z.infer<typeof MemoryFreshness>

  export const MemoryRecord = z
    .object({
      id: z.string(),
      uri: Ref,
      run_id: z.string().optional(),
      summary: z.string(),
      scope: MemoryScope,
      namespace: z.string(),
      source_refs: z.array(Ref).default([]),
      evidence_refs: z.array(Ref).default([]),
      visibility: Visibility.default("project"),
      status: MemoryStatus.default("candidate"),
      freshness: MemoryFreshness.default("current"),
      created_at: z.number(),
      updated_at: z.number(),
    })
    .strict()
    
  export type MemoryRecord = z.infer<typeof MemoryRecord>

  export const MemoryWrite = MemoryRecord.omit({ id: true, uri: true, status: true, created_at: true, updated_at: true })
    .extend({ status: MemoryStatus.default("candidate") })
    .strict()
    
  export type MemoryWrite = z.infer<typeof MemoryWrite>

  export const MemoryPromotionInput = z
    .object({
      acceptance_id: z.string(),
    })
    .strict()
    
  export type MemoryPromotionInput = z.infer<typeof MemoryPromotionInput>

  export const MemoryContextInput = z
    .object({
      goal: z.string(),
      namespace: z.string(),
      memory_refs: z.array(Ref).default([]),
      token_budget: z.number().int().nonnegative().default(4000),
      visibility: Visibility.default("project"),
    })
    .strict()
    
  export type MemoryContextInput = z.infer<typeof MemoryContextInput>

  export const AgentKind = z.enum(["planner", "worker", "verifier", "helper"])
  export type AgentKind = z.infer<typeof AgentKind>

  export const AgentEntry = z
    .object({
      primary: z.boolean().default(false),
      delegable: z.boolean().default(true),
      mentionable: z.boolean().default(true),
    })
    .strict()
    
  export type AgentEntry = z.infer<typeof AgentEntry>

  export const AgentCapability = z
    .object({
      tags: z.array(z.string()).default([]),
      writes: z.boolean().default(false),
      cost: z.enum(["low", "medium", "high"]).default("medium"),
    })
    .strict()
    
  export type AgentCapability = z.infer<typeof AgentCapability>

  export const AgentPermission = z
    .object({
      tools: z.array(z.string()).default([]),
      scopes: z.array(z.enum(["private", "project", "team", "public"])).default(["project"]),
      write: z.boolean().default(false),
    })
    .strict()
    
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
    
  export type AgentAssignmentInput = z.infer<typeof AgentAssignmentInput>

  export const HandoffKind = z.enum(["assign", "handoff", "sync"])
  export type HandoffKind = z.infer<typeof HandoffKind>

  export const HandoffParty = z
    .object({
      type: z.enum(["user", "agent", "runtime", "system"]),
      id: z.string(),
      assignment_id: z.string().optional(),
      session_id: z.string().optional(),
    })
    .strict()
    
  export type HandoffParty = z.infer<typeof HandoffParty>

  export const HandoffRefs = z
    .object({
      handoff_ref: Ref,
      resource_refs: z.array(Ref).default([]),
      projection_ref: Ref.optional(),
      trace_ref: Ref.optional(),
      context_ref: Ref.optional(),
    })
    .strict()
    
  export type HandoffRefs = z.infer<typeof HandoffRefs>

  export const HandoffState = z.enum(["draft", "ready", "sent", "received", "blocked", "completed"])
  export type HandoffState = z.infer<typeof HandoffState>

  export const HandoffSelfReportState = z.enum(["draft", "ready", "partial", "sent", "received", "blocked", "completed"])
  export type HandoffSelfReportState = z.infer<typeof HandoffSelfReportState>

  export const HandoffRecord = z
    .object({
      id: z.string(),
      run_id: z.string(),
      kind: HandoffKind,
      uri: Ref,
      source: HandoffParty,
      target: HandoffParty,
      summary: z.string(),
      state: HandoffState.default("ready"),
      evidence: z.array(Ref).default([]),
      risks: z.array(z.string()).default([]),
      unresolved: z.array(z.string()).default([]),
      next: z.array(z.string()).default([]),
      refs: z.array(Ref).default([]),
      resource_refs: z.array(Ref).default([]),
      projection_ref: Ref.optional(),
      trace_ref: Ref.optional(),
      context_ref: Ref.optional(),
      created_at: z.number(),
      updated_at: z.number(),
    })
    .strict()
    
  export type HandoffRecord = z.infer<typeof HandoffRecord>

  export const HandoffWrite = HandoffRecord.omit({
    id: true,
    run_id: true,
    uri: true,
    refs: true,
    created_at: true,
    updated_at: true,
  })
    .extend({
      state: HandoffState.default("ready"),
      evidence: z.array(Ref).default([]),
      risks: z.array(z.string()).default([]),
      unresolved: z.array(z.string()).default([]),
      next: z.array(z.string()).default([]),
      resource_refs: z.array(Ref).default([]),
    })
    .strict()
    
  export type HandoffWrite = z.infer<typeof HandoffWrite>

  export const HandoffSourceInput = z
    .object({
      run_id: z.string(),
      session_id: z.string().optional(),
      assignment_id: z.string().optional(),
      agent_id: z.string().optional(),
    })
    .strict()

  export type HandoffSourceInput = z.infer<typeof HandoffSourceInput>

  export const HandoffTargetInput = z
    .object({
      executor: z.string(),
      capability: z.string(),
    })
    .strict()
    .default({ executor: "runtime", capability: "handoff" })

  export type HandoffTargetInput = z.infer<typeof HandoffTargetInput>

  export const HandoffCompatFact = z
    .object({
      text: z.string(),
      refs: z.array(Ref).default([]),
      confidence: z.enum(["raw", "evidenced", "inferred"]).default("raw"),
    })
    .strict()

  export type HandoffCompatFact = z.infer<typeof HandoffCompatFact>

  export const HandoffCompatArtifact = z
    .object({
      ref: Ref,
      type: z.string(),
      summary: z.string(),
      status: z.string().optional(),
    })
    .strict()

  export type HandoffCompatArtifact = z.infer<typeof HandoffCompatArtifact>

  export const HandoffCompatCreate = z
    .object({
      source: HandoffSourceInput,
      target: HandoffTargetInput,
      kind: z.enum(["assign", "handoff", "sync"]).default("handoff"),
      status: HandoffState.default("completed"),
      goal: z.string(),
      summary: z.string(),
      facts: z.array(HandoffCompatFact.omit({ confidence: true })).default([]),
      notes: z.array(z.string()).optional().default([]),
      artifacts: z.array(HandoffCompatArtifact).default([]),
      constraints: z.array(z.string()).default([]),
      risks: z.array(z.string()).default([]),
      unresolved: z.array(z.string()).default([]),
      next: z.array(z.unknown()).default([]),
      raw_refs: z.array(Ref).default([]),
      visibility: z
        .object({
          model: z.string(),
          user: z.string(),
          logs: z.string(),
          trace: z.string(),
          future_runs: z.string(),
        })
        .strict()
        .partial()
        .default({}),
      decisions: z.array(z.string()).default([]),
    })
    .strict()

  export type HandoffCompatCreate = z.infer<typeof HandoffCompatCreate>

  export const HandoffCompatCreateResult = z
    .object({
    type: z.literal("handoff"),
    version: z.literal("1"),
    id: z.string(),
    goal: z.string(),
    source: HandoffSourceInput,
    target: HandoffTargetInput,
    status: HandoffState,
    facts: z.array(HandoffCompatFact),
    notes: z.array(z.string()),
    artifacts: z.array(HandoffCompatArtifact),
    decisions: z.array(z.string()),
    constraints: z.array(z.string()),
    risks: z.array(z.string()).default([]),
    unresolved: z.array(z.string()).default([]),
    visibility: z.record(z.string(), z.string()),
    raw_refs: z.array(Ref),
    created_by: z.string(),
    created_at: z.number(),
    summary: z.string(),
    next: z.array(z.unknown()).default([]),
  })

  export type HandoffCompatCreateResult = z.infer<typeof HandoffCompatCreateResult>

  export const HandoffSourceBundle = z
    .object({
      type: z.literal("handoff.source"),
      run_id: z.string(),
      goal: z.string(),
      source: HandoffSourceInput,
      status: HandoffState.default("ready"),
      timeline: z
        .array(
          z
            .object({
              type: z.string(),
              summary: z.string().optional(),
              refs: z.array(Ref).default([]),
            })
            .strict(),
        )
        .default([]),
      artifacts: z.array(HandoffCompatArtifact).default([]),
      self_report: z
        .object({
          summary: z.string(),
          risks: z.array(z.string()).default([]),
        })
        .strict()
        .nullable()
        .default(null),
      raw_refs: z.array(Ref).default([]),
      created_at: z.number(),
    })
    .strict()

  export type HandoffSourceBundle = z.infer<typeof HandoffSourceBundle>

  export const HandoffPlan = z
    .object({
      run_id: z.string(),
      source: HandoffSourceInput,
      status: HandoffState.default("completed"),
      next: z.array(z.string()).default([]),
      prompt: z.string().optional(),
      trigger: z.boolean().optional(),
    })
    .strict()

  export type HandoffPlan = z.infer<typeof HandoffPlan>

  export const HandoffPlanResult = z
    .object({
      type: z.literal("handoff.plan"),
      trigger: z.boolean(),
      reasons: z.array(z.string()),
      status: HandoffState,
      request_self_report: z.boolean(),
      prompt: z.string(),
    })
    .strict()

  export type HandoffPlanResult = z.infer<typeof HandoffPlanResult>

  export const HandoffSelfReportRequest = z
    .object({
      source: HandoffSourceInput,
      status: HandoffSelfReportState.default("ready"),
      reasons: z.array(z.string()).default([]),
    })
    .strict()

  export type HandoffSelfReportRequest = z.infer<typeof HandoffSelfReportRequest>

  export const HandoffSelfReportResult = z
    .object({
      type: z.literal("handoff.self_report_request"),
      id: z.string(),
      prompt: z.string(),
    })
    .strict()

  export type HandoffSelfReportResult = z.infer<typeof HandoffSelfReportResult>

  export const Handoff = HandoffRecord
  export type Handoff = z.infer<typeof Handoff>

  export const HandoffContextInput = z
    .object({
      goal: z.string(),
      token_budget: z.number().int().nonnegative().default(4000),
      visibility: Visibility.default("project"),
    })
    .strict()
    
  export type HandoffContextInput = z.infer<typeof HandoffContextInput>

  export const AcceptanceLevel = z.enum(["none", "auto", "test", "agent", "human", "combined", "sampled"])
  export type AcceptanceLevel = z.infer<typeof AcceptanceLevel>

  export const AcceptanceGateResult = z
    .enum(["approved", "changes_requested", "needs_evidence", "needs_user_decision", "blocked", "waived"])
    
  export type AcceptanceGateResult = z.infer<typeof AcceptanceGateResult>

  export const AcceptanceTarget = z
    .object({
      type: z.enum(["run", "action_graph", "action", "assignment", "workflow_node", "resource"]),
      ref: Ref,
    })
    .strict()
    
  export type AcceptanceTarget = z.infer<typeof AcceptanceTarget>

  export const AcceptancePolicy = z
    .object({
      level: AcceptanceLevel,
      checks: z.array(z.string()).default([]),
      required: z.boolean().default(true),
      reviewer: z.string().optional(),
    })
    .strict()
    
  export type AcceptancePolicy = z.infer<typeof AcceptancePolicy>

  export const AcceptanceRecord = z
    .object({
      id: z.string(),
      run_id: z.string(),
      target: AcceptanceTarget,
      criteria: z.array(z.string()).default([]),
      policy: AcceptancePolicy,
      required: z.boolean().default(true),
      result: AcceptanceGateResult.optional(),
      evidence: z.array(Ref).default([]),
      reason: z.string().optional(),
      reviewer: z.string().optional(),
      created_at: z.number(),
      updated_at: z.number(),
    })
    .strict()
    
  export type AcceptanceRecord = z.infer<typeof AcceptanceRecord>

  export const AcceptanceBind = z
    .object({
      target: AcceptanceTarget,
      criteria: z.array(z.string()).default([]),
      policy: AcceptancePolicy,
      required: z.boolean().default(true),
    })
    .strict()
    
  export type AcceptanceBind = z.infer<typeof AcceptanceBind>

  export const AcceptancePolicyInput = z
    .object({
      criteria: z.array(z.string()).default([]),
      risk: z.enum(["low", "medium", "high"]).default("medium"),
      side_effects: z.array(z.string()).default([]),
      resource_scope: Visibility.optional(),
      artifact_type: z.string().optional(),
      agent_kind: AgentKind.optional(),
      permission: z.enum(["read", "write"]).default("read"),
      sample_rate: z.number().min(0).max(1).default(0),
    })
    .strict()
    
  export type AcceptancePolicyInput = z.infer<typeof AcceptancePolicyInput>

  export const AcceptanceResultInput = z
    .object({
      result: AcceptanceGateResult,
      evidence: z.array(Ref).default([]),
      reason: z.string().optional(),
      reviewer: z.string().optional(),
    })
    .strict()
    
  export type AcceptanceResultInput = z.infer<typeof AcceptanceResultInput>

  export const WorkflowObject = Object.extend({
    category: z.literal("policy"),
    version: z.number().int().min(1),
    nodes: z.array(Ref).default([]),
    criteria: z.array(z.string()).default([]),
  })
    .strict()
    
  export type WorkflowObject = z.infer<typeof WorkflowObject>

  export const WorkflowNodeProfile = z
    .object({
      id: z.string(),
      title: z.string(),
      type: z.string().default("task"),
      depends_on: z.array(z.string()).default([]),
      criteria: z.array(z.string()).default([]),
      failure: z.string().optional(),
      gate: z.string().optional(),
      loop: z.record(z.string(), z.unknown()).default({}),
      budget: z.record(z.string(), z.unknown()).default({}),
      artifacts: z.array(Ref).default([]),
      visibility: Visibility.default("project"),
      handoff: Ref.optional(),
    })
    .strict()
    
  export type WorkflowNodeProfile = z.infer<typeof WorkflowNodeProfile>

  export const WorkflowProfile = z
    .object({
      goal: z.string(),
      inputs_schema: z.record(z.string(), z.unknown()).default({}),
      nodes: z.array(WorkflowNodeProfile).default([]),
      depends_on: z.array(z.string()).default([]),
      criteria: z.array(z.string()).default([]),
      failure: z.string().optional(),
      gate: z.string().optional(),
      loop: z.record(z.string(), z.unknown()).default({}),
      budget: z.record(z.string(), z.unknown()).default({}),
      artifacts: z.array(Ref).default([]),
      visibility: Visibility.default("project"),
      handoff: Ref.optional(),
    })
    .strict()
    
  export type WorkflowProfile = z.infer<typeof WorkflowProfile>

  export const WorkflowAsset = z
    .object({
      id: z.string(),
      owner: z.string(),
      version: z.number().int().min(1).default(1),
      source: z.string(),
      visibility: Visibility.default("project"),
      profile: WorkflowProfile,
      created_at: z.number(),
      updated_at: z.number(),
    })
    .strict()
    
  export type WorkflowAsset = z.infer<typeof WorkflowAsset>

  export const WorkflowWrite = WorkflowAsset.omit({ id: true, created_at: true, updated_at: true })
    .extend({ version: z.number().int().min(1).default(1) })
    .strict()
    
  export type WorkflowWrite = z.infer<typeof WorkflowWrite>

  export const WorkflowSaveInput = z
    .object({
      owner: z.string(),
      source: z.string(),
      visibility: Visibility.default("project"),
    })
    .strict()
    
  export type WorkflowSaveInput = z.infer<typeof WorkflowSaveInput>

  export const WorkflowRunInput = z
    .object({
      inputs: z.record(z.string(), z.unknown()).default({}),
    })
    .strict()
    
  export type WorkflowRunInput = z.infer<typeof WorkflowRunInput>

  export const WorkflowRecoveryInput = z
    .object({
      op: z.enum(["inspect", "retry", "skip", "repair", "decision"]),
      reason: z.string().optional(),
    })
    .strict()
    
  export type WorkflowRecoveryInput = z.infer<typeof WorkflowRecoveryInput>

  export const PolicyObject = Object.extend({
    category: z.literal("policy"),
    rules: z.array(z.record(z.string(), z.string())).default([]),
  })
    .strict()
    
  export type PolicyObject = z.infer<typeof PolicyObject>

  export const V1Mapping = z
    .object({
      artifact: z.array(ObjectCategory),
      context: z.array(ObjectCategory),
      memory: z.array(ObjectCategory),
      workflow: z.array(ObjectCategory),
    })
    .strict()
    
  export type V1Mapping = z.infer<typeof V1Mapping>

  export const Status = z
    .enum(["drafting", "ready", "running", "paused", "blocked", "reviewing", "verifying", "reworking", "completed", "failed", "aborted"])
    
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
    
  export type TaskStatus = z.infer<typeof TaskStatus>

  export const DecisionStatus = z.enum(["pending", "answered", "rejected", "cancelled"])
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
    
  export type Gate = z.infer<typeof Gate>

  export const ActionStatus = z.enum(["ready", "blocked", "running", "completed", "failed", "cancelled"])
  export type ActionStatus = z.infer<typeof ActionStatus>

  export const RetryPolicy = z
    .object({
      max: z.number().int().min(0).default(0),
      backoff: z.enum(["none", "linear", "exponential"]).default("none"),
    })
    .strict()
    
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
        "handoff.plan",
        "handoff.self_report.request",
      ]),
      run_id: z.string().optional(),
      task_id: z.string().optional(),
      decision_id: z.string().optional(),
      concept_id: z.string().optional(),
      actor: z.string().default("user"),
      payload: z.record(z.string(), z.unknown()).default({}),
    })
    .strict()
    
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
      handoffs: z.array(HandoffRecord).default([]),
      acceptance: z.array(AcceptanceRecord).default([]),
    })
    .strict()
    
  export type Summary = z.infer<typeof Summary>
}
