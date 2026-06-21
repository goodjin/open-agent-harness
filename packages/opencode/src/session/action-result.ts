import z from "zod"

export namespace ActionResult {
  export const TOOL = "ActionResult"
  const Status = z.preprocess(
    (input) => (input === "pass" ? "success" : input === "fail" ? "failure" : input),
    z.enum(["success", "failure", "error", "reply", "skipped"]),
  )

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
    status: Status,
    scope: z.enum(["task", "verification_feedback", "final_summary"]).default("task"),
    changed_files: z.string().default(""),
    verification: z.string().default(""),
    blockers: z.string().default(""),
  }).strict()

  export const Verifier = Internal.extend({
    role: z.literal("verifier"),
    target_action_id: z.string().min(1),
    status: Status,
    issues: z.string().default(""),
    evidence: z.string().default(""),
    worker_feedback: z.string().default(""),
  }).strict()

  export const WorkerInput = Input.extend({
    status: Status,
    scope: z.enum(["task", "verification_feedback", "final_summary"]).default("task"),
    changed_files: z.string().default(""),
    verification: z.string().default(""),
    blockers: z.string().default(""),
  })

  export const VerifierInput = Input.extend({
    target_action_id: z.string().min(1),
    status: Status,
    issues: z.string().default(""),
    evidence: z.string().default(""),
    worker_feedback: z.string().default(""),
  })

  export const Schema = z.union([
    VerifierInput.transform((input) => Verifier.parse({ ...input, role: "verifier" })),
    WorkerInput.transform((input) => Worker.parse({ ...input, role: "worker" })),
  ])
  export const WorkerSchema = WorkerInput.transform((input) => Worker.parse({ ...input, role: "worker" }))
  export const VerifierSchema = VerifierInput.transform((input) => Verifier.parse({ ...input, role: "verifier" }))
  export type Value = z.infer<typeof Schema>

  export function parse(input: unknown) {
    return Schema.safeParse(input)
  }

  export function worker(input: unknown) {
    return WorkerSchema.safeParse(input)
  }

  export function verifier(input: unknown) {
    return VerifierSchema.safeParse(input)
  }

  export function stored(input: unknown) {
    return z.union([Worker, Verifier]).safeParse(input)
  }

  export function output(input: Value) {
    return JSON.stringify(input, null, 2)
  }

  export function pass(input: Value) {
    if (input.role !== "verifier") return false
    return input.status === "success" || input.status === "skipped"
  }

  export function sample(input: { verifier?: boolean; action?: string; target?: string } = {}) {
    if (input.verifier)
      return {
        action_id: input.action ?? "verify_action",
        target_action_id: input.target ?? "worker_action",
        status: "success",
        result: "Verification passed.",
        evidence: "Checks or review evidence.",
        issues: "none",
        worker_feedback: "none",
      }
    return {
      action_id: input.action ?? "assigned_action",
      status: "success",
      result: "Task completed.",
      changed_files: "none",
      verification: "Commands, checks, or evidence.",
      blockers: "none",
    }
  }

  export function protocol(input: { verifier?: boolean; action?: string; target?: string } = {}) {
    return [
      "ActionResult protocol:",
      "Call the native ActionResult tool exactly once with direct JSON arguments.",
      "Do not wrap the arguments in input, arguments, parameters, content, or any other field.",
      "Status values for all results: success, failure, error, reply, skipped.",
      "Worker result required fields: action_id, status, result.",
      "Worker optional fields: scope, changed_files, verification, blockers.",
      "Worker scope values: task, verification_feedback, final_summary.",
      "Verifier result required fields: action_id, target_action_id, status, result.",
      "Verifier optional fields: issues, evidence, worker_feedback.",
      "All non-status fields must be plain strings. Do not use arrays or nested objects.",
      "Valid direct ActionResult arguments example:",
      JSON.stringify(sample(input), null, 2),
    ]
  }
}
