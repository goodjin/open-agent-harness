import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionID } from "../../src/session/schema"
import { Log } from "../../src/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await resetDatabase()
  await Instance.disposeAll()
})

function headers(dir: string) {
  return {
    "content-type": "application/json",
    "x-opencode-directory": dir,
  }
}

async function call(app: ReturnType<typeof Server.Default>, dir: string, input: RequestInfo | URL, init?: RequestInit) {
  return Instance.provide({
    directory: dir,
    fn: () =>
      app.request(input, {
        ...init,
        headers: {
          ...headers(dir),
          ...(init?.headers as Record<string, string> | undefined),
        },
      }),
  })
}

describe("question routes", () => {
  test("lists latest pending protocol confirmation from session context", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const session = await Session.create({})
            await Session.setDslContext({
              sessionID: session.id,
              dsl_context: {
                protocol: {
                  confirmations: [
                    {
                      run_id: "apr_old",
                      action_id: "confirm_old",
                      message_id: "msg_old",
                      plan: "old plan",
                      status: "pending",
                      updated_at: 1,
                    },
                    {
                      run_id: "apr_new",
                      action_id: "confirm_new",
                      message_id: "msg_new",
                      plan: "new plan",
                      status: "pending",
                      updated_at: 2,
                    },
                  ],
                },
              },
            })
          },
        }),
    })

    const res = await call(app, tmp.path, "/question")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { questions: { question: string }[]; tool?: { callID: string } }[]

    expect(body).toHaveLength(1)
    expect(body[0]?.tool?.callID).toBe("call_confirm_new")
    expect(body[0]?.questions[0]?.question).toContain("new plan")
  })

  test("lists protocol confirmations only for the current directory", async () => {
    await using one = await tmpdir({ git: true })
    await using two = await tmpdir({ git: true })
    const app = Server.Default()

    await Instance.provide({
      directory: one.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const session = await Session.create({})
            await Session.setDslContext({
              sessionID: session.id,
              dsl_context: {
                protocol: {
                  confirmations: [
                    {
                      run_id: "apr_one",
                      action_id: "confirm_one",
                      message_id: "msg_one",
                      plan: "one plan",
                      status: "pending",
                      updated_at: 1,
                    },
                  ],
                },
              },
            })
          },
        }),
    })

    await Instance.provide({
      directory: two.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const session = await Session.create({})
            await Session.setDslContext({
              sessionID: session.id,
              dsl_context: {
                protocol: {
                  confirmations: [
                    {
                      run_id: "apr_two",
                      action_id: "confirm_two",
                      message_id: "msg_two",
                      plan: "two plan",
                      status: "pending",
                      updated_at: 1,
                    },
                  ],
                },
              },
            })
          },
        }),
    })

    const res = await call(app, one.path, "/question")
    const body = (await res.json()) as { questions: { question: string }[] }[]

    expect(res.status).toBe(200)
    expect(body).toHaveLength(1)
    expect(body[0]?.questions[0]?.question).toContain("one plan")
    expect(body[0]?.questions[0]?.question).not.toContain("two plan")
  })

  test("replies to restored protocol confirmation and continues the session", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()
    const prompt = spyOn(SessionPrompt, "prompt")
    prompt.mockImplementation((async () => undefined) as unknown as typeof SessionPrompt.prompt)
    let id: SessionID | undefined

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({})
              id = session.id
              await Session.setDslContext({
                sessionID: session.id,
                dsl_context: {
                  protocol: {
                    confirmations: [
                      {
                        run_id: "apr_new",
                        action_id: "confirm_new",
                        message_id: "msg_new",
                        plan: "new plan",
                        status: "pending",
                        updated_at: 2,
                      },
                    ],
                  },
                },
              })
            },
          }),
      })

      const listed = await call(app, tmp.path, "/question")
      const questions = (await listed.json()) as { id: string }[]
      const res = await call(app, tmp.path, `/question/${questions[0]?.id}/reply`, {
        method: "POST",
        body: JSON.stringify({ answers: [["确认"]], response: "confirm" }),
      })
      const session = await Instance.provide({
        directory: tmp.path,
        fn: () => Session.get(id!),
      })
      const vals = session.dsl_context?.protocol as { confirmations?: { response?: string; status: string }[] } | undefined

      expect(res.status).toBe(200)
      expect(vals?.confirmations?.[0]?.status).toBe("confirmed")
      expect(vals?.confirmations?.[0]?.response).toBe("confirm")
      expect(prompt).toHaveBeenCalled()
    } finally {
      prompt.mockRestore()
    }
  })

  test("cancels restored protocol confirmation from explicit response", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()
    const prompt = spyOn(SessionPrompt, "prompt")
    prompt.mockImplementation((async () => undefined) as unknown as typeof SessionPrompt.prompt)
    let id: SessionID | undefined

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const session = await Session.create({})
              id = session.id
              await Session.setDslContext({
                sessionID: session.id,
                dsl_context: {
                  protocol: {
                    confirmations: [
                      {
                        run_id: "apr_cancel",
                        action_id: "confirm_cancel",
                        message_id: "msg_cancel",
                        plan: "cancel plan",
                        status: "pending",
                        updated_at: 2,
                      },
                    ],
                  },
                },
              })
            },
          }),
      })

      const listed = await call(app, tmp.path, "/question")
      const questions = (await listed.json()) as { id: string }[]
      const res = await call(app, tmp.path, `/question/${questions[0]?.id}/reply`, {
        method: "POST",
        body: JSON.stringify({ answers: [["Cancel"]], response: "cancel" }),
      })
      const session = await Instance.provide({
        directory: tmp.path,
        fn: () => Session.get(id!),
      })
      const vals = session.dsl_context?.protocol as { confirmations?: { response?: string; status: string }[] } | undefined

      expect(res.status).toBe(200)
      expect(vals?.confirmations?.[0]?.status).toBe("cancelled")
      expect(vals?.confirmations?.[0]?.response).toBe("cancel")
      expect(prompt).toHaveBeenCalled()
    } finally {
      prompt.mockRestore()
    }
  })
})
