import type { QuestionRequest } from "@open-agent-harness/sdk/v2"

type Confirm = {
  action_id: string
  message_id: string
  plan?: string
  run_id?: string
  status?: string
  updated_at?: number
}

const prefix = "que_protocol_confirm_"

export const confirmationKey = (input: Confirm) => `${input.message_id}:call_${input.action_id}`

export const questionConfirmationKey = (input: Pick<QuestionRequest, "tool"> | undefined) => {
  if (!input?.tool) return
  return `${input.tool.messageID}:${input.tool.callID}`
}

export const timelineQuestionVisible = (input: {
  active: boolean
  request: Pick<QuestionRequest, "id" | "tool"> | undefined
  confirm?: Confirm
}) => {
  if (!input.request) return true
  if (!input.active) return true
  if (!input.confirm) return false
  const key = questionConfirmationKey(input.request)
  if (!key) return true
  return confirmationKey(input.confirm) !== key
}

const time = (input: Confirm) => input.updated_at ?? 0

export const visibleConfirmations = <T extends Confirm>(input: T[], request?: string) => {
  const latest = new Map<string, T>()
  for (const item of input) {
    const key = confirmationKey(item)
    const prev = latest.get(key)
    if (!prev || time(prev) <= time(item)) latest.set(key, item)
  }

  const vals = Array.from(latest.values()).sort((a, b) => time(a) - time(b))
  const pending = vals.filter((item) => item.status === "pending")
  if (pending.length <= 1) return vals

  const current = request
    ? pending.findLast((item) => confirmationKey(item) === request)
    : undefined
  const pick = current ?? pending.reduce((acc, item) => (time(acc) <= time(item) ? item : acc))
  return vals.filter((item) => item.status !== "pending" || item === pick)
}

const b64 = (input: string) => btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")

export const protocolConfirmationRequest = (input: {
  item: Confirm
  sessionID: string | undefined
}): QuestionRequest | undefined => {
  if (!input.sessionID) return
  if (input.item.status !== "pending") return
  if (!input.item.run_id) return
  return {
    id:
      prefix +
      b64(
        JSON.stringify({
          sessionID: input.sessionID,
          run: input.item.run_id,
          action: input.item.action_id,
        }),
      ),
    sessionID: input.sessionID,
    questions: [
      {
        question: ["Please confirm this plan before execution.", "", input.item.plan ?? ""]
          .filter((part) => part.trim().length > 0)
          .join("\n"),
        header: "Confirm plan",
        options: [
          { label: "Confirm", description: "Approve this plan and continue execution." },
          { label: "Cancel", description: "Do not execute this plan." },
        ],
        multiple: false,
        custom: false,
      },
    ],
    tool: { messageID: input.item.message_id, callID: `call_${input.item.action_id}` },
  }
}
