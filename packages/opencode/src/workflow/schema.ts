import z from "zod"

export namespace Workflow {
  export const Input = z
    .object({
      type: z.enum(["string", "number", "boolean", "object"]).default("string"),
      required: z.boolean().default(false),
      default: z.unknown().optional(),
    })
    .strict()
    .meta({ ref: "WorkflowInput" })
  export type Input = z.infer<typeof Input>

  export const Output = z
    .object({
      from: z.string().optional(),
    })
    .strict()
    .meta({ ref: "WorkflowOutput" })
  export type Output = z.infer<typeof Output>

  export const VariableGuard = z
    .object({
      type: z.literal("variable"),
      name: z.string().min(1),
      exists: z.boolean().optional(),
      equals: z.unknown().optional(),
    })
    .strict()
    .meta({ ref: "WorkflowVariableGuard" })

  export const PermissionGuard = z
    .object({
      type: z.literal("permission"),
      permission: z.string().min(1),
      pattern: z.string().min(1).default("*"),
    })
    .strict()
    .meta({ ref: "WorkflowPermissionGuard" })

  export const Guard = z.discriminatedUnion("type", [VariableGuard, PermissionGuard]).meta({ ref: "WorkflowGuard" })
  export type Guard = z.infer<typeof Guard>

  export const Branch = z
    .object({
      step: z.string().min(1),
      guards: z.array(Guard).default([]),
    })
    .strict()
    .meta({ ref: "WorkflowBranch" })
  export type Branch = z.infer<typeof Branch>

  export const ErrorPolicy = z
    .object({
      strategy: z.enum(["abort", "continue", "retry"]).default("abort"),
      max_attempts: z.number().int().min(1).default(1),
    })
    .strict()
    .meta({ ref: "WorkflowErrorPolicy" })
  export type ErrorPolicy = z.infer<typeof ErrorPolicy>

  export const Step = z
    .object({
      id: z.string().min(1),
      agent: z.string().min(1).default("primary"),
      prompt: z.string().optional(),
      mutates: z.boolean().default(false),
      wait: z.enum(["user", "permission"]).optional(),
      inputs: z.record(z.string(), z.unknown()).default({}),
      outputs: z.record(z.string(), z.unknown()).default({}),
      guards: z.array(Guard).default([]),
      next: z.union([z.string().min(1), z.array(Branch).min(1)]).optional(),
      error_policy: ErrorPolicy.optional(),
    })
    .strict()
    .meta({ ref: "WorkflowStep" })
  export type Step = z.infer<typeof Step>

  export const Definition = z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string().optional(),
      version: z.string().default("1"),
      inputs: z.record(z.string(), Input).default({}),
      outputs: z.record(z.string(), Output).default({}),
      error_policy: ErrorPolicy.default({ strategy: "abort", max_attempts: 1 }),
      steps: z.array(Step).min(1),
    })
    .strict()
    .superRefine((workflow, ctx) => {
      const ids = new Set<string>()
      for (const step of workflow.steps) {
        if (!ids.has(step.id)) {
          ids.add(step.id)
          continue
        }
        ctx.addIssue({
          code: "custom",
          path: ["steps"],
          message: `Duplicate workflow step id: ${step.id}`,
        })
      }
    })
    .meta({ ref: "WorkflowDefinition" })
  export type Definition = z.infer<typeof Definition>

  export const Summary = z
    .object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      version: z.string(),
      source: z.enum(["package", "user"]),
      path: z.string(),
    })
    .meta({ ref: "WorkflowSummary" })
  export type Summary = z.infer<typeof Summary>
}
