import z from "zod"
import { Tool } from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"

type ParsedAnswer = {
  selected: string[]
  notes: Record<string, string>
  custom: string[]
}

const NOTE_SEPARATOR = ": "

function parseAnswer(answer: Question.Answer | undefined, validLabels: Set<string>): ParsedAnswer {
  const selected: string[] = []
  const notes: Record<string, string> = {}
  const custom: string[] = []
  if (!answer?.length) return { selected, notes, custom }

  for (const raw of answer) {
    const item = raw.trim()
    if (!item) continue
    const idx = item.indexOf(NOTE_SEPARATOR)
    if (idx > 0) {
      const label = item.slice(0, idx).trim()
      const note = item.slice(idx + NOTE_SEPARATOR.length).trim()
      if (validLabels.has(label)) {
        if (!selected.includes(label)) selected.push(label)
        if (note) notes[label] = note
        continue
      }
    }
    if (validLabels.has(item)) {
      if (!selected.includes(item)) selected.push(item)
    } else {
      custom.push(item)
    }
  }
  return { selected, notes, custom }
}

function formatQuestion(q: { question: string }, parsed: ParsedAnswer): string {
  const { selected, notes, custom } = parsed
  const hasAnswer = selected.length > 0 || custom.length > 0
  if (!hasAnswer) {
    return `The user did not provide an answer to "${q.question}". You may ask a different question or proceed with a reasonable default.`
  }
  const lines: string[] = []
  const selectedText = selected.length ? `Selected: ${selected.map((s) => `"${s}"`).join(", ")}` : null
  const customText = custom.length ? `Custom answer${custom.length > 1 ? "s" : ""}: ${custom.map((c) => `"${c}"`).join(", ")}` : null
  if (selectedText) lines.push(`- ${selectedText}`)
  if (customText) lines.push(`- ${customText}`)
  const noteEntries = Object.entries(notes)
  if (noteEntries.length) {
    lines.push("- Additional details provided by the user:")
    for (const [label, note] of noteEntries) {
      lines.push(`  - "${label}": "${note}"`)
    }
  }
  return `User has answered your question "${q.question}" (this is the user's final answer; do not re-ask this question):\n${lines.join("\n")}`
}

export const QuestionTool = Tool.define("question", {
  description: DESCRIPTION,
  parameters: z.object({
    questions: z.array(Question.Info.omit({ custom: true })).describe("Questions to ask"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "question",
      patterns: ["*"],
      always: ["*"],
      metadata: {
        questions: params.questions.map((q) => q.question),
      },
    })

    const answers = await Question.ask({
      sessionID: ctx.sessionID,
      questions: params.questions,
      tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
    })

    const blocks = params.questions.map((q, i) => {
      const valid = new Set(q.options.map((o) => o.label))
      return formatQuestion(q, parseAnswer(answers[i], valid))
    })

    return {
      title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
      output: blocks.join("\n\n"),
      metadata: {
        answers,
      },
    }
  },
})
