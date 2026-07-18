import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, SessionID } from "../../src/session/schema"
import { SessionEventOutboxTable, SessionTaskTable, TaskHandoffTable } from "../../src/session/session.sql"
import { SessionTask } from "../../src/session/task"
import { SessionTaskHandoff } from "../../src/session/task-handoff"
import { SessionAssignment } from "../../src/session/assignment"
import { Database, eq } from "../../src/storage/db"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await resetDatabase()
})

async function setup(fn: () => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: () => WorkspaceContext.provide({ workspaceID: WorkspaceID.make("wrk_task_handoff"), fn }),
  })
}

async function source(parentID?: SessionID) {
  const session = await Session.create({ parentID, agent: "default" })
  await SessionTask.route({
    sessionID: session.id,
    runID: "run_source",
    legacy: { title: "Source task", body: "Source body" },
    actions: [],
  })
  const messageID = MessageID.ascending()
  await Session.updateMessage({
    id: messageID,
    sessionID: session.id,
    role: "assistant",
    parentID: MessageID.ascending(),
    time: { created: Date.now() },
    agent: "default",
    modelID: "gpt-5",
    providerID: "openai",
    mode: "default",
    path: { cwd: Instance.directory, root: Instance.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  } as MessageV2.Assistant)
  return { messageID, session }
}

async function until(fn: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5_000
  while (Date.now() < end) {
    if (await fn()) return
    await Bun.sleep(10)
  }
  throw new Error("condition timeout")
}

async function approve(input: {
  handoff: SessionTaskHandoff.Info
  source: Awaited<ReturnType<typeof source>>
  body?: string
}) {
  const assignment = await SessionAssignment.apply({
    actionID: `confirm_${input.source.messageID}`,
    assignment: { op: "handoff", target: "peer" },
    messageID: input.source.messageID,
    plan: input.body ?? input.handoff.body,
    runID: `run_${input.source.messageID}`,
    sessionID: input.source.session.id,
    title: input.handoff.title,
  })
  if (!assignment) throw new Error("assignment missing")
  return assignment
}

function offer(input: Omit<Parameters<typeof SessionTaskHandoff.propose>[0], "runID" | "actionID">) {
  return SessionTaskHandoff.propose({
    ...input,
    runID: `run_${input.messageID}`,
    actionID: `confirm_${input.messageID}`,
  })
}

describe("SessionTaskHandoff", () => {
  test("persists a proposal without creating a target and replays its stable dedupe", () =>
    setup(async () => {
      const root = await Session.create({})
      const current = await source(root.id)
      const before = await Session.children(root.id)
      const input = {
        sourceID: current.session.id,
        messageID: current.messageID,
        title: "Peer task",
        body: "# Peer task\n\nDo the new work.",
        contextRefs: ["result:one"],
      }
      const first = await offer(input)
      const replay = await offer(input)

      expect(first.status).toBe("proposed")
      expect(replay.id).toBe(first.id)
      expect(replay.dedupe_key).toBe(first.dedupe_key)
      expect(await Session.children(root.id)).toEqual(before)
      expect(first.target_session_id).toBeNull()
      const message = await MessageV2.get({ sessionID: current.session.id, messageID: current.messageID })
      const part = message.parts.find(
        (item): item is MessageV2.TextPart => item.type === "text" && item.metadata?.kind === "task_handoff_proposal",
      )
      expect(part?.metadata).toMatchObject({ handoff_id: first.id, title: "Peer task", status: "proposed" })
      expect(JSON.stringify(part?.metadata)).not.toContain("Do the new work")
    }))

  test("creates one peer session, task and revision only after confirmation", () =>
    setup(async () => {
      const parent = await Session.create({})
      const current = await source(parent.id)
      const proposed = await offer({
        sourceID: current.session.id,
        messageID: current.messageID,
        title: "Peer task",
        body: "Peer body",
        contextRefs: [],
      })

      expect(await Session.children(parent.id)).toHaveLength(1)
      const assignment = await approve({ handoff: proposed, source: current })
      const [first, replay] = await Promise.all([
        SessionTaskHandoff.confirm(proposed.id, { assignmentID: assignment.id }),
        SessionTaskHandoff.confirm(proposed.id, { assignmentID: assignment.id }),
      ])
      expect(replay.target_session_id).toBe(first.target_session_id)
      expect(await Session.children(parent.id)).toHaveLength(2)
      expect((await Session.get(SessionID.make(first.target_session_id ?? ""))).parentID).toBe(current.session.parentID)
      const target = await SessionTask.get(SessionID.make(first.target_session_id ?? ""))
      expect(target?.task.id).toBe(first.target_task_id ?? undefined)
      expect(target?.task.source_type).toBe("handoff")
      expect(target?.task.source_ref).toEqual({ handoffID: first.id, sourceSessionID: current.session.id })
      expect(target?.revision).toMatchObject({ version: 1, status: "active", body: "Peer body" })
    }))

  test("creates a root peer for a root source and rejects a foreign source message", () =>
    setup(async () => {
      const current = await source()
      const foreign = await Session.create({})
      const messageID = MessageID.ascending()
      await Session.updateMessage({
        id: messageID,
        sessionID: foreign.id,
        role: "user",
        time: { created: Date.now() },
        agent: "default",
        model: { providerID: "openai", modelID: "gpt-5" },
        tools: {},
      } as MessageV2.User)
      await expect(
        offer({
          sourceID: current.session.id,
          messageID,
          title: "Invalid",
          body: "Invalid",
          contextRefs: [],
        }),
      ).rejects.toThrow("task_handoff_source_message_invalid")

      const proposed = await offer({
        sourceID: current.session.id,
        messageID: current.messageID,
        title: "Root peer",
        body: "Root peer body",
        contextRefs: [],
      })
      const assignment = await approve({ handoff: proposed, source: current })
      const confirmed = await SessionTaskHandoff.confirm(proposed.id, { assignmentID: assignment.id })
      expect((await Session.get(SessionID.make(confirmed.target_session_id!))).parentID).toBeUndefined()
    }))

  test("claims one fixed bootstrap and recovers a failed delivery without duplicate targets", () =>
    setup(async () => {
      const current = await source()
      const proposed = await offer({
        sourceID: current.session.id,
        messageID: current.messageID,
        title: "Recover peer",
        body: "Recover body",
        contextRefs: [],
      })
      let calls = 0
      const prompt = spyOn(SessionPrompt, "loop").mockImplementation((async () => {
        calls++
        return undefined
      }) as never)
      try {
        const assignment = await approve({ handoff: proposed, source: current })
        const confirmed = await SessionTaskHandoff.confirm(proposed.id, { assignmentID: assignment.id })
        const runs = Promise.all([SessionTaskHandoff.resume(proposed.id), SessionTaskHandoff.resume(proposed.id)])
        await until(() => calls === 1)
        expect(calls).toBe(1)
        await runs
        await until(() => SessionTaskHandoff.get(proposed.id).then((item) => item?.status === "started"))
        expect(await SessionTaskHandoff.confirm(proposed.id, { assignmentID: assignment.id })).toMatchObject({
          target_session_id: confirmed.target_session_id,
          target_task_id: confirmed.target_task_id,
        })
      } finally {
        prompt.mockRestore()
      }
      const row = Database.use((tx) =>
        tx
          .select()
          .from(SessionEventOutboxTable)
          .where(eq(SessionEventOutboxTable.dedupe_key, `task_handoff:${proposed.id}`))
          .get(),
      )
      expect(row?.status).toBe("delivered")
      expect(row?.payload).toMatchObject({
        handoff_id: proposed.id,
      })
      const saved = Database.use((tx) =>
        tx.select().from(TaskHandoffTable).where(eq(TaskHandoffTable.id, proposed.id)).get(),
      )
      expect(saved?.status).toBe("started")
      expect(row?.payload).toMatchObject({
        target_session_id: saved?.target_session_id,
        target_task_id: saved?.target_task_id,
      })
      const message = await MessageV2.get({ sessionID: current.session.id, messageID: current.messageID })
      const started = message.parts.find(
        (item): item is MessageV2.TextPart => item.type === "text" && item.metadata?.kind === "task_handoff_started",
      )
      expect(started?.metadata).toMatchObject({ handoff_id: proposed.id, status: "started" })
      expect(JSON.stringify(started?.metadata)).not.toContain("Recover body")
    }))

  test("persists enqueue failure and scan retries the same target and fixed message", () =>
    setup(async () => {
      const current = await source()
      const proposed = await offer({
        sourceID: current.session.id,
        messageID: current.messageID,
        title: "Retry peer",
        body: "Retry body",
        contextRefs: [],
      })
      const enqueue = SessionPrompt.enqueue
      let calls = 0
      const write = spyOn(SessionPrompt, "enqueue").mockImplementation((async (
        input: Parameters<typeof SessionPrompt.enqueue>[0],
      ) => {
        calls++
        if (calls === 1) throw new Error("enqueue rejected")
        return enqueue(input)
      }) as never)
      const loop = spyOn(SessionPrompt, "loop").mockImplementation((async () => undefined) as never)
      try {
        const assignment = await approve({ handoff: proposed, source: current })
        const confirmed = await SessionTaskHandoff.confirm(proposed.id, { assignmentID: assignment.id })
        await until(() => SessionTaskHandoff.get(proposed.id).then((item) => item?.status === "failed"))
        const failed = await SessionTaskHandoff.get(proposed.id)
        const before = Database.use((tx) =>
          tx
            .select()
            .from(SessionEventOutboxTable)
            .where(eq(SessionEventOutboxTable.dedupe_key, `task_handoff:${proposed.id}`))
            .get(),
        )
        expect(failed?.error).toBe("enqueue rejected")
        expect(before?.status).toBe("pending")

        expect(await SessionTaskHandoff.scan()).toEqual([true])
        await until(() => SessionTaskHandoff.get(proposed.id).then((item) => item?.status === "started"))
        const after = Database.use((tx) =>
          tx
            .select()
            .from(SessionEventOutboxTable)
            .where(eq(SessionEventOutboxTable.dedupe_key, `task_handoff:${proposed.id}`))
            .get(),
        )
        const started = await SessionTaskHandoff.get(proposed.id)
        expect(started?.target_session_id).toBe(confirmed.target_session_id)
        expect(started?.target_task_id).toBe(confirmed.target_task_id)
        expect(after?.payload.message_id).toBe(before?.payload.message_id)
        expect(await Session.children(current.session.id)).toHaveLength(0)
      } finally {
        loop.mockRestore()
        write.mockRestore()
      }
    }))

  test("retries a failed handoff with the same completed confirmation proof", () =>
    setup(async () => {
      const parent = await Session.create({})
      const current = await source(parent.id)
      const proposed = await offer({
        sourceID: current.session.id,
        messageID: current.messageID,
        title: "Confirm retry peer",
        body: "Confirm retry body",
        contextRefs: [],
      })
      const assignment = await approve({ handoff: proposed, source: current })
      const enqueue = SessionPrompt.enqueue
      let calls = 0
      const write = spyOn(SessionPrompt, "enqueue").mockImplementation((async (
        input: Parameters<typeof SessionPrompt.enqueue>[0],
      ) => {
        calls++
        if (calls === 1) throw new Error("confirm retry rejected")
        return enqueue(input)
      }) as never)
      const loop = spyOn(SessionPrompt, "loop").mockImplementation((async () => undefined) as never)
      try {
        const first = await SessionTaskHandoff.confirm(proposed.id, { assignmentID: assignment.id })
        await until(() => SessionTaskHandoff.get(proposed.id).then((item) => item?.status === "failed"))
        const before = Database.use((tx) =>
          tx
            .select()
            .from(SessionEventOutboxTable)
            .where(eq(SessionEventOutboxTable.dedupe_key, `task_handoff:${proposed.id}`))
            .get(),
        )

        const [retry, replay] = await Promise.all([
          SessionTaskHandoff.confirm(proposed.id, { assignmentID: assignment.id }),
          SessionTaskHandoff.confirm(proposed.id, { assignmentID: assignment.id }),
          SessionTaskHandoff.scan(),
        ])
        await until(() => SessionTaskHandoff.get(proposed.id).then((item) => item?.status === "started"))
        const after = Database.use((tx) =>
          tx
            .select()
            .from(SessionEventOutboxTable)
            .where(eq(SessionEventOutboxTable.dedupe_key, `task_handoff:${proposed.id}`))
            .get(),
        )

        expect(retry.target_session_id).toBe(first.target_session_id)
        expect(retry.target_task_id).toBe(first.target_task_id)
        expect(replay.target_session_id).toBe(first.target_session_id)
        expect(after?.id).toBe(before?.id)
        expect(after?.payload.message_id).toBe(before?.payload.message_id)
        expect(await Session.children(parent.id)).toHaveLength(2)
      } finally {
        write.mockRestore()
        loop.mockRestore()
      }
    }))

  test("recovers an expired delivering row from its fixed message without enqueueing twice", () =>
    setup(async () => {
      const current = await source()
      const proposed = await offer({
        sourceID: current.session.id,
        messageID: current.messageID,
        title: "Crash peer",
        body: "Crash body",
        contextRefs: [],
      })
      const fail = spyOn(SessionPrompt, "enqueue").mockImplementation((async () => {
        throw new Error("crash before enqueue")
      }) as never)
      const assignment = await approve({ handoff: proposed, source: current })
      const confirmed = await SessionTaskHandoff.confirm(proposed.id, { assignmentID: assignment.id })
      await until(() => SessionTaskHandoff.get(proposed.id).then((item) => item?.status === "failed"))
      fail.mockRestore()
      const row = Database.use((tx) =>
        tx
          .select()
          .from(SessionEventOutboxTable)
          .where(eq(SessionEventOutboxTable.dedupe_key, `task_handoff:${proposed.id}`))
          .get(),
      )!
      const messageID = MessageID.make(String(row.payload.message_id))
      await SessionPrompt.enqueue({
        sessionID: SessionID.make(confirmed.target_session_id ?? ""),
        messageID,
        agent: "default",
        noReply: true,
        metadata: { internal: true, source: "task_handoff_bootstrap" },
        parts: [{ type: "text", text: "fixed bootstrap" }],
      })
      Database.use((tx) =>
        tx
          .update(SessionEventOutboxTable)
          .set({ status: "delivering", updated_at: Date.now() - 31_000 })
          .where(eq(SessionEventOutboxTable.id, row.id))
          .run(),
      )
      let loops = 0
      const loop = spyOn(SessionPrompt, "loop").mockImplementation((async () => {
        loops++
        return undefined
      }) as never)
      const enqueue = spyOn(SessionPrompt, "enqueue")
      try {
        expect(await SessionTaskHandoff.resume(proposed.id)).toBe(true)
        expect(loops).toBe(1)
        expect(enqueue).toHaveBeenCalledTimes(0)
        expect((await SessionTaskHandoff.get(proposed.id))?.status).toBe("started")
      } finally {
        enqueue.mockRestore()
        loop.mockRestore()
      }
    }))

  test("cancels a proposal without a target and refuses later confirmation", () =>
    setup(async () => {
      const current = await source()
      const proposed = await offer({
        sourceID: current.session.id,
        messageID: current.messageID,
        title: "Cancelled peer",
        body: "Cancelled body",
        contextRefs: [],
      })
      expect((await SessionTaskHandoff.cancel(proposed.id))?.status).toBe("cancelled")
      const assignment = await approve({ handoff: proposed, source: current })
      await expect(SessionTaskHandoff.confirm(proposed.id, { assignmentID: assignment.id })).rejects.toThrow(
        "task_handoff_not_confirmable",
      )
      expect((await SessionTaskHandoff.get(proposed.id))?.target_session_id).toBeNull()
    }))

  test("rejects a canonical confirmation assignment whose plan differs from the proposal", () =>
    setup(async () => {
      const current = await source()
      const proposed = await offer({
        sourceID: current.session.id,
        messageID: current.messageID,
        title: "Canonical peer",
        body: "Expected body",
        contextRefs: [],
      })
      const assignment = await SessionAssignment.apply({
        actionID: "confirm_handoff",
        assignment: { op: "handoff", target: "peer" },
        messageID: current.messageID,
        plan: "Tampered body",
        runID: "run_handoff_tampered",
        sessionID: current.session.id,
        title: "Canonical peer",
      })
      expect(assignment).toBeDefined()
      if (!assignment) throw new Error("assignment missing")
      await expect(SessionTaskHandoff.confirm(proposed.id, { assignmentID: assignment.id })).rejects.toThrow(
        "task_handoff_confirmation_invalid",
      )
      expect((await SessionTaskHandoff.get(proposed.id))?.target_session_id).toBeNull()
    }))

  test("rejects a matching assignment created for a different action", () =>
    setup(async () => {
      const current = await source()
      const proposed = await offer({
        sourceID: current.session.id,
        messageID: current.messageID,
        title: "Action-bound peer",
        body: "Action-bound body",
        contextRefs: [],
      })
      const assignment = await SessionAssignment.apply({
        actionID: "different_action",
        assignment: { op: "handoff", target: "peer" },
        messageID: current.messageID,
        plan: proposed.body,
        runID: "different_run",
        sessionID: current.session.id,
        title: proposed.title,
      })
      if (!assignment) throw new Error("assignment missing")
      await expect(SessionTaskHandoff.confirm(proposed.id, { assignmentID: assignment.id })).rejects.toThrow(
        "task_handoff_confirmation_invalid",
      )
      expect((await SessionTaskHandoff.get(proposed.id))?.target_session_id).toBeNull()
    }))

  test("requires a canonical confirmation assignment before creating a target", () =>
    setup(async () => {
      const current = await source()
      const proposed = await offer({
        sourceID: current.session.id,
        messageID: current.messageID,
        title: "Protected peer",
        body: "Protected body",
        contextRefs: [],
      })
      const bypass = SessionTaskHandoff.confirm as unknown as (id: string) => Promise<SessionTaskHandoff.Info>
      await expect(bypass(proposed.id)).rejects.toThrow("task_handoff_confirmation_required")
      expect((await SessionTaskHandoff.get(proposed.id))?.target_session_id).toBeNull()
    }))

  test("retains the handoff archive when its target task is deleted", () =>
    setup(async () => {
      const current = await source()
      const proposed = await offer({
        sourceID: current.session.id,
        messageID: current.messageID,
        title: "Archived peer",
        body: "Archived body",
        contextRefs: [],
      })
      const assignment = await approve({ handoff: proposed, source: current })
      const loop = spyOn(SessionPrompt, "loop").mockImplementation((async () => undefined) as never)
      try {
        const confirmed = await SessionTaskHandoff.confirm(proposed.id, { assignmentID: assignment.id })
        await until(() => SessionTaskHandoff.get(proposed.id).then((item) => item?.status === "started"))
        Database.use((tx) =>
          tx
            .delete(SessionTaskTable)
            .where(eq(SessionTaskTable.id, confirmed.target_task_id ?? ""))
            .run(),
        )
        expect(await SessionTaskHandoff.get(proposed.id)).toMatchObject({
          id: proposed.id,
          target_task_id: confirmed.target_task_id,
          status: "started",
        })
      } finally {
        loop.mockRestore()
      }
    }))

  test("revalidates target ownership after loading the target session", () =>
    setup(async () => {
      const current = await source()
      const proposed = await offer({
        sourceID: current.session.id,
        messageID: current.messageID,
        title: "Changed peer",
        body: "Changed body",
        contextRefs: [],
      })
      const assignment = await approve({ handoff: proposed, source: current })
      const read = Session.get
      const session = spyOn(Session, "get").mockImplementation((async (id: SessionID) => {
        const result = await read(id)
        Database.use((tx) => tx.delete(SessionTaskTable).where(eq(SessionTaskTable.session_id, id)).run())
        return result
      }) as never)
      const enqueue = spyOn(SessionPrompt, "enqueue")
      try {
        await SessionTaskHandoff.confirm(proposed.id, { assignmentID: assignment.id })
        await until(() => SessionTaskHandoff.get(proposed.id).then((item) => item?.status === "failed"))
        expect(enqueue).toHaveBeenCalledTimes(0)
        expect(await SessionTaskHandoff.get(proposed.id)).toMatchObject({
          status: "failed",
          error: "task_handoff_target_invalid",
        })
      } finally {
        enqueue.mockRestore()
        session.mockRestore()
      }
    }))

  test("registers the fixed bootstrap with the prompt loop even when the target is busy", () =>
    setup(async () => {
      const current = await source()
      const proposed = await offer({
        sourceID: current.session.id,
        messageID: current.messageID,
        title: "Busy peer",
        body: "Busy body",
        contextRefs: [],
      })
      const assignment = await approve({ handoff: proposed, source: current })
      const busy = spyOn(SessionPrompt, "busy").mockReturnValue(true)
      const loop = spyOn(SessionPrompt, "loop").mockImplementation((async () => undefined) as never)
      try {
        await SessionTaskHandoff.confirm(proposed.id, { assignmentID: assignment.id })
        await until(() => loop.mock.calls.length === 1)
        expect(loop).toHaveBeenCalledTimes(1)
        expect(busy).toHaveBeenCalledTimes(0)
      } finally {
        loop.mockRestore()
        busy.mockRestore()
      }
    }))

  test("does not expose handoffs outside the current project scope", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })
    const saved = await Instance.provide({
      directory: first.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_handoff_first"),
          fn: async () => {
            const current = await source()
            return offer({
              sourceID: current.session.id,
              messageID: current.messageID,
              title: "Scoped peer",
              body: "Scoped body",
              contextRefs: [],
            })
          },
        }),
    })
    await Instance.provide({
      directory: second.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_handoff_second"),
          fn: async () => {
            expect(await SessionTaskHandoff.get(saved.id)).toBeUndefined()
            expect(await SessionTaskHandoff.cancel(saved.id)).toBeUndefined()
            await expect(SessionTaskHandoff.confirm(saved.id, { assignmentID: "foreign" })).rejects.toThrow(
              "task_handoff_not_found",
            )
            expect(await SessionTaskHandoff.scan()).toEqual([])
          },
        }),
    })
  })
})
