import { PermissionNext } from "@/permission/next"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Snapshot } from "@/snapshot"
import { ForbiddenError, NotFoundError } from "@/storage/db"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import { WorkflowParser } from "./parser"
import { loader } from "./loader"
import { WorkflowState } from "./state"
import { Audit } from "@/observability/audit"

export namespace WorkflowExecutor {
  const prefix = "workflow"
  export const InvalidError = NamedError.create("WorkflowInvalidError", z.object({ message: z.string() }))

  type Gate =
    | { status: "allow" }
    | { status: "miss"; reason: string }
    | { status: "waiting_permission"; step: string; reason: string; guard?: WorkflowState.Guard }
    | { status: "error"; step: string; reason: string; policy?: boolean }
  type Move =
    | { status: "next"; step: WorkflowParser.Step }
    | { status: "complete" }
    | { status: "waiting_permission"; step: string; reason: string; guard?: WorkflowState.Guard }
    | { status: "error"; step: string; reason: string; policy?: boolean }

  export async function list() {
    const source = await loader()
    const loaded = await source.load()
    return loaded.workflows.map((item) => ({
      id: item.workflow.id,
      name: item.workflow.name,
      description: item.workflow.description,
      version: item.workflow.version,
      source: item.source,
      path: item.path,
    }))
  }

  export async function runs() {
    const result: WorkflowState.Info[] = []
    for (const session of Session.list({ directory: Instance.directory })) {
      if (!visible(session)) continue
      const state = WorkflowState.read(session.dsl_context)
      if (state) result.push(state)
    }
    return result
  }

  export async function status(sessionID: SessionID) {
    const session = await bound(sessionID)
    return WorkflowState.read(session.dsl_context)
  }

  export async function run(input: {
    sessionID: SessionID
    workflowID: string
    variables?: Record<string, unknown>
  }) {
    const session = await bound(input.sessionID)
    const source = await loader()
    const item = await source.get(input.workflowID)
    if (!item) throw new NotFoundError({ message: `Workflow not found: ${input.workflowID}` })
    const now = Date.now()
    const first = item.workflow.steps[0]
    const variables = variablesFor(item.workflow, input.variables)
    const state: WorkflowState.Info = {
      runID: `${prefix}_${now}_${Math.random().toString(36).slice(2)}`,
      workflowID: item.workflow.id,
      workflowName: item.workflow.name,
      status: "active",
      current: first.id,
      step: 0,
      total: item.workflow.steps.length,
      variables,
      attempts: {},
      completed: [],
      time: {
        started: now,
        updated: now,
      },
    }
    await save(session, state)
    void Audit.emit({
      sessionID: session.id,
      workspaceID: session.workspaceID,
      event: {
        type: "workflow.started",
        workflowID: state.workflowID,
        runID: state.runID,
      },
    })
    return advance(input.sessionID, item.workflow, state)
  }

  export async function resume(input: {
    sessionID: SessionID
    variables?: Record<string, unknown>
    approved?: boolean
  }) {
    const session = await bound(input.sessionID)
    const state = WorkflowState.read(session.dsl_context)
    if (!state) throw new NotFoundError({ message: `Workflow run not found for session: ${input.sessionID}` })
    const source = await loader()
    const item = await source.get(state.workflowID)
    if (!item) throw new NotFoundError({ message: `Workflow not found: ${state.workflowID}` })
    if (!state.pause) return state
    if (state.pause.type === "waiting_permission" && input.approved === undefined) {
      throw new InvalidError({ message: "Workflow permission resume requires approved" })
    }
    if (state.pause.type === "waiting_permission" && input.approved === false) {
      const next: WorkflowState.Info = {
        ...state,
        status: "error",
        error: "Workflow permission was rejected",
        pause: undefined,
        time: { ...state.time, updated: Date.now(), completed: Date.now() },
      }
      SessionStatus.set(input.sessionID, { type: "error", message: "Workflow permission was rejected" })
      await save(session, next)
      return next
    }
    const next: WorkflowState.Info = {
      ...state,
      status: "active",
      variables: {
        ...state.variables,
        ...(input.variables ?? {}),
      },
      pause: undefined,
      time: { ...state.time, updated: Date.now() },
    }
    await save(session, next)
    return advance(input.sessionID, item.workflow, next, {
      type: state.pause.type,
      step: state.pause.step,
      guard: state.pause.guard,
      approved: input.approved,
    })
  }

  export async function abort(sessionID: SessionID) {
    const session = await bound(sessionID)
    const state = WorkflowState.read(session.dsl_context)
    if (!state) throw new NotFoundError({ message: `Workflow run not found for session: ${sessionID}` })
    const next: WorkflowState.Info = {
      ...state,
      status: "aborted",
      pause: undefined,
      time: { ...state.time, updated: Date.now(), completed: Date.now() },
    }
    SessionStatus.set(sessionID, { type: "idle" })
    await save(session, next)
    return next
  }

  async function advance(
    sessionID: SessionID,
    workflow: WorkflowParser.Definition,
    state: WorkflowState.Info,
    resumed?: { type: WorkflowState.Pause["type"]; step: string; guard?: WorkflowState.Guard; approved?: boolean },
  ): Promise<WorkflowState.Info> {
    const steps = new Map(workflow.steps.map((step) => [step.id, step]))
    let current = state

    while (current.status === "active") {
      const step = steps.get(current.current)
      if (!step) return error(sessionID, current, `Workflow step not found: ${current.current}`)

      const session = await bound(sessionID)
      const gate = guard(step.guards, current, session.permission, resumed)
      if (gate.status !== "allow") {
        if (gate.status === "error" && gate.policy !== false) {
          current = await fail(sessionID, workflow, step, current, gate.reason)
          continue
        }
        if (gate.status === "miss") return error(sessionID, current, gate.reason)
        return pause(sessionID, current, gate)
      }

      if (step.wait && !(resumed?.type === `waiting_${step.wait}` && resumed.step === step.id)) {
        return pause(sessionID, current, {
          status: `waiting_${step.wait}` as "waiting_user" | "waiting_permission",
          step: step.id,
          reason: step.wait === "user" ? "Workflow is waiting for user input" : "Workflow is waiting for permission",
        })
      }

      const attempted = await attempt(sessionID, step, current).then(
        (state) => ({ state }),
        (err: unknown) => ({ err }),
      )
      if ("err" in attempted) {
        current = await fail(sessionID, workflow, step, current, message(attempted.err))
        continue
      }
      current = attempted.state
      const next = transition(workflow, step, current, (await bound(sessionID)).permission, resumed)
      if (next.status === "complete") return finish(sessionID, workflow, current)
      if (next.status !== "next") return pause(sessionID, current, next)
      current = {
        ...current,
        current: next.step.id,
        step: next.step.index,
        time: { ...current.time, updated: Date.now() },
      }
      await save(await bound(sessionID), current)
    }

    return current
  }

  function guard(
    guards: WorkflowParser.Step["guards"],
    state: WorkflowState.Info,
    permission: Session.Info["permission"],
    resumed?: { type: WorkflowState.Pause["type"]; step: string; guard?: WorkflowState.Guard; approved?: boolean },
  ): Gate {
    for (const [index, item] of guards.entries()) {
      if (item.type === "variable") {
        const exists = state.variables[item.name] !== undefined
        if (item.exists !== undefined && exists !== item.exists) {
          return { status: "error", step: state.current, reason: `Workflow guard failed: ${item.name}` }
        }
        if (item.equals !== undefined && state.variables[item.name] !== item.equals) {
          return { status: "error", step: state.current, reason: `Workflow guard failed: ${item.name}` }
        }
        continue
      }

      const ref: WorkflowState.Guard = {
        type: "step",
        step: state.current,
        index,
        permission: item.permission,
        pattern: item.pattern,
      }
      if (approved(resumed, ref)) {
        continue
      }

      const rule = PermissionNext.evaluate(item.permission, item.pattern, permission ?? [])
      if (rule.action === "allow") continue
      if (rule.action === "deny") {
        return {
          status: "error",
          step: state.current,
          reason: `Workflow permission denied: ${item.permission} ${item.pattern}`,
          policy: false,
        }
      }
      return {
        status: "waiting_permission",
        step: state.current,
        reason: `Workflow permission required: ${item.permission} ${item.pattern}`,
        guard: ref,
      }
    }
    return { status: "allow" }
  }

  async function attempt(
    sessionID: SessionID,
    step: WorkflowParser.Step,
    state: WorkflowState.Info,
  ) {
    const attempts = {
      ...state.attempts,
      [step.id]: (state.attempts[step.id] ?? 0) + 1,
    }
    const base = {
      ...state,
      attempts,
      time: { ...state.time, updated: Date.now() },
    }
    if (step.mutates) await checkpoint(sessionID, base)
    const variables = {
      ...base.variables,
      ...Object.fromEntries(Object.entries(step.outputs).map((entry) => [entry[0], value(entry[1], base.variables)])),
    }
    const next = {
      ...base,
      variables,
      completed: [...new Set([...base.completed, step.id])],
    }
    await save(await bound(sessionID), next)
    return next
  }

  function transition(
    workflow: WorkflowParser.Definition,
    step: WorkflowParser.Step,
    state: WorkflowState.Info,
    permission: Session.Info["permission"],
    resumed?: { type: WorkflowState.Pause["type"]; step: string; guard?: WorkflowState.Guard; approved?: boolean },
  ): Move {
    const steps = new Map(workflow.steps.map((item) => [item.id, item]))
    if (step.branches.length === 0) {
      const next = workflow.steps[step.index + 1]
      if (!next) return { status: "complete" as const }
      if (state.completed.includes(next.id)) return { status: "complete" as const }
      return { status: "next" as const, step: next }
    }
    for (const [index, branch] of step.branches.entries()) {
      const gate = match(branch.guards, state, permission, index, resumed)
      if (gate.status === "allow") {
        const next = steps.get(branch.step)!
        if (state.completed.includes(next.id)) return { status: "complete" as const }
        return { status: "next" as const, step: next }
      }
      if (gate.status !== "miss") return gate
    }
    return { status: "complete" as const }
  }

  function match(
    guards: WorkflowParser.Step["guards"],
    state: WorkflowState.Info,
    permission: Session.Info["permission"],
    branch: number,
    resumed?: { type: WorkflowState.Pause["type"]; step: string; guard?: WorkflowState.Guard; approved?: boolean },
  ): Gate {
    for (const [index, item] of guards.entries()) {
      if (item.type === "variable") {
        const exists = state.variables[item.name] !== undefined
        if (item.exists !== undefined && exists !== item.exists) {
          return { status: "miss", reason: `Workflow branch did not match: ${item.name}` }
        }
        if (item.equals !== undefined && state.variables[item.name] !== item.equals) {
          return { status: "miss", reason: `Workflow branch did not match: ${item.name}` }
        }
        continue
      }

      const ref: WorkflowState.Guard = {
        type: "branch",
        step: state.current,
        branch,
        index,
        permission: item.permission,
        pattern: item.pattern,
      }
      if (approved(resumed, ref)) {
        continue
      }

      const rule = PermissionNext.evaluate(item.permission, item.pattern, permission ?? [])
      if (rule.action === "allow") continue
      if (rule.action === "deny") {
        return {
          status: "error",
          step: state.current,
          reason: `Workflow permission denied: ${item.permission} ${item.pattern}`,
          policy: false,
        }
      }
      return {
        status: "waiting_permission",
        step: state.current,
        reason: `Workflow permission required: ${item.permission} ${item.pattern}`,
        guard: ref,
      }
    }
    return { status: "allow" }
  }

  function approved(
    resumed: { type: WorkflowState.Pause["type"]; step: string; guard?: WorkflowState.Guard; approved?: boolean } | undefined,
    guard: WorkflowState.Guard,
  ) {
    if (resumed?.type !== "waiting_permission" || resumed.approved !== true) return false
    if (!resumed.guard) return false
    if (resumed.guard.type !== guard.type) return false
    if (resumed.guard.step !== guard.step) return false
    if (resumed.guard.index !== guard.index) return false
    if (resumed.guard.permission !== guard.permission) return false
    if (resumed.guard.pattern !== guard.pattern) return false
    if (guard.type === "branch") {
      if (resumed.guard.type !== "branch") return false
      return resumed.guard.branch === guard.branch
    }
    return true
  }

  async function fail(
    sessionID: SessionID,
    workflow: WorkflowParser.Definition,
    step: WorkflowParser.Step,
    state: WorkflowState.Info,
    reason: string,
  ) {
    const next = await save(
      await bound(sessionID),
      {
        ...state,
        attempts: {
          ...state.attempts,
          [step.id]: (state.attempts[step.id] ?? 0) + 1,
        },
        time: { ...state.time, updated: Date.now() },
      },
    ).then((session) => WorkflowState.read(session.dsl_context)!)
    const policy = step.error_policy ?? workflow.error_policy
    if (policy.strategy === "retry" && (next.attempts[step.id] ?? 0) < policy.max_attempts) return next
    if (policy.strategy === "continue") {
      const item = workflow.steps[step.index + 1]
      if (!item) return finish(sessionID, workflow, next)
      const state: WorkflowState.Info = {
        ...next,
        current: item.id,
        step: item.index,
        time: { ...next.time, updated: Date.now() },
      }
      await save(await bound(sessionID), state)
      return state
    }
    return error(sessionID, next, reason)
  }

  async function finish(
    sessionID: SessionID,
    workflow: WorkflowParser.Definition,
    state: WorkflowState.Info,
  ): Promise<WorkflowState.Info> {
    const step = pending(workflow, state)
    if (!step) return complete(sessionID, state)
    const next: WorkflowState.Info = {
      ...state,
      current: step.id,
      step: step.index,
      time: { ...state.time, updated: Date.now() },
    }
    await save(await bound(sessionID), next)
    return advance(sessionID, workflow, next)
  }

  function pending(workflow: WorkflowParser.Definition, state: WorkflowState.Info) {
    const done = new Set(state.completed)
    const steps = new Map(workflow.steps.map((step) => [step.id, step]))
    for (const step of workflow.steps) {
      if (!done.has(step.id)) continue
      for (const id of step.verification?.must_pass ?? []) {
        if (done.has(id)) continue
        return steps.get(id)
      }
    }
  }

  function value(input: unknown, variables: Record<string, unknown>) {
    if (typeof input !== "string") return input
    if (!input.startsWith("$")) return input
    return variables[input.slice(1)]
  }

  function variablesFor(workflow: WorkflowParser.Definition, input?: Record<string, unknown>) {
    const variables = {
      ...Object.fromEntries(
        Object.entries(workflow.inputs)
          .filter((entry) => entry[1].default !== undefined)
          .map((entry) => [entry[0], entry[1].default]),
      ),
      ...(input ?? {}),
    }
    for (const entry of Object.entries(workflow.inputs)) {
      const value = variables[entry[0]]
      if (entry[1].required && value === undefined) {
        throw new InvalidError({ message: `Workflow input is required: ${entry[0]}` })
      }
      if (value !== undefined && !valid(entry[1].type, value)) {
        throw new InvalidError({ message: `Workflow input has invalid type: ${entry[0]}` })
      }
    }
    return variables
  }

  function valid(type: WorkflowParser.Definition["inputs"][string]["type"], value: unknown) {
    if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value)
    return typeof value === type
  }

  function visible(session: Session.Info) {
    return session.directory === Instance.directory
  }

  async function bound(sessionID: SessionID) {
    const session = await Session.get(sessionID)
    if (session.directory !== Instance.directory) {
      throw new ForbiddenError({ message: `Session ${sessionID} does not belong to the current directory` })
    }
    if (visible(session)) return session
    throw new ForbiddenError({ message: `Session ${sessionID} does not belong to the current directory` })
  }

  function message(err: unknown) {
    if (err instanceof Error) return err.message
    return String(err)
  }

  async function checkpoint(sessionID: SessionID, state: WorkflowState.Info) {
    const session = await save(await bound(sessionID), state)
    const hash = await Snapshot.track()
    if (!hash) return
    const msg = MessageID.ascending()
    await Session.updateMessage({
      id: msg,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "workflow",
      model: { providerID: "workflow", modelID: "workflow" },
      tools: {},
    } as MessageV2.Info)
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: msg,
      sessionID,
      type: "step-start",
      snapshot: hash,
      permission: session.permission,
      dsl_context: session.dsl_context,
    })
    state.checkpoint = hash
  }

  async function pause(
    sessionID: SessionID,
    state: WorkflowState.Info,
    gate: {
      status: "waiting_user" | "waiting_permission" | "error"
      step: string
      reason: string
      guard?: WorkflowState.Guard
    },
  ) {
    if (gate.status === "error") return error(sessionID, state, gate.reason)
    const next: WorkflowState.Info = {
      ...state,
      status: gate.status,
      pause: {
        type: gate.status,
        step: gate.step,
        reason: gate.reason,
        guard: gate.guard,
      },
      time: { ...state.time, updated: Date.now() },
    }
    SessionStatus.set(sessionID, { type: gate.status })
    await save(await bound(sessionID), next)
    void Audit.emit({
      sessionID,
      workspaceID: (await bound(sessionID)).workspaceID,
      event: {
        type: "workflow.paused",
        workflowID: next.workflowID,
        runID: next.runID,
        status: gate.status,
        step: gate.step,
      },
    })
    return next
  }

  async function complete(sessionID: SessionID, state: WorkflowState.Info) {
    const next: WorkflowState.Info = {
      ...state,
      status: "completed",
      pause: undefined,
      time: { ...state.time, updated: Date.now(), completed: Date.now() },
    }
    SessionStatus.set(sessionID, { type: "idle" })
    await save(await bound(sessionID), next)
    void Audit.emit({
      sessionID,
      workspaceID: (await bound(sessionID)).workspaceID,
      event: {
        type: "workflow.completed",
        workflowID: next.workflowID,
        runID: next.runID,
      },
    })
    return next
  }

  async function error(sessionID: SessionID, state: WorkflowState.Info, message: string) {
    const next: WorkflowState.Info = {
      ...state,
      status: "error",
      error: message,
      pause: undefined,
      time: { ...state.time, updated: Date.now(), completed: Date.now() },
    }
    SessionStatus.set(sessionID, { type: "error", message })
    await save(await bound(sessionID), next)
    void Audit.emit({
      sessionID,
      workspaceID: (await bound(sessionID)).workspaceID,
      event: {
        type: "workflow.failed",
        workflowID: next.workflowID,
        runID: next.runID,
        step: next.current,
      },
    })
    return next
  }

  async function save(session: Session.Info, state: WorkflowState.Info) {
    return Session.setDslContext({
      sessionID: session.id,
      dsl_context: WorkflowState.write(session.dsl_context, state),
    })
  }
}
