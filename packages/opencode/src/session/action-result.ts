import z from "zod"

export namespace ActionResult {
  export const TOOL = "ActionResult"

  const Internal = z.object({
    kind: z.literal("action_result").default("action_result"),
    action_id: z.string().min(1),
    result: z.string().min(1),
  })

  const Input = z.object({
    action_id: z.string().min(1),
    result: z.string().min(1),
  })

  export const Worker = Internal.extend({
    role: z.literal("worker"),
    status: z.enum(["success", "failure", "error", "reply"]),
    scope: z.enum(["task", "verification_feedback", "final_summary"]).default("task"),
    changed_files: z.string().default(""),
    verification: z.string().default(""),
    blockers: z.string().default(""),
  }).strict()

  export const Verifier = Internal.extend({
    role: z.literal("verifier"),
    target_action_id: z.string().min(1),
    status: z.enum(["pass", "fail", "error", "reply", "skipped"]),
    issues: z.string().default(""),
    evidence: z.string().default(""),
    worker_feedback: z.string().default(""),
  }).strict()

  const WorkerInput = Input.extend({
    status: z.enum(["success", "failure", "error", "reply"]),
    scope: z.enum(["task", "verification_feedback", "final_summary"]).default("task"),
    changed_files: z.string().default(""),
    verification: z.string().default(""),
    blockers: z.string().default(""),
  })

  const VerifierInput = Input.extend({
    target_action_id: z.string().min(1),
    status: z.enum(["pass", "fail", "error", "reply", "skipped"]),
    issues: z.string().default(""),
    evidence: z.string().default(""),
    worker_feedback: z.string().default(""),
  })

  export const Schema = z.union([
    VerifierInput.transform((input) => Verifier.parse({ ...input, role: "verifier" })),
    WorkerInput.transform((input) => Worker.parse({ ...input, role: "worker" })),
  ])
  export type Value = z.infer<typeof Schema>

  export function parse(input: unknown) {
    return Schema.safeParse(input)
  }

  export function stored(input: unknown) {
    return z.union([Worker, Verifier]).safeParse(input)
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
          action_id: input.action ?? "verify_action",
          target_action_id: input.target ?? "worker_action",
          status: "pass",
          result: "Verification passed.",
          evidence: "Checks or review evidence.",
          issues: "none",
          worker_feedback: "none",
        }
      : {
          action_id: input.action ?? "assigned_action",
          status: "success",
          result: "Task completed.",
          changed_files: "none",
          verification: "Commands, checks, or evidence.",
          blockers: "none",
        }
    return [
      "ActionResult protocol:",
      "Call the native ActionResult tool exactly once with direct JSON arguments.",
      "Do not wrap the arguments in input, arguments, parameters, content, or any other field.",
      "Worker result required fields: action_id, status, result.",
      "Worker status values: success, failure, error, reply.",
      "Worker optional fields: scope, changed_files, verification, blockers.",
      "Worker scope values: task, verification_feedback, final_summary.",
      "Verifier result required fields: action_id, target_action_id, status, result.",
      "Verifier status values: pass, fail, error, reply, skipped.",
      "Verifier optional fields: issues, evidence, worker_feedback.",
      "All non-status fields must be plain strings. Do not use arrays or nested objects.",
      "Valid direct ActionResult arguments example:",
      JSON.stringify(sample, null, 2),
    ]
  }
}
