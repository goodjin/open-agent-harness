import { Memory } from "./schema"
import type { MessageV2 } from "@/session/message-v2"
import { MemoryFilter } from "./filter"

export namespace MemoryChunk {
  export const MAX = 8_000
  export const SIZE = 1_200

  function split(text: string) {
    if (text.length > MAX) return []
    if (!MemoryFilter.keep(text)) return []
    return Array.from({ length: Math.ceil(text.length / SIZE) })
      .map((_, idx) => text.slice(idx * SIZE, (idx + 1) * SIZE).trim())
      .filter((text) => text.length > 0)
  }

  function part(input: MessageV2.Part) {
    if (input.type === "text") return split(input.text)
    return []
  }

  export function select(input: MessageV2.WithParts[]) {
    return input.flatMap((msg) =>
      msg.parts.flatMap((item) =>
        part(item).map((text) => ({
          id: Memory.ChunkID.ascending(),
          text,
          source: {
            sessionID: item.sessionID,
            messageID: item.messageID,
            partID: item.id,
            agent: msg.info.agent,
          },
        })),
      ),
    )
  }
}
