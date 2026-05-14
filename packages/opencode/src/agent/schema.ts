import z from "zod"

export namespace AgentTemplate {
  // Workflow mode for agent execution
  export const WorkflowMode = z.enum(["auto", "manual", "supervision"])
  export type WorkflowMode = z.infer<typeof WorkflowMode>

  // Permission mode for agent
  export const PermissionMode = z.enum(["strict", "lax", "custom"])
  export type PermissionMode = z.infer<typeof PermissionMode>

  // Model preference - which model the agent prefers to use
  export const ModelPreference = z.object({
    providerID: z.string().describe("Provider ID (e.g., anthropic, openai)"),
    modelID: z.string().describe("Model ID (e.g., claude-sonnet-4-20250514)"),
  })
  export type ModelPreference = z.infer<typeof ModelPreference>

  // meta.json schema for agent template
  export const Meta = z.object({
    // Required fields - must be non-empty strings
    id: z.string().min(1).describe("Unique identifier for the agent"),
    name: z.string().min(1).describe("Display name of the agent"),
    role: z.string().min(1).describe("Role definition for the agent"),
    description: z.string().min(1).describe("Description of what the agent does"),

    // Optional fields
    model_preference: ModelPreference.optional().describe("Preferred model configuration"),
    workflow_mode: WorkflowMode.optional().describe("How the agent executes workflows"),
    allowed_tools: z.array(z.string()).optional().describe("List of tools the agent is allowed to use"),
    denied_tools: z.array(z.string()).optional().describe("List of tools the agent is denied from using"),
    inherit_permissions: z.boolean().optional().describe("Whether to inherit permissions from parent agent"),
    permission_mode: PermissionMode.optional().describe("Permission mode for the agent"),
  })
  export type Meta = z.infer<typeof Meta>

  // Type exports
  export type RequiredFields = Pick<Meta, "id" | "name" | "role" | "description">
  export type OptionalFields = Pick<Meta, "model_preference" | "workflow_mode" | "allowed_tools" | "denied_tools" | "inherit_permissions" | "permission_mode">
}
