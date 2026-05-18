import z from "zod"

export namespace WorkflowState {
  const Base = {
    step: z.string(),
    index: z.number().int().min(0),
    permission: z.string(),
    pattern: z.string(),
  }
  export const Guard = z
    .discriminatedUnion("type", [
      z
        .object({
          type: z.literal("step"),
          ...Base,
        })
        .strict(),
      z
        .object({
          type: z.literal("branch"),
          ...Base,
          branch: z.number().int().min(0),
        })
        .strict(),
    ])
    .meta({ ref: "WorkflowPauseGuard" })
  export type Guard = z.infer<typeof Guard>

  export const Pause = z
    .object({
      type: z.enum(["waiting_user", "waiting_permission"]),
      step: z.string(),
      reason: z.string().optional(),
      guard: Guard.optional(),
    })
    .strict()
    .meta({ ref: "WorkflowPause" })
  export type Pause = z.infer<typeof Pause>

  export const Node = z
    .object({
      step: z.string(),
      status: z.enum(["pending", "ready", "running", "completed", "error", "skipped", "cancelled"]),
      agent: z.string(),
      sessionID: z.string().optional(),
      path: z.string(),
      attempt: z.number().int().min(1),
      output: z.string().optional(),
      error: z.string().optional(),
      time: z.object({
        started: z.number(),
        updated: z.number(),
        completed: z.number().optional(),
      }),
    })
    .strict()
    .meta({ ref: "WorkflowNodeRun" })
  export type Node = z.infer<typeof Node>

  export const Status = z.enum(["pending", "ready", "running", "completed", "error", "skipped", "cancelled"])
  export type Status = z.infer<typeof Status>

  export const Step = z
    .object({
      id: z.string(),
      type: z.string(),
      agent: z.string(),
      prompt: z.string().optional(),
      mutates: z.boolean(),
      wait: z.string().optional(),
      inputs: z.record(z.string(), z.unknown()).default({}),
      outputs: z.record(z.string(), z.unknown()).default({}),
      guards: z.array(z.unknown()).default([]),
      depends_on: z.array(z.string()).default([]),
      next: z.unknown().optional(),
      verification: z.unknown().optional(),
    })
    .strict()
    .meta({ ref: "WorkflowRunStep" })
  export type Step = z.infer<typeof Step>

  export const Info = z
    .object({
      runID: z.string(),
      workflowID: z.string(),
      workflowName: z.string(),
      status: z.enum(["active", "completed", "waiting_user", "waiting_permission", "aborted", "error"]),
      current: z.string(),
      step: z.number().int().min(0),
      total: z.number().int().min(1),
      variables: z.record(z.string(), z.unknown()).default({}),
      attempts: z.record(z.string(), z.number()).default({}),
      completed: z.array(z.string()).default([]),
      steps: z.array(Step).default([]),
      nodes: z.record(z.string(), Node).default({}),
      statuses: z.record(z.string(), Status).default({}),
      pause: Pause.optional(),
      error: z.string().optional(),
      checkpoint: z.string().optional(),
      time: z.object({
        started: z.number(),
        updated: z.number(),
        completed: z.number().optional(),
      }),
    })
    .strict()
    .meta({ ref: "WorkflowRun" })
  export type Info = z.infer<typeof Info>

  export const Context = z
    .object({
      workflow: Info.optional(),
    })
    .passthrough()
  export type Context = z.infer<typeof Context>

  export function read(input: Record<string, unknown> | undefined) {
    const parsed = Context.safeParse(input ?? {})
    if (!parsed.success) return
    if (!parsed.data.workflow) return
    return parsed.data.workflow
  }

  export function write(input: Record<string, unknown> | undefined, state: Info | undefined) {
    const context = { ...(input ?? {}) }
    if (!state) {
      delete context.workflow
      return context
    }
    return {
      ...context,
      workflow: state,
    }
  }
}
