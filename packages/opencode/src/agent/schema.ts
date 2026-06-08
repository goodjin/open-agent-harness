import z from "zod"

export namespace AgentTemplate {
  const Text = z.string().trim().min(1)

  // Workflow mode for agent execution
  export const WorkflowMode = z.enum(["auto", "manual", "supervision"])
  export type WorkflowMode = z.infer<typeof WorkflowMode>

  // Runtime mode controls how the agent is surfaced and invoked.
  export const RuntimeMode = z.enum(["primary", "subagent", "all"])
  export type RuntimeMode = z.infer<typeof RuntimeMode>

  // Runner controls which session runtime handles the agent.
  export const Runner = z.enum(["chat", "workflow", "protocol"])
  export type Runner = z.infer<typeof Runner>

  // Kind describes the agent's coarse collaboration role.
  export const Kind = z.enum(["planner", "worker", "verifier", "helper", "system", "skill"])
  export type Kind = z.infer<typeof Kind>

  export const Entry = z
    .object({
      primary: z.boolean().default(true),
      delegable: z.boolean().default(true),
      mentionable: z.boolean().default(true),
      default: z.boolean().default(true),
      hidden: z.boolean().default(false),
    })
    .strict()
  export type Entry = z.infer<typeof Entry>

  export const CapabilityCost = z.enum(["low", "medium", "high"])
  export type CapabilityCost = z.infer<typeof CapabilityCost>

  export const Capability = z
    .object({
      purpose: Text.default("general"),
      tags: z.array(Text).default([]),
      cost: CapabilityCost.default("medium"),
      writes: z.boolean().default(true),
    })
    .strict()
  export type Capability = z.infer<typeof Capability>

  export const EntryDefaults = {
    primary: {
      primary: true,
      delegable: true,
      mentionable: true,
      default: true,
      hidden: false,
    },
    subagent: {
      primary: false,
      delegable: true,
      mentionable: true,
      default: false,
      hidden: false,
    },
    all: {
      primary: true,
      delegable: true,
      mentionable: true,
      default: true,
      hidden: false,
    },
  } as const satisfies Record<RuntimeMode, Entry>

  export const CapabilityDefaults = {
    purpose: "general",
    tags: [],
    cost: "medium",
    writes: true,
  } as const satisfies Capability

  export const WorkflowDefaults = {
    auto: {
      autonomous: true,
      prompt: false,
      review_tools: false,
      review_state: false,
    },
    manual: {
      autonomous: false,
      prompt: true,
      review_tools: true,
      review_state: true,
    },
    supervision: {
      autonomous: true,
      prompt: false,
      review_tools: true,
      review_state: true,
    },
  } as const satisfies Record<
    WorkflowMode,
    {
      autonomous: boolean
      prompt: boolean
      review_tools: boolean
      review_state: boolean
    }
  >

  // Permission mode for agent
  export const PermissionMode = z.enum(["strict", "lax", "custom"])
  export type PermissionMode = z.infer<typeof PermissionMode>

  export const PermissionDefaults = {
    strict: {
      inherit: true,
      policy: "inherit",
      allowed: false,
      denied: true,
    },
    lax: {
      inherit: true,
      policy: "allow",
      allowed: false,
      denied: true,
    },
    custom: {
      inherit: true,
      policy: "custom",
      allowed: true,
      denied: true,
    },
  } as const satisfies Record<
    PermissionMode,
    {
      inherit: boolean
      policy: "inherit" | "allow" | "custom"
      allowed: boolean
      denied: boolean
    }
  >

  // Model preference - which model the agent prefers to use
  export const ModelPreference = z
    .object({
      providerID: Text.describe("Provider ID (e.g., anthropic, openai)"),
      modelID: Text.describe("Model ID (e.g., claude-sonnet-4-20250514)"),
    })
    .strict()
  export type ModelPreference = z.infer<typeof ModelPreference>

  const Dict = z.record(z.string(), z.unknown())

  export const Logo = z
    .object({
      uri: Text.describe("Logo URI"),
      alt: Text.optional().describe("Accessible logo label"),
      theme: z.enum(["light", "dark", "auto"]).optional().describe("Logo theme"),
      hash: Text.optional().describe("Logo integrity hash"),
    })
    .strict()
  export type Logo = z.infer<typeof Logo>

  export const Instructions = z
    .object({
      files: z
        .array(
          z
            .object({
              path: Text.describe("Instruction file path"),
              role: Text.optional().describe("Instruction message role"),
              position: z.enum(["prepend", "append"]).optional().describe("Where to place the instruction content"),
              required: z.boolean().default(false).describe("Whether the file is required"),
            })
            .strict(),
        )
        .default([]),
      model_messages: z
        .array(
          z
            .object({
              on: Text.describe("Runtime event name"),
              position: Text.describe("Message insertion position"),
              content: Text.describe("Message content"),
            })
            .strict(),
        )
        .default([]),
    })
    .strict()
  export type Instructions = z.infer<typeof Instructions>

  export const Contracts = z
    .object({
      input: z.array(Dict).default([]),
      output: z.array(Dict).default([]),
    })
    .strict()
  export type Contracts = z.infer<typeof Contracts>

  export const Collaboration = z
    .object({
      edges: z.array(Dict).default([]),
      limits: Dict.optional(),
    })
    .strict()
  export type Collaboration = z.infer<typeof Collaboration>

  export const RuntimeBoundary = z
    .object({
      resource_classes: z.array(Text).default([]),
      actions: z.record(z.string(), z.array(Text)).optional(),
      network: Dict.optional(),
      data: Dict.optional(),
      approval: Dict.optional(),
      rate_limits: Dict.optional(),
    })
    .strict()
  export type RuntimeBoundary = z.infer<typeof RuntimeBoundary>

  export const Completion = z
    .object({
      mode: Text.optional(),
      criteria: z.array(Text).default([]),
      required_artifacts: z.array(Text).default([]),
      required_evidence: z.array(Text).default([]),
      gates: z.array(Dict).default([]),
      allow_partial: z.boolean().optional(),
    })
    .strict()
  export type Completion = z.infer<typeof Completion>

  export const Observability = Dict
  export type Observability = z.infer<typeof Observability>

  export const Lifecycle = Dict
  export type Lifecycle = z.infer<typeof Lifecycle>

  export const Protocol = z
    .object({
      file: Text.describe("Protocol prompt file path relative to the agent directory"),
    })
    .strict()
  export type Protocol = z.infer<typeof Protocol>

  function normalize(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return input
    const meta = { ...input } as Record<string, unknown>
    if (typeof meta.role !== "string" && typeof meta.persona === "string") meta.role = meta.persona
    if (typeof meta.workflow_mode !== "string" && typeof meta.execution_mode === "string") meta.workflow_mode = meta.execution_mode
    if (meta.schema_version === "agent.metadata.v1" && !("inherit_permissions" in meta)) meta.inherit_permissions = false
    delete meta.persona
    delete meta.execution_mode
    return meta
  }

  // meta.json schema for agent template
  const Base = z
    .object({
      // Optional metadata control-plane fields
      schema_version: Text.optional().describe("Agent metadata schema version"),
      agent_version: Text.optional().describe("Agent behavior or configuration version"),
      kind: Kind.optional().describe("Coarse collaboration role for routing and catalog display"),
      logo: Logo.optional().describe("Agent display logo"),
      instructions: Instructions.optional().describe("Runtime instruction inputs"),
      auto_append_prompt: Text.optional().describe("Prompt text appended at the end of every model request for this agent"),
      contracts: Contracts.optional().describe("Input and output contracts"),
      collaboration: Collaboration.optional().describe("Agent collaboration policy"),
      runtime_boundary: RuntimeBoundary.optional().describe("Runtime boundary declaration"),
      completion: Completion.optional().describe("Completion contract"),
      observability: Observability.optional().describe("Observability policy"),
      lifecycle: Lifecycle.optional().describe("Lifecycle metadata"),
      protocol: Protocol.optional().describe("Protocol runner prompt configuration"),

      // Required fields - must be non-empty strings
      id: Text.describe("Unique identifier for the agent"),
      name: Text.describe("Display name of the agent"),
      role: Text.describe("Role definition for the agent"),
      description: Text.describe("Description of what the agent does"),

      // Optional fields with runtime defaults
      model_preference: ModelPreference.optional().describe("Preferred model configuration"),
      mode: RuntimeMode.optional().describe("How the agent can be invoked at runtime"),
      entry: Entry.optional().describe("Where the agent can be used"),
      capability: Capability.default(CapabilityDefaults).describe("What the agent is good for"),
      hidden: z.boolean().default(false).describe("Whether to hide the agent from interactive pickers"),
      runner: Runner.default("chat").describe("Which session runtime handles this agent"),
      workflow_mode: WorkflowMode.default("auto").describe("How the agent executes workflows"),
      allowed_tools: z.array(Text).default([]).describe("List of tools the agent is allowed to use"),
      denied_tools: z.array(Text).default([]).describe("List of tools the agent is denied from using"),
      inherit_permissions: z.boolean().default(false).describe("Whether to inherit permissions from parent agent"),
      permission_mode: PermissionMode.default("strict").describe("Permission mode for the agent"),
    })
    .strict()
  export const MetaInput = z.preprocess(normalize, Base)
  export const Meta = MetaInput.transform((meta) => ({
    ...meta,
    entry: meta.entry ?? {
      ...EntryDefaults[meta.mode ?? "primary"],
      hidden: meta.hidden,
    },
  }))
  export type Meta = z.infer<typeof Meta>
  export type MetaInput = Omit<z.input<typeof Base>, "role" | "workflow_mode"> & {
    role?: string
    persona?: string
    workflow_mode?: WorkflowMode
    execution_mode?: WorkflowMode
  }

  export type ModelCatalog = Record<string, readonly string[] | Record<string, unknown>>

  export function validateModel(meta: Meta, catalog: ModelCatalog): string[] {
    if (!meta.model_preference) return []
    const models = catalog[meta.model_preference.providerID]
    if (!models) return [`Unknown provider: ${meta.model_preference.providerID}`]
    const ok = Array.isArray(models) ? models.includes(meta.model_preference.modelID) : meta.model_preference.modelID in models
    if (ok) return []
    return [`Unknown model: ${meta.model_preference.providerID}/${meta.model_preference.modelID}`]
  }

  export function workflow(meta: Pick<Meta, "workflow_mode">) {
    return WorkflowDefaults[meta.workflow_mode]
  }

  export function permission(meta: Pick<Meta, "permission_mode" | "inherit_permissions" | "allowed_tools" | "denied_tools">) {
    const cfg = PermissionDefaults[meta.permission_mode]
    return {
      inherit: cfg.inherit && meta.inherit_permissions,
      policy: cfg.policy,
      allowed_tools: cfg.allowed ? meta.allowed_tools : [],
      denied_tools: cfg.denied ? meta.denied_tools : [],
    }
  }

  export function validateTemplate(input: { dir: string; meta: Meta }): string[] {
    const dir = input.dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? input.dir
    if (dir === input.meta.id) return []
    return [`Agent id '${input.meta.id}' must match directory '${dir}'`]
  }

  export function validateRegistry(input: readonly { dir: string; meta: Meta }[]): string[] {
    const seen = new Map<string, string>()
    return input.flatMap((item) => {
      const prev = seen.get(item.meta.id)
      if (prev) return [`Duplicate agent id '${item.meta.id}' in '${prev}' and '${item.dir}'`]
      seen.set(item.meta.id, item.dir)
      return []
    })
  }

  // Type exports
  export type RequiredFields = Pick<Meta, "id" | "name" | "role" | "description">
  export function mode(meta: Pick<Meta, "entry" | "mode">): RuntimeMode {
    if (meta.mode && Object.entries(EntryDefaults[meta.mode]).every(([key, value]) => meta.entry[key as keyof Entry] === value)) {
      return meta.mode
    }
    if (!meta.entry.primary) return "subagent"
    if (meta.entry.delegable) return "all"
    return "primary"
  }

  export type OptionalFields = Pick<Meta, "schema_version" | "agent_version" | "kind" | "logo" | "model_preference" | "mode" | "entry" | "capability" | "hidden" | "runner" | "workflow_mode" | "allowed_tools" | "denied_tools" | "inherit_permissions" | "permission_mode" | "instructions" | "auto_append_prompt" | "contracts" | "collaboration" | "runtime_boundary" | "completion" | "observability" | "lifecycle" | "protocol">
}
