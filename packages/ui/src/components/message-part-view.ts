import type { Part as PartType } from "@open-agent-harness/sdk/v2"

const tools = new Set(["todowrite", "todoread"])

export type PartView =
  | {
      kind: "visible"
    }
  | {
      kind: "collapsed"
      reason: "ignored_text" | "reasoning"
    }
  | {
      kind: "hidden"
    }

export function partView(part: PartType, showReasoningSummaries = true): PartView {
  if (part.type === "tool") {
    if (tools.has(part.tool)) return { kind: "hidden" }
    if (part.tool === "question" && (part.state.status === "pending" || part.state.status === "running"))
      return { kind: "hidden" }
    return { kind: "visible" }
  }
  if (part.type === "text") {
    if (!part.text?.trim()) return { kind: "hidden" }
    if (part.ignored) return { kind: "collapsed", reason: "ignored_text" }
    return { kind: "visible" }
  }
  if (part.type === "reasoning") {
    if (!part.text?.trim()) return { kind: "hidden" }
    if (!showReasoningSummaries) return { kind: "collapsed", reason: "reasoning" }
    return { kind: "visible" }
  }
  return { kind: "visible" }
}
