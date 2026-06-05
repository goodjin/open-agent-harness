export const MESSAGE_VISIBLE_LINE_LIMIT = 160

export type MessageLineLimit = {
  text: string
  hidden: number
  limit: number
}

export function limitTextLines(text: string, limit = MESSAGE_VISIBLE_LINE_LIMIT): MessageLineLimit {
  const count = Math.max(1, Math.floor(limit))
  const lines = text.split(/\r\n|\n|\r/)
  if (lines.length <= count) return { text, hidden: 0, limit: count }
  return {
    text: lines.slice(-count).join("\n"),
    hidden: lines.length - count,
    limit: count,
  }
}
