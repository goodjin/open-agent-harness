import { AgentProtocol } from "./schema"

export namespace AgentProtocolParser {
  export type Parsed = {
    declaration: AgentProtocol.Declaration
    sections: Record<string, string>
    raw: string
  }

  export type Error = {
    code: "missing_block" | "multiple_blocks" | "invalid_json" | "invalid_schema"
    message: string
  }

  export type Result = { ok: true; value: Parsed } | { ok: false; error: Error }

  export function parse(text: string): Result {
    const json = direct(text)
    if (json) return read(text, undefined, "", json)
    const blocks = find(text)
    if (blocks.length === 0) return { ok: false, error: { code: "missing_block", message: "No agent protocol block found." } }
    if (blocks.length > 1) {
      return { ok: false, error: { code: "multiple_blocks", message: "Only one agent protocol block is allowed." } }
    }
    return read(text, blocks[0], text.replace(blocks[0]?.[0] ?? "", ""))
  }

  export function first(text: string): Result {
    const json = direct(text)
    if (json) return read(text, undefined, "", json)
    const blocks = find(text)
    if (blocks.length === 0) return { ok: false, error: { code: "missing_block", message: "No agent protocol block found." } }
    const block = blocks[0]
    const end = (block?.index ?? 0) + (block?.[0]?.length ?? 0)
    const tail = text.slice(end)
    const next = [tail.indexOf("<protocol-result>"), tail.indexOf("```json agent-protocol")]
      .filter((item) => item >= 0)
      .sort((a, b) => a - b)[0]
    return read(text, block, next === undefined ? tail : tail.slice(0, next))
  }

  function find(text: string) {
    return [...text.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)].filter((item) =>
      (item[1] ?? "").split(/\s+/).includes("agent-protocol"),
    )
  }

  function read(text: string, block: RegExpMatchArray | undefined, body: string, value?: unknown): Result {
    const raw = value === undefined ? (block?.[2]?.trim() ?? "") : JSON.stringify(value)
    const json = value ?? decode(raw)
    if (json === undefined) return { ok: false, error: { code: "invalid_json", message: "Agent protocol block is not valid JSON." } }

    try {
      return {
        ok: true,
        value: {
          declaration: AgentProtocol.parse(json),
          sections: markdown(body),
          raw,
        },
      }
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "invalid_schema",
          message: err instanceof globalThis.Error ? err.message : "Agent protocol schema validation failed.",
        },
      }
    }
  }

  function markdown(text: string) {
    const out: Record<string, string> = {}
    const matches = [...text.matchAll(/^##\s+([A-Za-z0-9_.-]+)\s*$/gm)]
    for (const [idx, item] of matches.entries()) {
      const id = item[1]
      if (!id || item.index === undefined) continue
      const start = item.index + item[0].length
      const end = matches[idx + 1]?.index ?? text.length
      out[id] = text.slice(start, end).trim()
    }
    return out
  }

  function direct(text: string) {
    const trimmed = text.trim()
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return
    const json = decode(trimmed)
    if (!json || typeof json !== "object" || Array.isArray(json)) return
    if (
      (json as { type?: unknown }).type !== "agent.protocol.output" &&
      (json as { type?: unknown }).type !== "agent.protocol" &&
      typeof (json as { kind?: unknown }).kind !== "string"
    )
      return
    return json
  }

  function decode(text: string): unknown | undefined {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }
}
