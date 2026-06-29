import type { UserMessage } from "@open-agent-harness/sdk/v2"

const record = (input: unknown): input is Record<string, unknown> =>
  !!input && typeof input === "object" && !Array.isArray(input)

export const queuedUserMessage = (input: UserMessage | undefined) => {
  const metadata = input?.metadata
  if (!record(metadata)) return false
  const turn = metadata.turn
  if (!record(turn)) return false
  return turn.status === "queued"
}
