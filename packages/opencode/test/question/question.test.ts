import { afterEach, test, expect } from "bun:test"
import { Question } from "../../src/question"
import { Instance } from "../../src/project/instance"
import { QuestionID } from "../../src/question/schema"
import { tmpdir } from "../fixture/fixture"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { PermissionNext } from "../../src/permission/next"
import { PermissionID } from "../../src/permission/schema"

afterEach(async () => {
  await Instance.disposeAll()
})

/** Reject all pending questions so dangling Deferred fibers don't hang the test. */
async function rejectAll() {
  const pending = await Question.list()
  for (const req of pending) {
    await Question.reject(req.id)
  }
}

async function pending(count: number) {
  for (let i = 0; i < 20; i++) {
    const list = await PermissionNext.list({ all: true })
    if (list.length >= count) return list
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return PermissionNext.list({ all: true })
}

test("ask - returns pending promise", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const promise = Question.ask({
        sessionID: SessionID.make("ses_test"),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })
      expect(promise).toBeInstanceOf(Promise)
      await rejectAll()
      await promise.catch(() => {})
    },
  })
})

test("ask - adds to pending list", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Option 1", description: "First option" },
            { label: "Option 2", description: "Second option" },
          ],
        },
      ]

      const askPromise = Question.ask({
        sessionID: SessionID.make("ses_test"),
        questions,
      })

      const pending = await Question.list()
      expect(pending.length).toBe(1)
      expect(pending[0].questions).toEqual(questions)
      await rejectAll()
      await askPromise.catch(() => {})
    },
  })
})

// reply tests

test("reply - resolves the pending ask with answers", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Option 1", description: "First option" },
            { label: "Option 2", description: "Second option" },
          ],
        },
      ]

      const askPromise = Question.ask({
        sessionID: SessionID.make("ses_test"),
        questions,
      })

      const pending = await Question.list()
      const requestID = pending[0].id

      await Question.reply({
        requestID,
        answers: [["Option 1"]],
      })

      const answers = await askPromise
      expect(answers).toEqual([["Option 1"]])
    },
  })
})

test("reply - removes from pending list", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = Question.ask({
        sessionID: SessionID.make("ses_test"),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })

      const pending = await Question.list()
      expect(pending.length).toBe(1)

      await Question.reply({
        requestID: pending[0].id,
        answers: [["Option 1"]],
      })
      await askPromise

      const pendingAfter = await Question.list()
      expect(pendingAfter.length).toBe(0)
    },
  })
})

test("ask - sets waiting_user and restores prior status after reply", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sessionID = SessionID.make("ses_question_status_reply")
      SessionStatus.set(sessionID, { type: "running" })
      const ask = Question.ask({
        sessionID,
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [{ label: "Option 1", description: "First option" }],
          },
        ],
      })

      const pending = await Question.list()
      expect(SessionStatus.get(sessionID).type).toBe("waiting_user")
      await Question.reply({
        requestID: pending[0].id,
        answers: [["Option 1"]],
      })
      await ask
      expect(SessionStatus.get(sessionID).type).toBe("running")
      SessionStatus.set(sessionID, { type: "idle" })
    },
  })
})

test("ask - preserves outer permission wait after nested user reply", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sessionID = SessionID.make("ses_question_nested_permission")
      const ask = PermissionNext.ask({
        id: PermissionID.make("per_question_nested"),
        sessionID,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      expect(await pending(1)).toHaveLength(1)
      expect(SessionStatus.get(sessionID).type).toBe("waiting_permission")

      const question = Question.ask({
        sessionID,
        questions: [
          {
            question: "Continue?",
            header: "Choice",
            options: [{ label: "Yes", description: "Continue" }],
          },
        ],
      })

      const questions = await Question.list()
      expect(SessionStatus.get(sessionID).type).toBe("waiting_user")
      await Question.reply({
        requestID: questions[0].id,
        answers: [["Yes"]],
      })
      await question
      expect(SessionStatus.get(sessionID).type).toBe("waiting_permission")

      await PermissionNext.reply({
        requestID: PermissionID.make("per_question_nested"),
        reply: "once",
      })
      await ask
      expect(SessionStatus.get(sessionID).type).toBe("idle")
    },
  })
})

test("permission - preserves outer user wait after nested permission reply", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sessionID = SessionID.make("ses_permission_nested_question")
      const question = Question.ask({
        sessionID,
        questions: [
          {
            question: "Continue?",
            header: "Choice",
            options: [{ label: "Yes", description: "Continue" }],
          },
        ],
      })

      const questions = await Question.list()
      expect(SessionStatus.get(sessionID).type).toBe("waiting_user")

      const ask = PermissionNext.ask({
        id: PermissionID.make("per_permission_nested"),
        sessionID,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      expect(await pending(1)).toHaveLength(1)
      expect(SessionStatus.get(sessionID).type).toBe("waiting_permission")
      await PermissionNext.reply({
        requestID: PermissionID.make("per_permission_nested"),
        reply: "once",
      })
      await ask
      expect(SessionStatus.get(sessionID).type).toBe("waiting_user")

      await Question.reply({
        requestID: questions[0].id,
        answers: [["Yes"]],
      })
      await question
      expect(SessionStatus.get(sessionID).type).toBe("idle")
    },
  })
})

test("ask - restores prior status after reject", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sessionID = SessionID.make("ses_question_status_reject")
      SessionStatus.set(sessionID, { type: "running" })
      const ask = Question.ask({
        sessionID,
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [{ label: "Option 1", description: "First option" }],
          },
        ],
      })

      const pending = await Question.list()
      expect(SessionStatus.get(sessionID).type).toBe("waiting_user")
      await Question.reject(pending[0].id)
      await ask.catch(() => {})
      expect(SessionStatus.get(sessionID).type).toBe("running")
      SessionStatus.set(sessionID, { type: "idle" })
    },
  })
})

test("ask - works from timeout state and restores timeout after reply", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sessionID = SessionID.make("ses_question_status_timeout")
      SessionStatus.set(sessionID, { type: "running" })
      SessionStatus.set(sessionID, { type: "timeout", message: "no progress" })

      const ask = Question.ask({
        sessionID,
        questions: [
          {
            question: "How should we proceed?",
            header: "Choice",
            options: [{ label: "Retry", description: "Continue running" }],
          },
        ],
      })

      const pending = await Question.list()
      expect(SessionStatus.get(sessionID).type).toBe("waiting_user")

      await Question.reply({
        requestID: pending[0].id,
        answers: [["Retry"]],
      })
      await ask

      const status = SessionStatus.get(sessionID)
      expect(status.type).toBe("timeout")
      if (status.type === "timeout") {
        expect(status.message).toBe("no progress")
      }
      SessionStatus.set(sessionID, { type: "idle" })
    },
  })
})

test("reply - does nothing for unknown requestID", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Question.reply({
        requestID: QuestionID.make("que_unknown"),
        answers: [["Option 1"]],
      })
      // Should not throw
    },
  })
})

// reject tests

test("reject - throws RejectedError", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = Question.ask({
        sessionID: SessionID.make("ses_test"),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })

      const pending = await Question.list()
      await Question.reject(pending[0].id)

      await expect(askPromise).rejects.toBeInstanceOf(Question.RejectedError)
    },
  })
})

test("reject - removes from pending list", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = Question.ask({
        sessionID: SessionID.make("ses_test"),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })

      const pending = await Question.list()
      expect(pending.length).toBe(1)

      await Question.reject(pending[0].id)
      askPromise.catch(() => {}) // Ignore rejection

      const pendingAfter = await Question.list()
      expect(pendingAfter.length).toBe(0)
    },
  })
})

test("reject - does nothing for unknown requestID", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Question.reject(QuestionID.make("que_unknown"))
      // Should not throw
    },
  })
})

// multiple questions tests

test("ask - handles multiple questions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Build", description: "Build the project" },
            { label: "Test", description: "Run tests" },
          ],
        },
        {
          question: "Which environment?",
          header: "Env",
          options: [
            { label: "Dev", description: "Development" },
            { label: "Prod", description: "Production" },
          ],
        },
      ]

      const askPromise = Question.ask({
        sessionID: SessionID.make("ses_test"),
        questions,
      })

      const pending = await Question.list()

      await Question.reply({
        requestID: pending[0].id,
        answers: [["Build"], ["Dev"]],
      })

      const answers = await askPromise
      expect(answers).toEqual([["Build"], ["Dev"]])
    },
  })
})

// list tests

test("list - returns all pending requests", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const p1 = Question.ask({
        sessionID: SessionID.make("ses_test1"),
        questions: [
          {
            question: "Question 1?",
            header: "Q1",
            options: [{ label: "A", description: "A" }],
          },
        ],
      })

      const p2 = Question.ask({
        sessionID: SessionID.make("ses_test2"),
        questions: [
          {
            question: "Question 2?",
            header: "Q2",
            options: [{ label: "B", description: "B" }],
          },
        ],
      })

      const pending = await Question.list()
      expect(pending.length).toBe(2)
      await rejectAll()
      p1.catch(() => {})
      p2.catch(() => {})
    },
  })
})

test("list - returns empty when no pending", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const pending = await Question.list()
      expect(pending.length).toBe(0)
    },
  })
})
