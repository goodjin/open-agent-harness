import { Memory } from "./schema"
import type { MessageV2 } from "@/session/message-v2"
import { MemoryFilter } from "./filter"

export namespace MemoryExtract {
  export const prompt = `Extract durable project memory from this session.
Return JSON only:
{
  "summary": "short durable summary",
  "topics": ["topic"]
}
Exclude secrets, temporary logs, and one-off command output.`

  const Output = Memory.Candidate

  function json(text: string) {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    return match ? match[1] : text
  }

  function words(text: string) {
    return text
      .toLowerCase()
      .split(/[^a-z0-9_/-]+/g)
      .filter((word) => word.length > 3 && word.length < 40)
  }

  export function parse(text: string) {
    return safe(text)
  }

  export function safe(text: string) {
    const parsed = safeJson(text)
    if (!parsed.ok) return parsed
    const result = Output.safeParse(parsed.value)
    if (!result.success) return { ok: false as const, error: result.error.message }
    return { ok: true as const, value: result.data }
  }

  function safeJson(text: string) {
    try {
      return { ok: true as const, value: JSON.parse(json(text)) as unknown }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "Malformed memory output" }
    }
  }

  export function from(input: MessageV2.WithParts[]): Memory.Candidate {
    const text = input
      .flatMap((msg) =>
        msg.parts.flatMap((part) => {
          if (part.type === "text" && MemoryFilter.keep(part.text)) return [part.text]
          if (part.type === "tool" && part.state.status === "completed" && MemoryFilter.keep(part.state.title))
            return [part.state.title]
          return []
        }),
      )
      .join("\n")
      .trim()
    const topics = [...new Set(words(text))]
      .filter((word) => !["this", "that", "with", "from", "have", "will", "what"].includes(word))
      .slice(0, 8)
    return {
      summary: text.slice(0, 1600) || "Session memory candidate",
      topics,
    }
  }
}
