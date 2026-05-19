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

  export const StepType = z
    .enum([
      "task",
      "research",
      "planning",
      "design",
      "implementation",
      "debug",
      "test",
      "review",
      "gate",
      "documentation",
      "build",
      "release",
      "decision",
      "manual",
      "recovery",
      "loop",
    ])
    .meta({ ref: "WorkflowStepType" })
  export type StepType = z.infer<typeof StepType>

  export const SessionPolicy = z.enum(["per_call", "per_loop", "per_attempt"]).meta({ ref: "WorkflowSessionPolicy" })
  export type SessionPolicy = z.infer<typeof SessionPolicy>

  export const Context = z
    .object({
      include: z.array(z.string().min(1)).default([]),
    })
    .strict()
    .meta({ ref: "WorkflowContext" })
  export type Context = z.infer<typeof Context>

  export const Memory = z
    .object({
      include: z.array(z.string().min(1)).default([]),
      summarize: z
        .object({
          when: z.string().min(1),
        })
        .strict()
        .optional(),
    })
    .strict()
    .meta({ ref: "WorkflowMemory" })
  export type Memory = z.infer<typeof Memory>

  export const Verification = z
    .object({
      required: z.boolean().default(false),
      must_pass: z.array(z.string().min(1)).default([]),
      commands: z.array(z.string().min(1)).default([]),
      artifacts: z.array(z.string().min(1)).default([]),
      notes: z.array(z.string().min(1)).default([]),
      justification: z.string().min(1).optional(),
    })
    .strict()
    .meta({ ref: "WorkflowVerification" })
  export type Verification = z.infer<typeof Verification>

  export const Step = z
    .object({
      id: z.string().min(1),
      description: z.string().min(1).optional().describe("Short task name for displaying workflow task sessions"),
      type: StepType.default("task"),
      capabilities: z.array(z.string().min(1)).default([]),
      agent: z.string().min(1).default("auto"),
      session: SessionPolicy.default("per_call"),
      context: Context.optional(),
      prompt: z.string().optional(),
      mutates: z.boolean().default(false),
      wait: z.enum(["user", "permission"]).optional(),
      inputs: z.record(z.string(), z.unknown()).default({}),
      outputs: z.record(z.string(), z.unknown()).default({}),
      guards: z.array(Guard).default([]),
      next: z.union([z.string().min(1), z.array(Branch).min(1)]).optional(),
      error_policy: ErrorPolicy.optional(),
      verification: Verification.optional(),
    })
    .strict()
    .meta({ ref: "WorkflowStep" })
  export type Step = z.infer<typeof Step>

  export const LoopStep = z
    .object({
      id: z.string().min(1),
      description: z.string().min(1).optional().describe("Short task name for displaying workflow task sessions"),
      type: StepType.default("task"),
      capabilities: z.array(z.string().min(1)).default([]),
      agent: z.string().min(1).default("auto"),
      session: SessionPolicy.default("per_call"),
      context: Context.optional(),
      prompt: z.string().optional(),
      mutates: z.boolean().default(false),
      wait: z.enum(["user", "permission"]).optional(),
      inputs: z.record(z.string(), z.unknown()).default({}),
      outputs: z.record(z.string(), z.unknown()).default({}),
      guards: z.array(Guard).default([]),
      error_policy: ErrorPolicy.optional(),
      verification: Verification.optional(),
    })
    .strict()
    .meta({ ref: "WorkflowLoopStep" })
  export type LoopStep = z.infer<typeof LoopStep>

  export const Loop = z
    .object({
      max_attempts: z.number().int().min(1).default(3),
      until: z.array(VariableGuard).min(1),
      memory: Memory.optional(),
      steps: z.array(LoopStep).min(1),
    })
    .strict()
    .superRefine((loop, ctx) => {
      const ids = new Set<string>()
      for (const step of loop.steps) {
        if (!ids.has(step.id)) {
          ids.add(step.id)
          continue
        }
        ctx.addIssue({
          code: "custom",
          path: ["steps"],
          message: `Duplicate workflow loop step id: ${step.id}`,
        })
      }
    })
    .meta({ ref: "WorkflowLoop" })
  export type Loop = z.infer<typeof Loop>

  export const Node = z
    .object({
      id: z.string().min(1),
      description: z.string().min(1).optional().describe("Short task name for displaying workflow task sessions"),
      type: StepType.default("task"),
      capabilities: z.array(z.string().min(1)).default([]),
      agent: z.string().min(1).default("auto"),
      session: SessionPolicy.default("per_call"),
      context: Context.optional(),
      prompt: z.string().optional(),
      mutates: z.boolean().default(false),
      wait: z.enum(["user", "permission"]).optional(),
      inputs: z.record(z.string(), z.unknown()).default({}),
      outputs: z.record(z.string(), z.unknown()).default({}),
      guards: z.array(Guard).default([]),
      depends_on: z.array(z.string().min(1)).default([]),
      error_policy: ErrorPolicy.optional(),
      verification: Verification.optional(),
      loop: Loop.optional(),
    })
    .strict()
    .superRefine((node, ctx) => {
      if (node.type !== "loop" && node.loop) {
        ctx.addIssue({
          code: "custom",
          path: ["loop"],
          message: `Workflow node ${node.id} must use type loop when loop is defined`,
        })
      }
      if (node.type === "loop" && !node.loop) {
        ctx.addIssue({
          code: "custom",
          path: ["loop"],
          message: `Workflow loop node ${node.id} must define loop`,
        })
      }
    })
    .meta({ ref: "WorkflowNode" })
  export type Node = z.infer<typeof Node>

  export const Definition = z
    .object({
      id: z.string().min(1),
      name: z.string().min(1).describe("Short workflow display name"),
      description: z.string().optional(),
      version: z.string().default("1"),
      inputs: z.record(z.string(), Input).default({}),
      outputs: z.record(z.string(), Output).default({}),
      error_policy: ErrorPolicy.default({ strategy: "abort", max_attempts: 1 }),
      steps: z.array(Step).default([]),
      nodes: z.array(Node).default([]),
    })
    .strict()
    .superRefine((workflow, ctx) => {
      if (workflow.steps.length === 0 && workflow.nodes.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["steps"],
          message: "Workflow must define steps or nodes",
        })
      }
      if (workflow.steps.length > 0 && workflow.nodes.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes"],
          message: "Workflow cannot define both steps and nodes",
        })
      }
      const items = workflow.nodes.length > 0 ? workflow.nodes : workflow.steps
      const path = workflow.nodes.length > 0 ? "nodes" : "steps"
      const ids = new Set<string>()
      const steps = new Map<string, Step | Node>()
      for (const item of items) {
        if (!ids.has(item.id)) {
          ids.add(item.id)
          steps.set(item.id, item)
          continue
        }
        ctx.addIssue({
          code: "custom",
          path: [path],
          message: `Duplicate workflow node id: ${item.id}`,
        })
      }

      for (const [index, step] of items.entries()) {
        if (!step.verification) continue
        if (
          step.verification.required &&
          step.verification.must_pass.length === 0 &&
          !step.verification.justification
        ) {
          ctx.addIssue({
            code: "custom",
            path: [path, index, "verification"],
            message: `Workflow node ${step.id} requires verification but does not define must_pass or justification`,
          })
        }
        for (const ref of step.verification.must_pass) {
          const target = steps.get(ref)
          if (!target) {
            ctx.addIssue({
              code: "custom",
              path: [path, index, "verification", "must_pass"],
              message: `Workflow node ${step.id} references missing verification node: ${ref}`,
            })
            continue
          }
          if (target.id === step.id) {
            ctx.addIssue({
              code: "custom",
              path: [path, index, "verification", "must_pass"],
              message: `Workflow node ${step.id} cannot verify itself`,
            })
          }
          if (!["test", "review", "gate"].includes(target.type)) {
            ctx.addIssue({
              code: "custom",
              path: [path, index, "verification", "must_pass"],
              message: `Workflow node ${step.id} verification target ${target.id} must be a test, review, or gate node`,
            })
          }
        }
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
