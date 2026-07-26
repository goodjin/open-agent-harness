import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Question } from "../../src/question"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionID } from "../../src/session/schema"
import { SessionResult } from "../../src/session/result"
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
  test("keeps a generic live Question on the ordinary reply path", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const session = await Session.create({})
            const asked = Question.askReply({
              sessionID: session.id,
              questions: [{ question: "Choose", header: "Choose", options: [] }],
            })
            while (!(await Question.list()).length) await Bun.sleep(1)
            const request = (await Question.list())[0]
            if (!request) throw new Error("question missing")
            const res = await app.request(`/question/${request.id}/reply`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ answers: [["Continue"]] }),
            })
            expect(res.status).toBe(200)
            expect(await asked).toEqual({ answers: [["Continue"]], response: undefined, rerouted: undefined })
          },
        }),
    })
  })

  test("rejects a forged restored confirmation without a server proposal", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()
    const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as never)
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.ascending(),
          fn: async () => {
            const session = await Session.create({})
            const value = Buffer.from(
              JSON.stringify({ sessionID: session.id, run: "forged_run", action: "forged_action" }),
            ).toString("base64url")
            const res = await app.request(`/question/que_protocol_confirm_${value}/reply`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ answers: [["Confirm"]], response: "confirm" }),
            })
            expect(res.status).toBe(409)
            expect(prompt).not.toHaveBeenCalled()
          },
        }),
    })
    prompt.mockRestore()
  })

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

  test("lists pending protocol input from session context", async () => {
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
                  inputs: [
                    {
                      run_id: "apr_input",
                      action_id: "choose_next",
                      action_title: "Choose next",
                      message_id: "msg_input",
                      status: "pending",
                      updated_at: 2,
                      questions: [
                        {
                          question: "Choose next step",
                          header: "Choose next",
                          options: [
                            { label: "Continue", description: "Continue work" },
                            { label: "Pause", description: "Pause work" },
                          ],
                          multiple: false,
                          custom: false,
                        },
                      ],
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
    const body = (await res.json()) as { id: string; questions: { question: string }[]; tool?: { callID: string } }[]

    expect(body).toHaveLength(1)
    expect(body[0]?.id.startsWith("que_protocol_input_")).toBe(true)
    expect(body[0]?.tool?.callID).toBe("call_choose_next")
    expect(body[0]?.questions[0]?.question).toBe("Choose next step")
  })

  test("replies to restored protocol confirmation and continues the session", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()
    const prompt = spyOn(SessionPrompt, "prompt")
    prompt.mockImplementation((() => new Promise(() => {})) as unknown as typeof SessionPrompt.prompt)
    let id: SessionID | undefined
    let unsub = () => {}
    let seen:
      | {
          requestID: unknown
          response?: "confirm" | "cancel"
        }
      | undefined

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
                        assignment: { op: "create", target: "self" },
                        assignment_intent: { op: "create", target: "self" },
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
      await Instance.provide({
        directory: tmp.path,
        fn: () => {
          unsub = Bus.subscribe(Question.Event.Replied, (event) => {
            seen = {
              requestID: event.properties.requestID,
              response: event.properties.response,
            }
          })
        },
      })
      const res = await call(app, tmp.path, `/question/${questions[0]?.id}/reply`, {
        method: "POST",
        body: JSON.stringify({ answers: [["确认"]], response: "confirm" }),
      })
      const session = await Instance.provide({
        directory: tmp.path,
        fn: () => Session.get(id!),
      })
      const vals = session.dsl_context?.protocol as
        | { confirmations?: { response?: string; status: string }[] }
        | undefined

      expect(res.status).toBe(200)
      expect(vals?.confirmations?.[0]?.status).toBe("confirmed")
      expect(vals?.confirmations?.[0]?.response).toBe("confirm")
      expect(prompt).toHaveBeenCalled()
      expect(seen).toEqual({ requestID: questions[0]?.id, response: "confirm" })
    } finally {
      unsub()
      prompt.mockRestore()
    }
  })

  test("rejects a confirmation after a newer delegated result arrives", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()
    const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as never)

    try {
      const request = await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.ascending(),
            fn: async () => {
              const parent = await Session.create({})
              const child = await Session.create({ parentID: parent.id })
              await Session.setDslContext({
                sessionID: parent.id,
                dsl_context: {
                  protocol: {
                    confirmations: [
                      {
                        run_id: "apr_stale",
                        action_id: "confirm_stale",
                        message_id: "msg_stale",
                        plan: "old plan",
                        assignment: { op: "create", target: "self" },
                        assignment_intent: { op: "create", target: "self" },
                        status: "pending",
                        updated_at: Date.now() - 100,
                      },
                    ],
                  },
                },
              })
              await SessionResult.put({
                carrier: "action_result",
                status: "completed",
                satisfying: true,
                sessionID: child.id,
                parentSessionID: parent.id,
                childSessionID: child.id,
                runID: "apr_child",
                actionID: "inspect",
                raw: { result: "new evidence" },
              })
              const listed = await app.request("/question", { headers: headers(tmp.path) })
              return ((await listed.json()) as { id: string }[])[0]?.id
            },
          }),
      })
      if (!request) throw new Error("confirmation missing")
      const res = await call(app, tmp.path, `/question/${request}/reply`, {
        method: "POST",
        body: JSON.stringify({ answers: [["Confirm"]], response: "confirm" }),
      })

      expect(res.status).toBe(409)
      expect(prompt).not.toHaveBeenCalled()
    } finally {
      prompt.mockRestore()
    }
  })

  test("replies to restored protocol input and continues the session", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()
    const prompt = spyOn(SessionPrompt, "prompt")
    prompt.mockImplementation((() => new Promise(() => {})) as unknown as typeof SessionPrompt.prompt)
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
                    inputs: [
                      {
                        run_id: "apr_input",
                        action_id: "choose_next",
                        action_title: "Choose next",
                        message_id: "msg_input",
                        status: "pending",
                        updated_at: 2,
                        questions: [
                          {
                            question: "Choose next step",
                            header: "Choose next",
                            options: [{ label: "Continue", description: "Continue work" }],
                            multiple: false,
                            custom: false,
                          },
                        ],
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
        body: JSON.stringify({ answers: [["Continue"]] }),
      })
      const session = await Instance.provide({
        directory: tmp.path,
        fn: () => Session.get(id!),
      })
      const vals = session.dsl_context?.protocol as { inputs?: { answers?: string[][]; status: string }[] } | undefined

      expect(res.status).toBe(200)
      expect(vals?.inputs?.[0]?.status).toBe("answered")
      expect(vals?.inputs?.[0]?.answers).toEqual([["Continue"]])
      expect(prompt).toHaveBeenCalled()
      expect(JSON.stringify(prompt.mock.calls[0]?.[0])).toContain("User answered protocol input choose_next")
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
      const vals = session.dsl_context?.protocol as
        | { confirmations?: { response?: string; status: string }[] }
        | undefined

      expect(res.status).toBe(200)
      expect(vals?.confirmations?.[0]?.status).toBe("cancelled")
      expect(vals?.confirmations?.[0]?.response).toBe("cancel")
      expect(prompt).not.toHaveBeenCalled()
    } finally {
      prompt.mockRestore()
    }
  })

  test("rejects restored protocol input and continues the session", async () => {
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
                    inputs: [
                      {
                        run_id: "apr_input",
                        action_id: "choose_next",
                        action_title: "Choose next",
                        message_id: "msg_input",
                        status: "pending",
                        updated_at: 2,
                        questions: [
                          {
                            question: "Choose next step",
                            header: "Choose next",
                            options: [{ label: "Continue", description: "Continue work" }],
                            multiple: false,
                            custom: false,
                          },
                        ],
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
      const res = await call(app, tmp.path, `/question/${questions[0]?.id}/reject`, {
        method: "POST",
      })
      const session = await Instance.provide({
        directory: tmp.path,
        fn: () => Session.get(id!),
      })
      const vals = session.dsl_context?.protocol as { inputs?: { status: string }[] } | undefined

      expect(res.status).toBe(200)
      expect(vals?.inputs?.[0]?.status).toBe("rejected")
      expect(prompt).toHaveBeenCalled()
      expect(JSON.stringify(prompt.mock.calls[0]?.[0])).toContain("User dismissed protocol input choose_next")
    } finally {
      prompt.mockRestore()
    }
  })
})
