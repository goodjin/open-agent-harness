import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { QuestionID } from "../../src/question/schema"
import { Session } from "../../src/session"
import { SessionInteraction } from "../../src/session/interaction"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID } from "../../src/session/schema"
import { RuntimeInteractionTable, SessionEventOutboxTable } from "../../src/session/session.sql"
import { Database, eq } from "../../src/storage/db"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await resetDatabase()
  await Instance.disposeAll()
})

describe("durable runtime interaction", () => {
  test("persists a question before exposing it as pending", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const session = await Session.create({})
            const requestID = QuestionID.ascending()
            SessionInteraction.open({
              requestID,
              sessionID: session.id,
              questions: [{ question: "Continue?", header: "Continue", options: [] }],
              tool: { messageID: MessageID.ascending(), callID: "call_continue" },
            })

            const row = Database.use((db) =>
              db
                .select()
                .from(RuntimeInteractionTable)
                .where(eq(RuntimeInteractionTable.request_id, requestID))
                .get(),
            )
            expect(row?.status).toBe("pending")
            expect(SessionInteraction.pending().map((item) => item.id)).toContain(requestID)
          },
        }),
    })
  })

  test("resolves once and atomically enqueues one continuation", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const session = await Session.create({})
            const requestID = QuestionID.ascending()
            SessionInteraction.open({
              requestID,
              sessionID: session.id,
              questions: [{ question: "Continue?", header: "Continue", options: [] }],
            })
            const input = {
              requestID,
              answers: [["Continue"]],
              resume: true,
              schedule: false,
            }
            SessionInteraction.resolve(input)
            SessionInteraction.resolve(input)

            const interaction = Database.use((db) =>
              db
                .select()
                .from(RuntimeInteractionTable)
                .where(eq(RuntimeInteractionTable.request_id, requestID))
                .get(),
            )
            const outbox = Database.use((db) =>
              db
                .select()
                .from(SessionEventOutboxTable)
                .where(eq(SessionEventOutboxTable.kind, "runtime_continuation"))
                .all(),
            )
            expect(interaction?.status).toBe("answered")
            expect(outbox).toHaveLength(1)
            expect(outbox[0]?.dedupe_key).toBe(`runtime_continuation:${interaction?.id}:1`)
          },
        }),
    })
  })

  test("reclaims an expired continuation lease after reload", async () => {
    await using tmp = await tmpdir({ git: true })
    const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as never)
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({})
              const requestID = QuestionID.ascending()
              SessionInteraction.open({
                requestID,
                sessionID: session.id,
                questions: [{ question: "Continue?", header: "Continue", options: [] }],
              })
              SessionInteraction.resolve({
                requestID,
                answers: [["Continue"]],
                resume: true,
                schedule: false,
              })
              Database.use((db) =>
                db
                  .update(SessionEventOutboxTable)
                  .set({ status: "delivering", updated_at: Date.now() - 60_000 })
                  .where(eq(SessionEventOutboxTable.kind, "runtime_continuation"))
                  .run(),
              )

              await SessionInteraction.scan({ recover: true })

              const outbox = Database.use((db) =>
                db
                  .select()
                  .from(SessionEventOutboxTable)
                  .where(eq(SessionEventOutboxTable.kind, "runtime_continuation"))
                  .get(),
              )
              expect(outbox?.status).toBe("delivered")
              expect(prompt).toHaveBeenCalledTimes(1)
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })
})
