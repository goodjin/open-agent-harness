export type MessagePosition = "prefix" | "suffix" | "observation"

export type ModelMessage = {
  on: string
  position: string
  content: string
  priority?: number
}

export type MessageMeta = {
  instructions?: {
    model_messages?: readonly ModelMessage[]
  }
}

export type MessageBudget = {
  maxMessages?: number
  maxChars?: number
}

export type MessageDiagnostic = {
  level: "warning"
  code: "unsupported_position" | "empty_content" | "budget_exceeded"
  field: string
  message: string
}

export type MessageRecord = {
  author: "runtime"
  trigger: string
  position: MessagePosition
  content: string
  source: {
    kind: "agent.metadata.instructions.model_messages"
    index: number
  }
}

export type MessageContext = {
  meta?: MessageMeta
  event: string
  budget?: MessageBudget
}

export type MessageResult = {
  records: MessageRecord[]
  diagnostics: MessageDiagnostic[]
}

const positions = ["prefix", "suffix", "observation"] as const

export function resolveMessages(ctx: MessageContext): MessageResult {
  const items = (ctx.meta?.instructions?.model_messages ?? [])
    .map((item, index) => ({ item, index }))
    .filter((entry) => entry.item.on === ctx.event)
    .sort((a, b) => (b.item.priority ?? 0) - (a.item.priority ?? 0) || a.index - b.index)

  const checked = items.map((entry) => {
    if (!positions.includes(entry.item.position as MessagePosition)) {
      return {
        diagnostics: [
          diag(
            "unsupported_position",
            `instructions.model_messages.${entry.index}.position`,
            `Unsupported model message position: ${entry.item.position}`,
          ),
        ],
        records: [],
      } satisfies MessageResult
    }

    if (!entry.item.content.trim()) {
      return {
        diagnostics: [
          diag("empty_content", `instructions.model_messages.${entry.index}.content`, "Model message content is empty"),
        ],
        records: [],
      } satisfies MessageResult
    }

    return {
      diagnostics: [],
      records: [
        {
          author: "runtime",
          trigger: entry.item.on,
          position: entry.item.position as MessagePosition,
          content: entry.item.content,
          source: {
            kind: "agent.metadata.instructions.model_messages",
            index: entry.index,
          },
        },
      ],
    } satisfies MessageResult
  })

  const result = checked.reduce(
    (state, item) => {
      if (!item.records.length) {
        return {
          ...state,
          diagnostics: [...state.diagnostics, ...item.diagnostics],
        }
      }

      const record = item.records[0]
      const count = state.records.length >= (ctx.budget?.maxMessages ?? Number.POSITIVE_INFINITY)
      const chars = state.chars + record.content.length > (ctx.budget?.maxChars ?? Number.POSITIVE_INFINITY)
      if (count || chars) {
        return {
          ...state,
          diagnostics: [
            ...state.diagnostics,
            ...item.diagnostics,
            diag("budget_exceeded", `instructions.model_messages.${record.source.index}.content`, "Model message budget exceeded"),
          ],
        }
      }

      return {
        chars: state.chars + record.content.length,
        records: [...state.records, record],
        diagnostics: [...state.diagnostics, ...item.diagnostics],
      }
    },
    { chars: 0, records: [] as MessageRecord[], diagnostics: [] as MessageDiagnostic[] },
  )

  return {
    records: result.records,
    diagnostics: result.diagnostics,
  }
}

function diag(code: MessageDiagnostic["code"], field: string, message: string): MessageDiagnostic {
  return {
    level: "warning",
    code,
    field,
    message,
  }
}
