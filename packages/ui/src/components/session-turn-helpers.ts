import type { AssistantMessage, FileDiff, Message } from "@open-agent-harness/sdk/v2/client"

const limit = 3

function clean(value: string) {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/[*_~]+/g, "")
    .trim()
}

export function heading(text: string) {
  const markdown = text.replace(/\r\n?/g, "\n")

  const html = markdown.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
  if (html?.[1]) {
    const value = clean(html[1].replace(/<[^>]+>/g, " "))
    if (value) return value
  }

  const atx = markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/m)
  if (atx?.[1]) {
    const value = clean(atx[1])
    if (value) return value
  }

  const setext = markdown.match(/^([^\n]+)\n(?:=+|-+)\s*$/m)
  if (setext?.[1]) {
    const value = clean(setext[1])
    if (value) return value
  }

  const strong = markdown.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/m)
  if (strong?.[1]) {
    const value = clean(strong[1])
    if (value) return value
  }
}

export function thinkingText(base: string, topic: string, value?: string) {
  const text = value?.trim()
  if (!text) return base
  return topic.replace("{{topic}}", text)
}

export function turnAssistants(messages: Message[], id: string) {
  const index = messages.findIndex((item) => item.id === id && item.role === "user")
  if (index === -1) return []
  return messages
    .slice(index + 1)
    .filter((item): item is AssistantMessage => item.role === "assistant" && item.parentID === id)
}

export function diffUnique(files: FileDiff[] | undefined | null) {
  if (!files?.length) return []
  const seen = new Set<string>()
  return files
    .reduceRight<FileDiff[]>((result, diff) => {
      if (seen.has(diff.file)) return result
      seen.add(diff.file)
      result.push(diff)
      return result
    }, [])
    .reverse()
}

export function diffRows(files: FileDiff[], open: boolean) {
  if (open) return files
  return files.slice(0, limit)
}

export function diffStats(files: FileDiff[]) {
  return files.reduce(
    (sum, diff) => ({
      files: sum.files + 1,
      additions: sum.additions + diff.additions,
      deletions: sum.deletions + diff.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  )
}
