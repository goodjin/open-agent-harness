import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionLog } from "../../src/session/log"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRecovery } from "../../src/session/recovery"
import { SessionTaskRecovery } from "../../src/session/task-recovery"
import { SessionTask } from "../../src/session/task"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionAssignment } from "../../src/session/assignment"
import { SessionDelegation } from "../../src/session/delegation"
import { SessionResult } from "../../src/session/result"
import { AgentProtocol } from "../../src/protocol/schema"
import { SessionControlTool } from "../../src/tool/session-control"
import type { Tool } from "../../src/tool/tool"
import { Database, eq } from "../../src/storage/db"
import { SessionEventOutboxTable } from "../../src/session/session.sql"
import { Log } from "../../src/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await resetDatabase()
})

describe("session recovery", () => {
  test("activates a confirmed task update once and starts it from durable bootstrap", async () => {
    await using tmp = await tmpdir({ git: true })
    const calls: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation(((input: Parameters<typeof SessionPrompt.prompt>[0]) => {
      calls.push(input)
      return Promise.resolve(undefined)
    }) as never)
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("wrk_task_revision_recovery"),
            fn: async () => {
              const session = await Session.create({ agent: "default" })
              const first = await SessionTask.route({
                sessionID: session.id,
                runID: "run_revision_seed",
                legacy: { title: "Original", body: "Original plan" },
                actions: [],
              })
              if (first.type !== "execute") throw new Error("task missing")
              const update = await SessionTask.route({
                sessionID: session.id,
                runID: "run_revision_update",
                assignment: { op: "update", target: "self", title: "Revised", body: "Revised plan" },
                actions: [{ id: "new_work", title: "New work" }],
              })
              if (update.type !== "update") throw new Error("draft missing")

              expect(await SessionTaskRecovery.resume(session.id)).toBe(true)
              expect(await SessionTaskRecovery.resume(session.id)).toBe(true)
              expect((await SessionTask.get(session.id))?.revision.id).toBe(update.revision.id)
              expect((await SessionTask.get(session.id))?.task.status).toBe("running")
              expect(calls).toHaveLength(1)
              expect(calls[0]?.metadata).toMatchObject({
                internal: true,
                source: "task_revision_bootstrap",
                revision_id: update.revision.id,
              })
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("collects every scoped child before activation and ignores unrelated tree sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    const calls: Parameters<typeof SessionPrompt.prompt>[0][] = []
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (
      input: Parameters<typeof SessionPrompt.prompt>[0],
    ) => {
      calls.push(input)
      if (input.metadata?.source === "task_revision_bootstrap") return undefined
      const user = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: input.agent ?? "summary",
        model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
        tools: {},
        mode: "",
      } as MessageV2.User)) as MessageV2.User
      const assistant = (await Session.updateMessage({
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        parentID: user.id,
        role: "assistant",
        mode: input.agent ?? "summary",
        agent: input.agent ?? "summary",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelID.make("gpt-5.2"),
        providerID: ProviderID.make("openai"),
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      })) as MessageV2.Assistant
      const part = await Session.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: input.sessionID,
        type: "text",
        text: "Recovered partial child result with task revision stop reason.",
        time: { start: Date.now(), end: Date.now() },
      } as MessageV2.TextPart)
      return { info: assistant, parts: [part] } as MessageV2.WithParts
    }) as never)
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          WorkspaceContext.provide({
            workspaceID: WorkspaceID.make("wrk_task_revision_children"),
            fn: async () => {
              const parent = await Session.create({ agent: "default" })
              const confirm = action("confirm_create", "confirm", "user")
              confirm.input = { assignment: { op: "create", target: "self" }, plan: "Original plan" }
              const actions = [
                action("running", "delegate", "backend"),
                action("completed", "delegate", "backend"),
                action("missing", "delegate", "backend"),
                action("stuck", "delegate", "backend"),
              ]
              const assignment = await SessionAssignment.confirm({
                action: confirm,
                messageID: MessageID.ascending(),
                plan: "Original plan",
                runID: "run_task_children",
                sessionID: parent.id,
              })
              if (!assignment) throw new Error("assignment missing")
              const original = await SessionTask.confirmed({
                sessionID: parent.id,
                runID: "run_task_children",
                actionIDs: [confirm.id],
                actions: [confirm, ...actions],
                legacy: { title: "Original", body: "Original plan" },
                requiresAssignment: true,
              })
              if (original.type !== "execute") throw new Error("task missing")

              const children = await Promise.all(
                actions.map(async (item) => {
                  const child = await Session.create({ parentID: parent.id, agent: "backend" })
                  await SessionAssignment.delegate({
                    action: item,
                    childID: child.id,
                    messageID: MessageID.ascending(),
                    runID: "run_task_children",
                    sessionID: parent.id,
                  })
                  return child
                }),
              )
              for (const index of [0, 1, 2]) {
                await SessionDelegation.assign({
                  action: actions[index]!,
                  agent: "backend",
                  childID: children[index]!.id,
                  messageID: MessageID.ascending(),
                  parentAgent: "default",
                  runID: "run_task_children",
                  sessionID: parent.id,
                })
              }
              SessionStatus.set(children[0]!.id, { type: "running" })
              SessionStatus.set(children[1]!.id, { type: "completed" })
              SessionStatus.set(children[2]!.id, { type: "completed" })
              SessionStatus.set(children[3]!.id, { type: "running" })
              await SessionResult.put({
                carrier: "action_result",
                status: "completed",
                satisfying: true,
                sessionID: children[1]!.id,
                parentSessionID: parent.id,
                childSessionID: children[1]!.id,
                runID: "run_task_children",
                actionID: "completed",
                summary: "Completed native result",
                raw: {
                  output: "Completed native result",
                  input: { kind: "action_result", role: "worker", action_id: "completed", status: "success" },
                },
              })
              const unrelated = await Session.create({ parentID: parent.id, agent: "backend" })
              SessionStatus.set(unrelated.id, { type: "running" })
              const update = await SessionTask.route({
                sessionID: parent.id,
                runID: "run_task_update",
                assignment: { op: "update", target: "self", title: "Revised", body: "Revised plan" },
                actions: [{ id: "replacement" }],
              })
              if (update.type !== "update") throw new Error("draft missing")

              const tool = await SessionControlTool.init()
              const context = control(parent.id)
              const listed = JSON.parse((await tool.execute({ action: "list" }, context)).output) as {
                session_id: string
              }[]
              expect(listed.map((item) => item.session_id).sort()).toEqual(children.map((item) => item.id).sort())
              expect(listed.map((item) => item.session_id)).not.toContain(unrelated.id)

              expect(await SessionTaskRecovery.resume(parent.id)).toBe(true)
              expect((await SessionTask.get(parent.id))?.task.status).toBe("revising")
              expect((await SessionTask.get(parent.id))?.revision.id).toBe(original.revision.id)
              expect(SessionStatus.get(children[0]!.id).type).toBe("user_completed")
              expect(SessionStatus.get(children[1]!.id).type).toBe("completed")
              expect(SessionStatus.get(children[2]!.id).type).toBe("completed")
              expect(SessionStatus.get(children[3]!.id).type).toBe("running")
              expect(SessionStatus.get(unrelated.id).type).toBe("running")
              expect(
                Database.use((db) =>
                  db
                    .select()
                    .from(SessionEventOutboxTable)
                    .where(eq(SessionEventOutboxTable.session_id, parent.id))
                    .all(),
                ),
              ).toHaveLength(0)
              const first = await SessionResult.listForParent(parent.id)
              const running = first.find((item) => item.child_session_id === children[0]!.id)
              const completed = first.find((item) => item.child_session_id === children[1]!.id)
              const missing = first.find((item) => item.child_session_id === children[2]!.id)
              expect(running?.status).toBe("partial")
              expect((await SessionResult.parse(running?.id ?? ""))?.output).toContain("task revision stop reason")
              expect(completed?.summary).toBe("Completed native result")
              expect((await SessionResult.parse(completed?.id ?? ""))?.output).toBe("Completed native result")
              expect(missing?.status).toBe("partial")
              expect((await SessionResult.parse(missing?.id ?? ""))?.output).toContain("task revision stop reason")
              expect(first.some((item) => item.child_session_id === children[3]!.id)).toBe(false)

              const stopped = JSON.parse((await tool.execute({ action: "stop_all" }, context)).output) as {
                session_id: string
              }[]
              expect(stopped.map((item) => item.session_id).sort()).toEqual(children.map((item) => item.id).sort())
              await SessionDelegation.assign({
                action: actions[3]!,
                agent: "backend",
                childID: children[3]!.id,
                messageID: MessageID.ascending(),
                parentAgent: "default",
                runID: "run_task_children",
                sessionID: parent.id,
              })

              expect(await SessionTaskRecovery.resume(parent.id)).toBe(true)
              expect((await SessionTask.get(parent.id))?.revision.id).toBe(update.revision.id)
              const results = await SessionResult.listForParent(parent.id)
              const ids = results.map((item) => item.id).sort()
              const summaries = calls.filter((item) => item.agent === "summary").length
              const bootstraps = calls.filter((item) => item.metadata?.source === "task_revision_bootstrap").length
              expect(results.filter((item) => children.some((child) => child.id === item.child_session_id))).toHaveLength(4)
              expect(bootstraps).toBe(1)
              expect(await SessionTaskRecovery.resume(parent.id)).toBe(true)
              expect(await SessionTaskRecovery.scan()).toContain(true)
              expect((await SessionResult.listForParent(parent.id)).map((item) => item.id).sort()).toEqual(ids)
              expect(calls.filter((item) => item.agent === "summary")).toHaveLength(summaries)
              expect(calls.filter((item) => item.metadata?.source === "task_revision_bootstrap")).toHaveLength(1)
              SessionStatus.set(unrelated.id, { type: "idle" })
            },
          }),
      })
    } finally {
      prompt.mockRestore()
    }
  })

  test("marks stale running tools and records recovery packet", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_recovery_stale"),
          fn: async () => {
            const data = await stale(tmp.path, "git push origin main")
            await SessionLog.emit({
              sessionID: data.sessionID,
              messageID: data.messageID,
              partID: data.partID,
              level: "info",
              type: "tool.start",
              data: { tool: "bash" },
              time: data.start,
            })
            await SessionLog.emit({
              sessionID: data.sessionID,
              level: "info",
              type: "permission.asked",
              data: { command: "git push origin main" },
              time: data.start + 1,
            })

            const packets = await SessionRecovery.mark()

            expect(packets).toHaveLength(1)
            expect(packets[0].session_id).toBe(data.sessionID)
            expect(packets[0].tools[0].tool).toBe("bash")
            expect(packets[0].tools[0].risk).toBe("high")
            expect(packets[0].tools[0].recovery_hint).toBe("requires_user_confirmation")
            expect(packets[0].tools[0].logs).toContain("tool.start")
            expect(packets[0].tools[0].logs).toContain("permission.asked")

            const part = (await MessageV2.parts(data.messageID)).find((item) => item.id === data.partID)
            expect(part?.type).toBe("tool")
            if (part?.type !== "tool") return
            expect(part.state.status).toBe("error")
            if (part.state.status !== "error") return
            expect(part.state.error).toContain("interrupted")
            expect(part.state.metadata?.recovery?.status).toBe("stale_interrupted")
            expect(part.state.metadata?.recovery?.risk).toBe("high")

            const logs = await SessionLog.list({ sessionID: data.sessionID, limit: 100 })
            expect(logs.map((item) => item.type)).toContain("session.recovery.detected")
            expect(logs.map((item) => item.type)).toContain("session.recovery.tool_marked_stale")
          },
        }),
    })
  })

  test("does not mark tools for sessions active in current process", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_recovery_active"),
          fn: async () => {
            const data = await stale(tmp.path, "bun test")
            SessionStatus.set(data.sessionID, { type: "running" })

            const packets = await SessionRecovery.mark()

            expect(packets).toHaveLength(0)
            const part = (await MessageV2.parts(data.messageID)).find((item) => item.id === data.partID)
            expect(part?.type).toBe("tool")
            if (part?.type !== "tool") return
            expect(part.state.status).toBe("running")
            SessionStatus.set(data.sessionID, { type: "idle" })
          },
        }),
    })
  })

  test("marks tools for sessions interrupted by a previous process", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_recovery_interrupted"),
          fn: async () => {
            const data = await stale(tmp.path, "bun test")
            SessionStatus.set(data.sessionID, { type: "interrupted", prior: "running" })

            const packets = await SessionRecovery.mark()

            expect(packets).toHaveLength(1)
            expect(packets[0].session_id).toBe(data.sessionID)
            const part = (await MessageV2.parts(data.messageID)).find((item) => item.id === data.partID)
            expect(part?.type).toBe("tool")
            if (part?.type !== "tool") return
            expect(part.state.status).toBe("error")
            SessionStatus.set(data.sessionID, { type: "idle" })
          },
        }),
    })
  })
  test("lists sessions whose stale tools were already marked", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_recovery_marked"),
          fn: async () => {
            const data = await stale(tmp.path, "bun test")
            SessionStatus.set(data.sessionID, { type: "interrupted", prior: "running" })

            await SessionRecovery.mark()
            expect(await SessionRecovery.detect()).toHaveLength(0)
            expect(await SessionRecovery.marked()).toContain(data.sessionID)
            SessionStatus.set(data.sessionID, { type: "idle" })
          },
        }),
    })
  })
})

async function stale(dir: string, command: string) {
  const session = await Session.create({ title: "recovery-test" })
  const user = MessageID.ascending()
  await Session.updateMessage({
    id: user,
    sessionID: session.id,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as MessageV2.Info)

  const messageID = MessageID.ascending()
  await Session.updateMessage({
    id: messageID,
    parentID: user,
    role: "assistant",
    mode: "test",
    agent: "test",
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
    path: {
      cwd: dir,
      root: dir,
    },
    time: { created: Date.now() },
    sessionID: session.id,
  } as MessageV2.Assistant)

  const start = Date.now()
  const partID = PartID.ascending()
  await Session.updatePart({
    id: partID,
    sessionID: session.id,
    messageID,
    type: "tool",
    callID: "call_recovery",
    tool: "bash",
    state: {
      status: "running",
      input: { command },
      title: command,
      time: { start },
    },
  })

  return {
    sessionID: session.id as SessionID,
    messageID,
    partID,
    start,
  }
}

function action(id: string, operation: string, target: string) {
  return {
    type: "action",
    id,
    title: id,
    operation,
    executor:
      target === "user"
        ? { type: "human", target, capabilities: ["confirmation"] }
        : { type: "agent", target, capabilities: ["implementation"] },
    input: {},
    depends_on: [],
    context_refs: [],
    result_policy: "summary",
  } as AgentProtocol.Action
}

function control(sessionID: SessionID): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "default",
    abort: new AbortController().signal,
    messages: [],
    metadata() {},
    async ask() {},
  }
}
