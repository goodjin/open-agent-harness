import { describe, expect, test } from "bun:test"
import type { SessionTaskRevisionResponse } from "@open-agent-harness/sdk/v2/client"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import {
  action,
  active,
  choose,
  compact,
  content,
  handoff,
  initial,
  observe,
  progress,
  present,
  refresh,
  requests,
  single,
  stamp,
  view,
  watch,
  type Badge,
  type Feed,
  type Current,
  type Legacy,
} from "./session-task-data"
import { proposal, proposalError, proposalFlow, proposalIndex, proposals, type ProposalPart } from "./session-task-proposal"

const task = (value: Partial<Current> = {}) =>
  ({
    id: "task_1",
    session_id: "session_1",
    title: "Ship the task view",
    version: 1,
    status: "running",
    body: "# Task",
    progress: { completed: 1, total: 3 },
    actions: [],
    handoffs: [],
    time: { created: 1, updated: 2 },
    ...value,
  }) as Current

const revision = (value: Partial<SessionTaskRevisionResponse> = {}) =>
  ({
    id: "revision_1",
    session_id: "session_1",
    title: "Archived task",
    version: 1,
    status: "archived",
    body: "# Archived",
    workflow: { actions: [], compact: { runs: 2, completed: 3, total: 4 } },
    actions: [],
    handoffs: [],
    reason: null,
    archive_reason: "Revised",
    time: { created: 1, archived: 2 },
    ...value,
  }) as SessionTaskRevisionResponse

const deferred = <T>() => {
  let resolve = (_value: T) => {}
  let reject = (_error: unknown) => {}
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

describe("session task", () => {
  test("presents normal, legacy, missing, and error feeds without crossing union fields", () => {
    const current = task()
    const legacy = {
      type: "legacy_multi_run",
      count: 2,
      truncated: false,
      proposal: {
        status: "pending_confirmation",
        session_id: "session_1",
        runs: [
          {
            run_id: "run_old",
            title: "Legacy task",
            status: "completed",
            time: { started: 1, completed: 2 },
          },
        ],
      },
    } as Legacy

    expect(present({ current, loading: false })).toEqual({ kind: "current", current })
    expect(present({ current: legacy, loading: false })).toEqual({ kind: "legacy", legacy })
    expect(legacy.proposal.runs[0]?.title).toBe("Legacy task")
    expect(present({ loading: false })).toEqual({ kind: "unbound" })
    expect(present({ loading: false, error: "404" })).toEqual({ kind: "error", error: "404" })
    const detail = revision()
    expect(present({ current, loading: false, error: "refresh failed" }, detail)).toEqual({
      kind: "detail",
      detail,
    })
    expect(present({ current: legacy, loading: false })).not.toHaveProperty("current")
    expect(present({ current, loading: false })).not.toHaveProperty("legacy")
    expect(present({ current, loading: false, error: "refresh failed" }, detail)).not.toHaveProperty("error")
  })

  const part = (metadata: Record<string, unknown>, value: Partial<ProposalPart> = {}): ProposalPart => ({
    type: "text",
    text: "runtime projection",
    synthetic: true,
    ignored: true,
    metadata,
    ...value,
  })

  test("accepts only runtime-projected task proposal parts", () => {
    expect(
      proposal(
        part({
          kind: "task_update_proposal",
          proposal_id: "run_1:update_1",
          old_revision_id: "revision_1",
          difference_summary: "Changed title and actions",
          affected_child_ids: ["session_child"],
          reusable_result_refs: ["result_1"],
          status: "pending",
        }),
        "# Updated task",
      ),
    ).toMatchObject({
      kind: "update",
      id: "run_1:update_1",
      revision: "revision_1",
      summary: "Changed title and actions",
      children: ["session_child"],
      refs: ["result_1"],
      body: "# Updated task",
      status: "proposed",
    })
    expect(
      proposal(
        part({
          kind: "task_handoff_proposal",
          handoff_id: "handoff_1",
          proposal_id: "run_1:handoff_1",
          title: "Peer task",
          context_refs: ["result:one"],
          status: "proposed",
        }),
        "# Peer task",
      ),
    ).toMatchObject({
      kind: "handoff",
      handoff: "handoff_1",
      title: "Peer task",
      refs: ["result:one"],
      body: "# Peer task",
      status: "proposed",
    })
    expect(proposal(part({ kind: "task_update_proposal", proposal_id: "forged" }, { synthetic: false }))).toBeUndefined()
    expect(proposal(part({ kind: "task_handoff_proposal", handoff_id: "forged" }, { ignored: false }))).toBeUndefined()
    expect(proposal({ type: "text", text: "user", metadata: { kind: "task_update_proposal" } })).toBeUndefined()
  })

  test("maps persisted update and handoff proposal statuses", () => {
    const update = (status: string) =>
      proposal(part({ kind: "task_update_proposal", proposal_id: "run:update", old_revision_id: "revision_1", status }))?.status
    const handoff = (status: string, kind = "task_handoff_proposal") =>
      proposal(part({ kind, proposal_id: "run:handoff", handoff_id: "handoff_1", status }))?.status

    expect([update("pending"), update("revising"), update("failed"), update("cancelled")]).toEqual([
      "proposed",
      "revising",
      "failed",
      "cancelled",
    ])
    expect([
      handoff("proposed"),
      handoff("creating"),
      handoff("started", "task_handoff_started"),
      handoff("failed"),
      handoff("cancelled"),
    ]).toEqual(["proposed", "creating", "started", "failed", "cancelled"])
  })

  test("does not render isolated update progress and merges matching progress into its proposal", () => {
    const progress = part({
      kind: "task_update_progress",
      proposal_id: "run:update",
      draft_revision_id: "revision_2",
      difference_summary: "Revising actions",
      affected_child_ids: ["session_child"],
      reusable_result_refs: ["result_2"],
      status: "revising",
    })
    expect(proposal(progress)).toBeUndefined()
    expect(proposals([progress], new Map())).toEqual([])
    expect(
      proposals(
        [
          part({
            kind: "task_update_proposal",
            proposal_id: "run:update",
            old_revision_id: "revision_1",
            difference_summary: "Initial diff",
            status: "pending",
          }),
          progress,
        ],
        new Map([["run:update", "# Updated task"]]),
      ),
    ).toEqual([
      expect.objectContaining({
        id: "run:update",
        revision: "revision_2",
        summary: "Revising actions",
        children: ["session_child"],
        refs: ["result_2"],
        status: "revising",
      }),
    ])
  })

  test("maps blocked update recovery to a retryable failure", () => {
    const items = proposals(
      [
        part({
          kind: "task_update_proposal",
          proposal_id: "run:update",
          old_revision_id: "revision_1",
          status: "pending",
        }),
        part({
          kind: "task_update_progress",
          proposal_id: "run:update",
          draft_revision_id: "revision_2",
          status: "blocked",
          error: "Bootstrap failed",
        }),
      ],
      new Map(),
    )
    expect(items).toEqual([expect.objectContaining({ status: "failed", error: "Bootstrap failed" })])
  })

  test("merges handoff started projection with its proposal content and target", () => {
    expect(
      proposals(
        [
          part({
            kind: "task_handoff_proposal",
            handoff_id: "handoff_1",
            proposal_id: "run:handoff",
            title: "Peer task",
            context_refs: ["result:one"],
            status: "proposed",
          }),
          part({
            kind: "task_handoff_started",
            handoff_id: "handoff_1",
            context_refs: ["result:one"],
            target_session_id: "session_target",
            status: "started",
          }),
        ],
        new Map([["run:handoff", "# Peer task"]]),
      ),
    ).toEqual([
      expect.objectContaining({
        id: "run:handoff",
        handoff: "handoff_1",
        body: "# Peer task",
        refs: ["result:one"],
        status: "started",
        target: "session_target",
      }),
    ])
  })

  test("uses durable confirmation decisions when the proposal projection is stale", () => {
    const input = part({
      kind: "task_update_proposal",
      proposal_id: "run:update",
      old_revision_id: "revision_1",
      status: "pending",
    })
    expect(proposals([input], new Map(), new Map([["run:update", "cancelled"]]))[0]?.status).toBe("cancelled")
    expect(proposals([input], new Map(), new Map([["run:update", "confirmed"]]))[0]?.status).toBe("revising")
  })

  test("prevents duplicate confirmations and reuses the handoff id when retrying", async () => {
    const first = deferred<{ status: string }>()
    const calls: { handoff?: string; action: string }[] = []
    const states: string[] = []
    const flow = proposalFlow({
      send(input, action) {
        calls.push({ handoff: input.kind === "handoff" ? input.handoff : undefined, action })
        return calls.length === 1 ? first.promise : Promise.resolve({ status: "creating" })
      },
      state: (value) => states.push(value.status),
      focus() {},
    })
    const value = proposal(
      part({
        kind: "task_handoff_proposal",
        handoff_id: "handoff_fixed",
        proposal_id: "run:handoff",
        status: "failed",
      }),
    )!
    flow.change(value)
    const pending = flow.confirm()
    await flow.confirm()
    first.reject(new Error("failed"))
    await pending
    await flow.confirm()

    expect(calls).toEqual([
      { handoff: "handoff_fixed", action: "confirm" },
      { handoff: "handoff_fixed", action: "confirm" },
    ])
    expect(states).toEqual(["failed", "confirming", "failed", "confirming", "creating"])
  })

  test("keeps confirmation in flight across same-proposal reparses", async () => {
    const pending = deferred<{ status: string }>()
    const states: string[] = []
    let calls = 0
    const flow = proposalFlow({
      send() {
        calls++
        return pending.promise
      },
      state: (value) => states.push(value.status),
      focus() {},
    })
    const value = () =>
      proposal(
        part({
          kind: "task_update_proposal",
          proposal_id: "run:update",
          old_revision_id: "revision_1",
          difference_summary: `render ${states.length}`,
        }),
      )!
    flow.change(value(), "session_1")
    const request = flow.confirm()
    flow.change(value(), "session_1")
    await flow.confirm()
    pending.resolve({ status: "revising" })
    await request

    expect(calls).toBe(1)
    expect(states).toEqual(["proposed", "confirming", "revising"])
  })

  test("keeps event progress when update HTTP success omits status", async () => {
    const response = deferred<Record<string, never>>()
    const states: string[] = []
    const update = (status: string) =>
      proposal(
        part({
          kind: "task_update_proposal",
          proposal_id: "run:update",
          old_revision_id: "revision_1",
          status,
        }),
      )!
    const flow = proposalFlow({
      send: async () => response.promise,
      state: (value) => states.push(value.status),
      focus() {},
    })
    flow.change(update("pending"), "session_1")
    const request = flow.confirm()
    flow.change(update("revising"), "session_1")
    response.resolve({})
    await request
    expect(states.at(-1)).toBe("revising")
    expect(states.slice(1)).not.toContain("proposed")
  })

  test("indexes proposal parts by assistant parent in one message pass", () => {
    let reads = 0
    const messages = Array.from({ length: 2_000 }, (_, index) => ({
      id: `message_${index}`,
      role: index % 2 ? "assistant" : "user",
      parentID: index % 2 ? `message_${index - 1}` : undefined,
    }))
    const parts = new Proxy(
      Object.fromEntries(messages.map((item) => [item.id, [item.id]])),
      {
        get(target, key: string) {
          reads++
          return target[key]
        },
      },
    )
    const index = proposalIndex(messages, parts)
    expect(index.get("message_0")).toEqual(["message_1"])
    expect(index.get("message_1998")).toEqual(["message_1999"])
    expect(reads).toBe(1_000)
  })

  test("does not regress a local failure when an old proposed projection reparses", async () => {
    const states: { status: string; error?: string }[] = []
    const update = (status = "pending", error?: string) =>
      proposal(
        part({
          kind: "task_update_proposal",
          proposal_id: "run:update",
          old_revision_id: "revision_1",
          status,
          error,
        }),
      )!
    const flow = proposalFlow({
      send: async () => Promise.reject(new Error("Confirmation failed")),
      state: (value) => states.push(value),
      focus() {},
    })
    flow.change(update(), "session_1")
    await flow.confirm()
    flow.change(update(), "session_1")

    expect(states.at(-1)).toMatchObject({ status: "failed", error: "Confirmation failed" })
    expect(states.map((item) => item.status)).toEqual(["proposed", "confirming", "failed"])
    flow.change(update("failed", "Server failure"), "session_1")
    expect(states.at(-1)).toMatchObject({ status: "failed", error: "Server failure" })
  })

  test("keeps confirmed progress over stale proposed and accepts later durable states", async () => {
    const states: { id: string; status: string }[] = []
    const handoff = (status: string, id = "run:handoff") =>
      proposal(
        part({
          kind: status === "started" ? "task_handoff_started" : "task_handoff_proposal",
          proposal_id: id,
          handoff_id: id === "run:handoff" ? "handoff_1" : "handoff_2",
          status,
          target_session_id: status === "started" ? "session_target" : undefined,
        }),
      )!
    const flow = proposalFlow({
      send: async () => ({ status: "creating" }),
      state: (value) => states.push(value),
      focus() {},
    })
    flow.change(handoff("proposed"), "session_1")
    await flow.confirm()
    flow.change(handoff("proposed"), "session_1")
    expect(states.map((item) => item.status)).toEqual(["proposed", "confirming", "creating"])

    flow.change(handoff("failed"), "session_1")
    flow.change(handoff("cancelled"), "session_1")
    flow.change(handoff("started"), "session_1")
    flow.change(handoff("failed"), "session_1")
    expect(states.slice(-3).map((item) => item.status)).toEqual(["failed", "cancelled", "started"])

    flow.change(handoff("proposed", "run:next"), "session_1")
    expect(states.at(-1)).toMatchObject({ id: "run:next", status: "proposed" })

    const updates: string[] = []
    const update = () =>
      proposal(part({ kind: "task_update_proposal", proposal_id: "run:update", old_revision_id: "revision_1" }))!
    const revise = proposalFlow({
      send: async () => ({ status: "revising" }),
      state: (value) => updates.push(value.status),
      focus() {},
    })
    revise.change(update(), "session_1")
    await revise.confirm()
    revise.change(update(), "session_1")
    expect(updates).toEqual(["proposed", "confirming", "revising"])
  })

  test("keeps discussion dismissed across reparses and resets for a new scoped proposal", () => {
    const states: { id: string; dismissed: boolean }[] = []
    const flow = proposalFlow({
      send: async () => ({}),
      state: (value) => states.push(value),
      focus() {},
    })
    const update = (id: string) =>
      proposal(part({ kind: "task_update_proposal", proposal_id: id, old_revision_id: "revision_1" }))!
    flow.change(update("run:update"), "session_1")
    flow.discuss()
    flow.change(update("run:update"), "session_1")
    expect(states.at(-1)).toMatchObject({ id: "run:update", dismissed: true })
    expect(states).toHaveLength(2)

    flow.change(update("run:update"), "session_2")
    expect(states.at(-1)).toMatchObject({ id: "run:update", dismissed: false })
    flow.change(update("run:next"), "session_2")
    expect(states.at(-1)).toMatchObject({ id: "run:next", dismissed: false })
  })

  test("formats structured SDK errors and safe fallbacks", async () => {
    expect(proposalError({ name: "ConflictError", data: { message: "Proposal is stale" } }, "Request failed")).toBe(
      "Proposal is stale",
    )
    expect(proposalError(new Error("Network failed"), "Request failed")).toBe("Network failed")
    expect(proposalError("Offline", "Request failed")).toBe("Offline")
    expect(proposalError({ unexpected: true }, "Request failed")).toBe("Request failed")
    const states: { status: string; error?: string }[] = []
    const flow = proposalFlow({
      send: async () => Promise.reject({ name: "ConflictError", data: { message: "Proposal is stale" } }),
      state: (value) => states.push(value),
      focus() {},
      error: (error) => proposalError(error, "Request failed"),
    })
    flow.change(
      proposal(part({ kind: "task_update_proposal", proposal_id: "run:update", old_revision_id: "revision_1" }))!,
    )
    await flow.confirm()
    expect(states.at(-1)).toMatchObject({ status: "failed", error: "Proposal is stale" })
  })

  test("persists cancellation and discussion only dismisses then focuses the composer", async () => {
    const calls: string[] = []
    let focused = 0
    const states: { status: string; dismissed: boolean }[] = []
    const flow = proposalFlow({
      send(_input, action) {
        calls.push(action)
        return Promise.resolve({ status: "cancelled" })
      },
      state: (value) => states.push(value),
      focus: () => focused++,
    })
    flow.change(
      proposal(part({ kind: "task_update_proposal", proposal_id: "run:update", old_revision_id: "revision_1" }))!,
    )
    flow.discuss()
    expect(calls).toEqual([])
    expect(focused).toBe(1)
    expect(states.at(-1)).toMatchObject({ status: "proposed", dismissed: true })
    await flow.cancel()
    expect(calls).toEqual(["cancel"])
    expect(states.at(-1)).toMatchObject({ status: "cancelled" })
  })

  test("isolates late proposal responses and ignores responses after disposal", async () => {
    const old = deferred<{ status: string; target_session_id?: string }>()
    const gone = deferred<{ status: string }>()
    const states: string[] = []
    let calls = 0
    const flow = proposalFlow({
      send() {
        calls++
        return calls === 1 ? old.promise : gone.promise
      },
      state: (value) => states.push(`${value.id}:${value.status}`),
      focus() {},
    })
    const one = proposal(part({ kind: "task_handoff_proposal", handoff_id: "handoff_1", proposal_id: "run:one" }))!
    const two = proposal(part({ kind: "task_handoff_proposal", handoff_id: "handoff_2", proposal_id: "run:two" }))!
    flow.change(one)
    const pending = flow.confirm()
    flow.change(two)
    old.resolve({ status: "started", target_session_id: "session_old" })
    await pending
    expect(states.at(-1)).toBe("run:two:proposed")
    const stopping = flow.confirm()
    flow.stop()
    gone.resolve({ status: "started" })
    await stopping
    expect(states.at(-1)).toBe("run:two:confirming")
  })
  test("maps unbound and active task statuses", () => {
    expect(view()).toMatchObject({ status: "unbound", showResult: false })
    expect(view(task())).toMatchObject({ status: "running", showResult: false })
    expect(view(task({ status: "revising" }))).toMatchObject({ status: "revising", showResult: false })
  })

  test("shows terminal task results without guessing from actions", () => {
    expect(view(task({ status: "completed", result: "Done", result_source: "protocol" }))).toMatchObject({
      status: "completed",
      result: "recorded",
      showResult: true,
    })
    expect(view(task({ status: "blocked", result: "Partial", result_source: "fallback_summary" }))).toMatchObject({
      status: "blocked",
      result: "fallback",
      showResult: true,
    })
    expect(view(task({ status: "failed" }))).toMatchObject({
      status: "failed",
      result: "missing",
      showResult: true,
    })
    expect(view(task({ status: "completed", result: "Unattributed" }))).toMatchObject({ result: "missing" })
    expect(view(task({ status: "completed", result_source: "fallback_summary" }))).toMatchObject({
      result: "missing",
    })
    expect(content(task({ status: "completed", result: "Unattributed" }))).toBeUndefined()
    expect(content(task({ status: "completed", result: "Trusted", result_source: "protocol" }))).toBe("Trusted")
    expect(
      content(
        revision({ result: "Unclassified action result", result_source: "action_result" }),
      ),
    ).toBeUndefined()
    expect(
      view(task({ status: "completed", result: "Trusted", result_source: "action_result" })).result,
    ).toBe("recorded")
  })

  test("uses completed plus skipped actions and compact history progress", () => {
    expect(
      progress(
        revision({
          actions: [{ status: "completed" }, { status: "skipped" }, { status: "failed" }] as never,
        }),
      ),
    ).toEqual({ completed: 5, total: 7 })
    expect(progress(task({ progress: { completed: 4, total: 9 } }))).toEqual({ completed: 4, total: 9 })
  })

  test("maps action and handoff statuses to bilingual labels", () => {
    expect(en[action("skipped")]).toBe("Skipped")
    expect(zh[action("skipped")]).toBe("已跳过")
    expect(en[handoff("failed")]).toBe("Failed")
    expect(zh[handoff("failed")]).toBe("失败")
  })

  test("drops every old session request after reset", async () => {
    const loader = requests()
    const values: string[] = []
    const current = deferred<string>()
    const history = deferred<string>()
    const detail = deferred<string>()
    const signals: AbortSignal[] = []
    const pending = [
      loader.run(
        "current",
        (signal) => (signals.push(signal), current.promise),
        (value) => values.push(value),
      ),
      loader.run(
        "history",
        (signal) => (signals.push(signal), history.promise),
        (value) => values.push(value),
      ),
      loader.run(
        "detail",
        (signal) => (signals.push(signal), detail.promise),
        (value) => values.push(value),
      ),
    ]

    loader.reset()
    current.resolve("old current")
    history.resolve("old history")
    detail.resolve("old detail")
    await Promise.all(pending)

    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(values).toEqual([])
  })

  test("keeps only the latest repeated current and revision request", async () => {
    const loader = requests()
    const values: string[] = []
    const first = deferred<string>()
    const second = deferred<string>()
    const old = loader.run(
      "current",
      () => first.promise,
      (value) => values.push(value),
    )
    const fresh = loader.run(
      "current",
      () => second.promise,
      (value) => values.push(value),
    )
    first.resolve("old current")
    second.resolve("new current")
    await Promise.all([old, fresh])

    const v1 = deferred<string>()
    const v2 = deferred<string>()
    const oldRevision = loader.run(
      "detail",
      () => v1.promise,
      (value) => values.push(value),
    )
    const newRevision = loader.run(
      "detail",
      () => v2.promise,
      (value) => values.push(value),
    )
    v2.resolve("revision 2")
    v1.resolve("revision 1")
    await Promise.all([oldRevision, newRevision])

    expect(values).toEqual(["new current", "revision 2"])
  })

  test("refreshes while mounted and clears its timer on cleanup", () => {
    let tick = () => {}
    let cleared = false
    const calls: number[] = []
    const stop = refresh(
      () => calls.push(1),
      25,
      {
        set(fn, delay) {
          tick = fn
          expect(delay).toBe(25)
          return 7
        },
        clear(id) {
          expect(id).toBe(7)
          cleared = true
        },
      },
    )
    tick()
    tick()
    stop()
    expect(calls).toHaveLength(2)
    expect(cleared).toBe(true)
  })

  test("does not starve a slow current request across poll and status refreshes", async () => {
    const loader = requests()
    const first = deferred<Current>()
    const second = deferred<Current>()
    const old = deferred<Current>()
    const next = deferred<Current>()
    const queues = { session_1: [first, second, old], session_2: [next] }
    const signals: AbortSignal[] = []
    let local: Badge | undefined
    let tick = () => {}
    let listener = (_event: { properties: { sessionID: string } }) => {}
    let calls = 0
    const load = (sessionID: string) =>
      loader.run(
        "current",
        (signal) => {
          calls++
          signals.push(signal)
          return queues[sessionID as keyof typeof queues].shift()!.promise
        },
        (value) => {
          local = { sessionID, value: compact(value) }
        },
      )
    const flight = single(load, loader.reset)
    const poll = refresh(() => flight.refresh("session_1"), 25, {
      set(fn) {
        tick = fn
        return 1
      },
      clear() {},
    })
    const bind = watch(
      (_type, fn) => {
        listener = fn
        return () => {}
      },
      (sessionID) => flight.refresh(sessionID),
    )

    bind("session_1")
    void flight.change("session_1")
    await Promise.resolve()
    await Promise.resolve()
    expect(choose("session_1", local)).toBeUndefined()
    tick()
    tick()
    listener({ properties: { sessionID: "session_1" } })
    await Promise.resolve()

    expect(calls).toBe(1)
    expect(signals[0]?.aborted).toBe(false)
    first.resolve(task({ status: "running" }))
    await Bun.sleep(0)
    expect(choose("session_1", local)?.status).toBe("running")
    expect(calls).toBe(2)
    second.resolve(task({ status: "completed" }))
    await Bun.sleep(0)
    expect(choose("session_1", local)?.status).toBe("completed")
    expect(
      choose("session_1", { sessionID: "session_1", value: undefined }, compact(task({ status: "completed" }))),
    ).toBeUndefined()

    void flight.refresh("session_1")
    await Promise.resolve()
    await Promise.resolve()
    const fallback = compact(task({ id: "task_2", session_id: "session_2", status: "waiting_user" }))
    void flight.change("session_2")
    expect(signals[2]?.aborted).toBe(true)
    expect(choose("session_2", local, fallback)?.status).toBe("waiting_user")
    old.resolve(task({ status: "failed" }))
    next.resolve(task({ id: "task_2", session_id: "session_2", status: "running" }))
    await Bun.sleep(0)
    expect(calls).toBe(4)
    expect(choose("session_2", local)?.status).toBe("running")

    poll()
    bind()
    flight.stop()
  })

  test("updates the timeline badge with bounded refreshes without mounting the task tab", async () => {
    const missing = deferred<Current>()
    const running = deferred<Current>()
    const completed = deferred<Current>()
    const error = deferred<Current>()
    const old = deferred<Current>()
    const next = deferred<Current>()
    const queues = { session_1: [missing, running, completed, error, old], session_2: [next] }
    const signals: AbortSignal[] = []
    const listeners = new Set<(event: { properties: { sessionID: string } }) => void>()
    let tick = () => {}
    let local: Feed | undefined
    let calls = 0
    const monitor = observe({
      on(type, fn) {
        expect(type).toBe("session.status")
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
      load(sessionID, signal) {
        calls++
        signals.push(signal)
        return queues[sessionID as keyof typeof queues].shift()!.promise
      },
      done(value) {
        local = value
      },
      missing: (err) => (err as { status?: number }).status === 404,
      error: () => "Failed",
      delay: 25,
      timers: {
        set(fn) {
          tick = fn
          return 1
        },
        clear() {},
      },
    })
    const event = (sessionID: string) =>
      listeners.forEach((fn) => fn({ properties: { sessionID } }))

    monitor.change("session_1")
    await Promise.resolve()
    await Promise.resolve()
    missing.reject({ status: 404 })
    await Bun.sleep(0)
    expect(choose("session_1", local)).toBeUndefined()

    event("session_1")
    tick()
    tick()
    event("session_1")
    await Bun.sleep(0)
    expect(calls).toBe(2)
    expect(signals[1]?.aborted).toBe(false)
    running.resolve(task({ status: "running" }))
    await Bun.sleep(0)
    expect(choose("session_1", local)?.status).toBe("running")
    expect(active(local?.current)?.body).toBe("# Task")
    expect(calls).toBe(3)
    completed.resolve(task({ status: "completed" }))
    await Bun.sleep(0)
    expect(choose("session_1", local)?.status).toBe("completed")

    event("session_1")
    await Promise.resolve()
    error.reject({ status: 500 })
    await Bun.sleep(0)
    expect(choose("session_1", local)?.status).toBe("completed")

    event("session_1")
    await Bun.sleep(0)
    local = undefined
    monitor.change("session_2")
    expect(signals[4]?.aborted).toBe(true)
    old.resolve(task({ status: "failed" }))
    next.resolve(task({ id: "task_2", session_id: "session_2", status: "running" }))
    await Bun.sleep(0)
    expect(calls).toBe(6)
    expect(choose("session_2", local)?.status).toBe("running")
    expect(listeners.size).toBe(1)

    monitor.stop()
    expect(listeners.size).toBe(0)
  })

  test("rebinds the mounted task listener when its session prop changes", () => {
    const listeners = new Set<(event: { properties: { sessionID: string } }) => void>()
    const calls: string[] = []
    const bind = watch(
      (type, fn) => {
        expect(type).toBe("session.status")
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
      (sessionID) => calls.push(sessionID),
    )
    const emit = (sessionID: string) =>
      listeners.forEach((listener) => listener({ properties: { sessionID } }))

    expect(typeof bind).toBe("function")
    bind("session_1")
    emit("session_1")
    bind("session_2")
    expect(listeners.size).toBe(1)
    emit("session_1")
    emit("session_2")
    bind()
    emit("session_2")

    expect(calls).toEqual(["session_1", "session_2"])
    expect(listeners.size).toBe(0)
  })

  test("formats task timestamps with the active language locale", () => {
    const value = Date.UTC(2026, 6, 18, 12, 30)
    expect(stamp(value, "zh-CN")).toBe(
      new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(value),
    )
    expect(stamp(value, "en-US")).toBe(
      new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(value),
    )
  })

  test("starts with current, history, and revision state cleared", () => {
    expect(initial()).toEqual({
      current: undefined,
      history: { loaded: false, items: [] },
      detail: undefined,
      loading: { current: true, history: false, detail: false },
      error: { current: undefined, history: undefined, detail: undefined },
    })
  })

  test("receives current externally and loads history details only from explicit actions", async () => {
    const src = await Bun.file(new URL("session-task.tsx", import.meta.url)).text()

    expect(src).not.toContain("sdk.client.session.task.current")
    expect(src).toContain("const feed = props.feed")
    expect(src).toContain("sdk.client.session.task.history")
    expect(src).toContain("sdk.client.session.task.revision")
    expect(src).toContain("createEffect")
    expect(src).toContain("onClick={() => void history()}")
    expect(src).toContain("onClick={() => void revision(item.version)}")
  })

  test("renders the task in the required order and keeps history read only", async () => {
    const src = await Bun.file(new URL("session-task.tsx", import.meta.url)).text()
    const title = src.indexOf('language.t("session.task.current")')
    const body = src.indexOf("<Markdown text={task().body}")
    const progress = src.indexOf('language.t("session.task.progress")')
    const result = src.indexOf('language.t("session.task.result")')
    const handoff = src.indexOf('language.t("session.task.handoffs")')

    expect([title, body, progress, result, handoff].every((item) => item >= 0)).toBe(true)
    expect(title).toBeLessThan(body)
    expect(body).toBeLessThan(progress)
    expect(progress).toBeLessThan(result)
    expect(result).toBeLessThan(handoff)
    expect(src).toContain('language.t("session.task.return")')
    expect(src).toContain('language.t("session.task.archived"')
    expect(src).toContain("when={text()}")
    expect(src).not.toContain("when={task().result}")
    expect(src).toContain("item.stopped_child_count")
    expect(src).toContain("item.result.status")
    expect(src).toContain("item.target_session_id")
    expect(src).toContain("item.error")
    expect(src).not.toContain("watch(sdk.event.on")
    expect(src).toContain("language.intl()")
    expect(src).toContain('aria-live="polite"')
    expect(src).toContain('role="alert"')
    expect(src).not.toContain("resume")
  })

  test("renders multi-run legacy proposals without reading current task fields", async () => {
    const data = await Bun.file(new URL("session-task-data.ts", import.meta.url)).text()
    const src = await Bun.file(new URL("session-task.tsx", import.meta.url)).text()

    expect(data).toContain('task.type === "legacy_multi_run"')
    expect(src).toContain('language.t("session.task.legacy.title")')
    expect(src).toContain('language.t("session.task.legacy.description"')
    expect(src).toContain("legacy()?.proposal.runs")
    expect(src).toContain('screen().kind === "unbound"')
    expect(src.indexOf('when={legacy()}')).toBeLessThan(src.indexOf('when={shown()}'))
  })

  test("replaces the runs entry without deleting its compatibility component", async () => {
    const page = await Bun.file(new URL("../session.tsx", import.meta.url)).text()

    expect(page).toContain('sessionView: "timeline" as "timeline" | "logs" | "task"')
    expect(page).toContain('language.t("session.tab.task")')
    expect(page).toContain("<SessionTask")
    expect(page).not.toContain('from "@/pages/session/session-runs"')
    expect(await Bun.file(new URL("session-runs.tsx", import.meta.url)).exists()).toBe(true)
  })

  test("wires current task summaries to the page lifecycle", async () => {
    const page = await Bun.file(new URL("../session.tsx", import.meta.url)).text()
    const component = await Bun.file(new URL("session-task.tsx", import.meta.url)).text()
    expect(page).toContain("const monitor = observe")
    expect(page).toContain("monitor.change(id)")
    expect(page).toContain("onCleanup(monitor.stop)")
    expect(page).toContain("choose(params.id, latest()?.ready ? latest() : undefined, info()?.task)")
    expect(page.indexOf("const monitor = observe")).toBeLessThan(page.indexOf("const taskMode ="))
    expect(page).not.toContain("onSummary=")
    expect(component).not.toContain("watch(sdk.event.on")
    expect(component).not.toContain("refresh(() =>")
  })

  test("uses dedicated proposal cards instead of the generic confirmation question", async () => {
    const src = await Bun.file(new URL("message-timeline.tsx", import.meta.url)).text()
    expect(src).toContain("<SessionTaskProposal")
    expect(src).toContain("!taskQuestion()")
  })
})
