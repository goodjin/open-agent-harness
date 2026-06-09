import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test"
import { z } from "zod"
import { QuestionTool } from "../../src/tool/question"
import * as QuestionModule from "../../src/question"
import { SessionID, MessageID } from "../../src/session/schema"

const ctx = {
  sessionID: SessionID.make("ses_test-session"),
  messageID: MessageID.make("test-message"),
  callID: "test-call",
  agent: "test-agent",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("tool.question", () => {
  let askSpy: any

  beforeEach(() => {
    askSpy = spyOn(QuestionModule.Question, "ask").mockImplementation(async () => {
      return []
    })
  })

  afterEach(() => {
    askSpy.mockRestore()
  })

  test("should successfully execute with valid question parameters", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "What is your favorite color?",
        header: "Color",
        options: [
          { label: "Red", description: "The color of passion" },
          { label: "Blue", description: "The color of sky" },
        ],
        multiple: false,
      },
    ]

    askSpy.mockResolvedValueOnce([["Red"]])

    const result = await tool.execute({ questions }, ctx)
    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(result.title).toBe("Asked 1 question")
  })

  test("header longer than 12 but less than 30 chars still works", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "What is your favorite animal?",
        header: "This Header is Over 12",
        options: [{ label: "Dog", description: "Man's best friend" }],
      },
    ]

    askSpy.mockResolvedValueOnce([["Dog"]])

    const result = await tool.execute({ questions }, ctx)
    expect(result.output).toContain(`User has answered your question "What is your favorite animal?"`)
    expect(result.output).toContain(`- Selected: "Dog"`)
    expect(result.output).toContain("this is the user's final answer")
    expect(result.output).toContain("do not re-ask this question")
  })

  test("surfaces the per-option note as a separate detail block", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "Pick a database?",
        header: "DB",
        options: [
          { label: "Postgres", description: "Relational" },
          { label: "Mongo", description: "Document" },
        ],
      },
    ]

    askSpy.mockResolvedValueOnce([["Postgres: needs read replica"]])

    const result = await tool.execute({ questions }, ctx)
    expect(result.output).toContain(`- Selected: "Postgres"`)
    expect(result.output).toContain(`- Additional details provided by the user:`)
    expect(result.output).toContain(`- "Postgres": "needs read replica"`)
  })

  test("surfaces a custom typed answer as a custom line", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "Any extra notes?",
        header: "Notes",
        options: [
          { label: "Default", description: "Use the default plan" },
        ],
      },
    ]

    askSpy.mockResolvedValueOnce([["please rerun with verbose logging"]])

    const result = await tool.execute({ questions }, ctx)
    expect(result.output).toContain(`- Custom answer: "please rerun with verbose logging"`)
    expect(result.output).not.toContain(`- Selected:`)
  })

  test("emits an unanswered message when the user submits nothing", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "Continue?",
        header: "Continue",
        options: [
          { label: "Yes", description: "Continue" },
          { label: "No", description: "Stop" },
        ],
      },
    ]

    askSpy.mockResolvedValueOnce([[]])

    const result = await tool.execute({ questions }, ctx)
    expect(result.output).toContain(`The user did not provide an answer to "Continue?"`)
  })

  test("joins multiple questions with a blank line and preserves order", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "Pick one?",
        header: "Pick",
        options: [{ label: "A", description: "A" }],
      },
      {
        question: "Pick two?",
        header: "Two",
        options: [
          { label: "X", description: "X" },
          { label: "Y", description: "Y" },
        ],
      },
    ]

    askSpy.mockResolvedValueOnce([["A"], ["X", "Y"]])

    const result = await tool.execute({ questions }, ctx)
    expect(result.title).toBe("Asked 2 questions")
    expect(result.output).toContain(`- Selected: "A"`)
    expect(result.output).toContain(`- Selected: "X", "Y"`)
    const firstIdx = result.output.indexOf("Pick one?")
    const secondIdx = result.output.indexOf("Pick two?")
    expect(firstIdx).toBeGreaterThanOrEqual(0)
    expect(secondIdx).toBeGreaterThan(firstIdx)
  })

  // intentionally removed the zod validation due to tool call errors, hoping prompting is gonna be good enough
  //   test("should throw an Error for header exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "What is your favorite animal?",
  //         header: "This Header is Definitely More Than Thirty Characters Long",
  //         options: [{ label: "Dog", description: "Man's best friend" }],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })

  //   test("should throw an Error for label exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "A question with a very long label",
  //         header: "Long Label",
  //         options: [
  //           { label: "This is a very, very, very long label that will exceed the limit", description: "A description" },
  //         ],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })
})
