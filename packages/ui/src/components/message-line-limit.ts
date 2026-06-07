export const MESSAGE_VISIBLE_LINE_LIMIT = 160
export const MESSAGE_VISIBLE_CHAR_LIMIT = 12_000

export type MessageLineLimit = {
  text: string
  hidden: number
  limit: number
}

export function limitTextLines(text: string, limit = MESSAGE_VISIBLE_LINE_LIMIT): MessageLineLimit {
  const count = Math.max(1, Math.floor(limit))
  const lines = text.split(/\r\n|\n|\r/)
  const hidden = Math.max(0, lines.length - count)
  const chunk = hidden > 0 ? lines.slice(-count).join("\n") : text
  if (chunk.length <= MESSAGE_VISIBLE_CHAR_LIMIT) return { text: chunk, hidden, limit: count }
  return {
    text: chunk.slice(-MESSAGE_VISIBLE_CHAR_LIMIT),
    hidden: hidden + 1,
    limit: count,
  }
}
