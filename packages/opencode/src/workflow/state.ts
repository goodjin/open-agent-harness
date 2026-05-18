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
