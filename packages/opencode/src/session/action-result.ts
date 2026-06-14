import z from "zod"

export namespace ActionResult {
  export const TOOL = "ActionResult"

  const Base = z.object({
    kind: z.literal("action_result").default("action_result"),
    action_id: z.string().min(1),
    result: z.string().min(1),
  })

  export const Worker = Base.extend({
    role: z.literal("worker"),
    status: z.enum(["success", "failure", "error", "reply"]),
    scope: z.enum(["task", "verification_feedback", "final_summary"]).default("task"),
    task_background: z.string().optional(),
    task_content: z.string().optional(),
    changed_files: z.string().default(""),
    verification: z.string().default(""),
    blockers: z.string().default(""),
  })

  export const Verifier = Base.extend({
    role: z.literal("verifier"),
    target_action_id: z.string().min(1),
    verification_role: z.enum(["test", "review"]).optional(),
    status: z.enum(["pass", "fail", "error", "reply", "skipped"]),
    issues: z.string().default(""),
    evidence: z.string().default(""),
    worker_feedback: z.string().default(""),
  })

  export const Schema = z.preprocess(
    (input) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) return input
      const obj = input as Record<string, unknown>
      if (typeof obj.result === "string" && obj.result.trim().length > 0) return input
      if (typeof obj.summary === "string" && obj.summary.trim().length > 0) return { ...obj, result: obj.summary }
      return input
    },
    z.discriminatedUnion("role", [Worker, Verifier]),
  )
  export type Value = z.infer<typeof Schema>

  export function parse(input: unknown) {
    return Schema.safeParse(input)
  }

  export function output(input: Value) {
    return JSON.stringify(input, null, 2)
  }

  export function pass(input: Value) {
    if (input.role !== "verifier") return false
    return input.status === "pass" || input.status === "skipped"
  }

  export function protocol(input: { verifier?: boolean; action?: string; target?: string } = {}) {
    const sample = input.verifier
      ? {
          role: "verifier",
          action_id: input.action ?? "verify_action",
          target_action_id: input.target ?? "worker_action",
          status: "pass",
          result: "Verification passed.",
          evidence: "Checks or review evidence.",
          issues: "none",
          worker_feedback: "none",
        }
      : {
          role: "worker",
          action_id: input.action ?? "assigned_action",
          status: "success",
          result: "Task completed.",
          task_background: "Why this task was assigned.",
          task_content: "What you were asked to do.",
          changed_files: "none",
          verification: "Commands, checks, or evidence.",
          blockers: "none",
        }
    return [
      "ActionResult protocol:",
      "Call the native ActionResult tool exactly once with direct JSON arguments.",
      "Do not wrap the arguments in input, arguments, parameters, content, or any other field.",
      "The top-level JSON object must contain role.",
      "role selects the protocol branch: worker submits an assigned task result; verifier submits verification for target_action_id.",
      "Worker required fields: role, action_id, status, result.",
      "Worker status values: success, failure, error, reply.",
      "Verifier required fields: role, action_id, target_action_id, status, result.",
      "Verifier status values: pass, fail, error, reply, skipped.",
      "All descriptive fields must be short strings. Do not use arrays or nested objects.",
      "Valid direct ActionResult arguments example:",
      JSON.stringify(sample, null, 2),
    ]
  }
}
