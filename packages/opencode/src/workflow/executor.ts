import { PermissionNext } from "@/permission/next"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Snapshot } from "@/snapshot"
import { Agent } from "@/agent/agent"
import { AgentEntry } from "@/agent/entry"
import { ForbiddenError, NotFoundError } from "@/storage/db"
import { Filesystem } from "@/util/filesystem"
import { defer } from "@/util/defer"
import { NamedError } from "@opencode-ai/util/error"
import path from "path"
import z from "zod"
import { WorkflowParser } from "./parser"
import { loader } from "./loader"
import { WorkflowState } from "./state"
import { Audit } from "@/observability/audit"
import { Log } from "@/util/log"

export namespace WorkflowExecutor {
  const log = Log.create({ service: "workflow.executor" })
  const prefix = "workflow"
  const active = new Set<string>()
  export const InvalidError = NamedError.create("WorkflowInvalidError", z.object({ message: z.string() }))
  type Run = {
    sessionID: SessionID
    workflowID: string
    variables?: Record<string, unknown>
    agent?: string
    abort?: AbortSignal
    execute?: Executor
  }
  type Executor = (input: {
    parent: Session.Info
    workflow: WorkflowParser.Definition
    step: WorkflowParser.Step
    state: WorkflowState.Info
    agent: string
    attempt: number
    abort?: AbortSignal
  }) => Promise<{
    agent: string
    sessionID?: SessionID
    output: string
  }>

  type Gate =
    | { status: "allow" }
    | { status: "miss"; reason: string }
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

  export async function run(input: Run) {
    const { workflow, state } = await init(input)
    return advance(input.sessionID, workflow, state, undefined, input)
  }

  export async function continueRun(input: Omit<Run, "workflowID">) {
    const session = await bound(input.sessionID)
    const state = WorkflowState.read(session.dsl_context)
    if (!state) throw new NotFoundError({ message: `Workflow run not found for session: ${input.sessionID}` })
    const source = await loader()
    const item = await source.get(state.workflowID)
    if (!item) throw new NotFoundError({ message: `Workflow not found: ${state.workflowID}` })
    if (state.status !== "active") return state
    if (active.has(state.runID)) return state
    const next = {
      ...state,
      variables: {
        ...state.variables,
        ...(input.variables ?? {}),
      },
      statuses: Object.fromEntries(
        Object.entries(state.statuses).map(([id, status]) => [id, status === "running" ? "pending" : status]),
      ),
      nodes: Object.fromEntries(Object.entries(state.nodes).filter((entry) => entry[1].status !== "running")),
      time: { ...state.time, updated: Date.now() },
    } satisfies WorkflowState.Info
    await save(session, next)
    return advance(input.sessionID, item.workflow, next, undefined, input)
  }

  export async function begin(input: Run) {
    const { workflow, state } = await init(input)
    schedule(input.sessionID, workflow, state, {
      agent: input.agent,
      execute: input.execute,
    })
    return state
  }

  async function init(input: Run) {
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
      steps: item.workflow.steps.map((step) => ({
        id: step.id,
        type: step.type,
        agent: step.agent,
        prompt: step.prompt,
        mutates: step.mutates,
        wait: step.wait,
        inputs: step.inputs,
        outputs: step.outputs,
        guards: step.guards,
        depends_on: step.depends_on,
        next: step.next,
        verification: step.verification,
      })),
      nodes: {},
      statuses: Object.fromEntries(item.workflow.nodes.map((node) => [node.id, "pending" as const])),
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
    return { session, workflow: item.workflow, state }
  }

  function schedule(
    sessionID: SessionID,
    workflow: WorkflowParser.Definition,
    state: WorkflowState.Info,
    opts?: Pick<Run, "agent" | "execute">,
  ) {
    if (active.has(state.runID)) return
    active.add(state.runID)
    void Promise.resolve()
      .then(async () => {
        const done = await advance(sessionID, workflow, state, undefined, opts)
        void notify(sessionID, done, opts?.agent)
      })
      .catch(async (err: unknown) => {
        log.error("background workflow failed", { runID: state.runID, err })
        const done = await error(sessionID, await latest(sessionID, state), message(err))
        void notify(sessionID, done, opts?.agent)
      })
      .finally(() => {
        active.delete(state.runID)
      })
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
    opts?: Pick<Run, "agent" | "abort" | "execute">,
  ): Promise<WorkflowState.Info> {
    let current = state

    while (current.status === "active") {
      current = await block(sessionID, workflow, await latest(sessionID, current))
      if (current.status !== "active") return current

      const batch = ready(workflow, current)
      if (batch.length === 0) return settle(sessionID, workflow, current)

      const gated: WorkflowParser.Step[] = []
      let changed = false
      for (const step of batch) {
        const session = await bound(sessionID)
        const ctx = { ...current, current: step.id, step: step.index }
        const edge = matchin(workflow, step, ctx, session.permission, resumed)
        if (edge.status === "miss") {
          const prev = current
          current = await mark(sessionID, current, step, "skipped")
          if (workflow.legacy) {
            current = {
              ...current,
              current: prev.current,
              step: prev.step,
            }
            await save(await bound(sessionID), current)
          }
          changed = true
          continue
        }
        if (edge.status === "error" && edge.policy !== false) {
          current = await fail(sessionID, workflow, step, ctx, edge.reason)
          changed = true
          continue
        }
        if (edge.status === "error") return error(sessionID, ctx, edge.reason)
        if (edge.status !== "allow") return pause(sessionID, ctx, edge)

        const gate = guard(step.guards, ctx, session.permission, resumed)
        if (gate.status === "error" && gate.policy !== false) {
          current = await fail(sessionID, workflow, step, ctx, gate.reason)
          changed = true
          continue
        }
        if (gate.status === "miss" || gate.status === "error") return error(sessionID, ctx, gate.reason)
        if (gate.status !== "allow") return pause(sessionID, ctx, gate)

        if (step.wait && !(resumed?.type === `waiting_${step.wait}` && resumed.step === step.id)) {
          return pause(sessionID, ctx, {
            status: `waiting_${step.wait}` as "waiting_user" | "waiting_permission",
            step: step.id,
            reason: step.wait === "user" ? "Workflow is waiting for user input" : "Workflow is waiting for permission",
          })
        }

        gated.push(step)
      }
      resumed = undefined
      if (changed) continue

      const base = current
      const running = await Promise.all(
        gated.map((step) =>
          attempt(sessionID, workflow, step, base, opts).then(
            (state) => ({ step, state }),
            (err: unknown) => ({ step, err }),
          ),
        ),
      )
      for (const item of running) {
        if ("err" in item) {
          current = await fail(sessionID, workflow, item.step, base, message(item.err))
          continue
        }
        const last = await latest(sessionID, item.state)
        const keys = [item.step.id, ...Object.keys(item.step.outputs)]
        current = {
          ...last,
          current: item.step.id,
          step: item.step.index,
          variables: {
            ...last.variables,
            ...Object.fromEntries(
              keys.filter((key) => item.state.variables[key] !== undefined).map((key) => [key, item.state.variables[key]]),
            ),
          },
          nodes: {
            ...last.nodes,
            ...Object.fromEntries(Object.entries(item.state.nodes).filter((entry) => entry[0] === item.step.id)),
          },
          statuses: {
            ...last.statuses,
            [item.step.id]: "completed" as const,
          },
          completed: [...new Set([...last.completed, item.step.id])],
        }
        await save(await bound(sessionID), current)
      }
    }

    return current
  }

  async function latest(sessionID: SessionID, state: WorkflowState.Info) {
    return WorkflowState.read((await bound(sessionID)).dsl_context) ?? state
  }

  async function block(sessionID: SessionID, workflow: WorkflowParser.Definition, state: WorkflowState.Info) {
    let current = state
    for (const step of workflow.nodes) {
      if ((current.statuses[step.id] ?? "pending") !== "pending") continue
      if (orphan(workflow, step)) {
        current = await mark(sessionID, current, step, "skipped")
        continue
      }
      if (!step.depends_on.some((dep) => failed(workflow, current, dep))) continue
      current = await mark(sessionID, current, step, workflow.legacy ? "cancelled" : "skipped")
    }
    return current
  }

  function ready(workflow: WorkflowParser.Definition, state: WorkflowState.Info) {
    return workflow.nodes.filter((step) => {
      if ((state.statuses[step.id] ?? "pending") !== "pending") return false
      if (orphan(workflow, step)) return false
      return step.depends_on.every((dep) => satisfied(workflow, state, step, dep))
    })
  }

  function orphan(workflow: WorkflowParser.Definition, step: WorkflowParser.Step) {
    if (!workflow.legacy) return false
    if (step.index === 0) return false
    if (step.depends_on.length > 0) return false
    return !target(workflow, step)
  }

  function target(workflow: WorkflowParser.Definition, step: WorkflowParser.Step) {
    return workflow.nodes.some((node) => node.verification?.must_pass.includes(step.id))
  }

  function verifier(workflow: WorkflowParser.Definition, state: WorkflowState.Info, step: WorkflowParser.Step) {
    return workflow.nodes.some(
      (node) => state.statuses[node.id] === "completed" && node.verification?.must_pass.includes(step.id),
    )
  }

  function satisfied(
    workflow: WorkflowParser.Definition,
    state: WorkflowState.Info,
    step: WorkflowParser.Step,
    dep: string,
  ) {
    const status = state.statuses[dep]
    if (status === "completed") return true
    if (workflow.legacy && verifier(workflow, state, step) && (status === "skipped" || status === "cancelled")) return true
    return allowed(workflow, state, dep)
  }

  function allowed(workflow: WorkflowParser.Definition, state: WorkflowState.Info, id: string) {
    if (!workflow.legacy) return false
    if (state.statuses[id] !== "error") return false
    const step = workflow.nodes.find((item) => item.id === id)
    const policy = step?.error_policy ?? workflow.error_policy
    return policy.strategy === "continue"
  }

  function failed(workflow: WorkflowParser.Definition, state: WorkflowState.Info, id: string) {
    const status = state.statuses[id]
    if (workflow.legacy && (status === "skipped" || status === "cancelled")) return false
    if (status === "skipped" || status === "cancelled") return true
    if (status !== "error") return false
    return !allowed(workflow, state, id)
  }

  function done(state: WorkflowState.Info, step: WorkflowParser.Step) {
    return ["completed", "error", "skipped", "cancelled"].includes(state.statuses[step.id] ?? "pending")
  }

  async function settle(sessionID: SessionID, workflow: WorkflowParser.Definition, state: WorkflowState.Info) {
    if (!workflow.nodes.every((step) => done(state, step))) {
      return error(sessionID, state, "Workflow has no runnable nodes")
    }
    const bad = workflow.nodes.some((step) => failed(workflow, state, step.id))
    if (bad) return error(sessionID, state, "Workflow completed with failed or skipped nodes")
    return complete(sessionID, state)
  }

  function matchin(
    workflow: WorkflowParser.Definition,
    step: WorkflowParser.Step,
    state: WorkflowState.Info,
    permission: Session.Info["permission"],
    resumed?: { type: WorkflowState.Pause["type"]; step: string; guard?: WorkflowState.Guard; approved?: boolean },
  ): Gate {
    for (const source of workflow.nodes) {
      for (const [index, branch] of source.branches.entries()) {
        if (branch.step !== step.id) continue
        const gate = match(branch.guards, { ...state, current: source.id }, permission, index, resumed)
        if (gate.status === "miss") return gate
        if (gate.status !== "allow") return gate
      }
    }
    return { status: "allow" }
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
    workflow: WorkflowParser.Definition,
    step: WorkflowParser.Step,
    state: WorkflowState.Info,
    opts?: Pick<Run, "agent" | "abort" | "execute">,
  ) {
    const attempts = {
      ...state.attempts,
      [step.id]: (state.attempts[step.id] ?? 0) + 1,
    }
    const base = {
      ...state,
      current: step.id,
      step: step.index,
      attempts,
      statuses: {
        ...state.statuses,
        [step.id]: "running" as const,
      },
      time: { ...state.time, updated: Date.now() },
    }
    await save(await bound(sessionID), base)
    if (step.mutates) await checkpoint(sessionID, base)
    const ran = await execute(sessionID, workflow, step, base, opts)
    const saved = WorkflowState.read((await bound(sessionID)).dsl_context) ?? base
    const vars = {
      ...saved.variables,
      ...(ran ? { [step.id]: ran.output } : {}),
    }
    const variables = {
      ...vars,
      ...Object.fromEntries(Object.entries(step.outputs).map((entry) => [entry[0], value(entry[1], vars)])),
    }
    const next = {
      ...saved,
      current: step.id,
      step: step.index,
      variables,
      statuses: {
        ...saved.statuses,
        [step.id]: "completed" as const,
      },
      completed: [...new Set([...saved.completed, step.id])],
      time: { ...saved.time, updated: Date.now() },
    }
    await save(await bound(sessionID), next)
    return next
  }

  async function execute(
    sessionID: SessionID,
    workflow: WorkflowParser.Definition,
    step: WorkflowParser.Step,
    state: WorkflowState.Info,
    opts?: Pick<Run, "agent" | "abort" | "execute">,
  ) {
    if (!step.prompt) return
    const parent = await bound(sessionID)
    const attempt = state.attempts[step.id] ?? 1
    const agent = await route(step, opts?.agent)
    const started = Date.now()
    const node: WorkflowState.Node = {
      step: step.id,
      status: "running",
      agent,
      path: nodepath(state.runID, step.id),
      attempt,
      time: {
        started,
        updated: started,
      },
    }
    await nodefile(state.runID, step.id, node)
    const active = WorkflowState.read(parent.dsl_context) ?? state
    await save(parent, {
      ...active,
      current: step.id,
      step: step.index,
      statuses: {
        ...active.statuses,
        [step.id]: "running",
      },
      nodes: {
        ...active.nodes,
        [step.id]: node,
      },
    })
    const ran = await (opts?.execute ?? subagent)({
      parent,
      workflow,
      step,
      state,
      agent,
      attempt,
      abort: opts?.abort,
    }).catch(async (err: unknown) => {
      const failed: WorkflowState.Node = {
        ...node,
        status: "error",
        error: message(err),
        time: {
          ...node.time,
          updated: Date.now(),
          completed: Date.now(),
        },
      }
      await nodefile(state.runID, step.id, failed)
      const current = await latest(sessionID, state)
      await save(await bound(sessionID), {
        ...current,
        current: step.id,
        step: step.index,
        statuses: {
          ...current.statuses,
          [step.id]: "error",
        },
        nodes: {
          ...current.nodes,
          [step.id]: failed,
        },
      })
      throw err
    })
    const done: WorkflowState.Node = {
      ...node,
      status: "completed",
      agent: ran.agent,
      sessionID: ran.sessionID,
      output: ran.output,
      time: {
        ...node.time,
        updated: Date.now(),
        completed: Date.now(),
      },
    }
    await nodefile(state.runID, step.id, done)
    const current = await latest(sessionID, state)
    await save(await bound(sessionID), {
      ...current,
      current: step.id,
      step: step.index,
      statuses: {
        ...current.statuses,
        [step.id]: "completed",
      },
      nodes: {
        ...current.nodes,
        [step.id]: done,
      },
    })
    return ran
  }

  async function subagent(input: Parameters<Executor>[0]) {
    const agent = await Agent.get(input.agent)
    if (!agent) throw new InvalidError({ message: `Workflow node agent not found: ${input.agent}` })
    const rule = PermissionNext.evaluate("task", agent.name, input.parent.permission ?? [])
    if (rule.action === "deny") {
      throw new InvalidError({ message: `Workflow node agent denied: ${agent.name}` })
    }
    const child = await Session.create({
      parentID: input.parent.id,
      title: `${input.workflow.name}: ${input.step.id} (@${agent.name})`,
      permission: [
        ...agent.permission,
        { permission: "workflow_create", pattern: "*", action: "deny" },
        { permission: "workflow_start", pattern: "*", action: "deny" },
      ],
    })
    function cancel() {
      SessionPrompt.cancel(child.id)
    }
    input.abort?.addEventListener("abort", cancel)
    using _ = defer(() => input.abort?.removeEventListener("abort", cancel))
    const prompt = [
      `Execute workflow node "${input.step.id}" for workflow "${input.workflow.name}".`,
      "",
      "Return only the node result. Include what you did, important findings, changed files, test results, blockers, and whether the node goal is complete.",
      "",
      "<workflow>",
      JSON.stringify({
        id: input.workflow.id,
        name: input.workflow.name,
        description: input.workflow.description,
        run_id: input.state.runID,
      }),
      "</workflow>",
      "",
      "<node>",
      JSON.stringify({
        id: input.step.id,
        type: input.step.type,
        mutates: input.step.mutates,
        inputs: input.step.inputs,
        verification: input.step.verification,
        attempt: input.attempt,
      }),
      "</node>",
      "",
      "<variables>",
      JSON.stringify(input.state.variables),
      "</variables>",
      "",
      "<task>",
      input.step.prompt,
      "</task>",
    ].join("\n")
    const result = await SessionPrompt.prompt({
      sessionID: child.id,
      agent: agent.name,
      parts: await SessionPrompt.resolvePromptParts(prompt),
    })
    input.abort?.throwIfAborted()
    return {
      agent: agent.name,
      sessionID: child.id,
      output: result.parts.findLast((part) => part.type === "text")?.text ?? "",
    }
  }

  async function route(step: WorkflowParser.Step, current?: string) {
    if (step.agent !== "primary" && step.agent !== "auto") {
      const agent = await Agent.get(step.agent)
      if (agent) return agent.name
    }
    if (step.agent === "primary" && current && (await Agent.get(current))) return current
    const agents = await Agent.list().then((items) => items.filter((item) => AgentEntry.delegable(item)))
    const match = agents.find((item) => item.name.includes(step.type) || item.description?.toLowerCase().includes(step.type))
    if (match) return match.name
    if (current && (await Agent.get(current))) return current
    const agent = await Agent.defaultAgent()
    if (agent) return agent
    throw new InvalidError({ message: `Workflow node agent could not be resolved for step: ${step.id}` })
  }

  async function nodefile(runID: string, step: string, node: WorkflowState.Node) {
    await Filesystem.writeJson(nodepath(runID, step), node)
  }

  function nodepath(runID: string, step: string) {
    return path.join(Instance.directory, ".opencode", "workflows", "runs", runID, `${step}.json`)
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
    const last = await latest(sessionID, state)
    const prior = state.attempts[step.id] ?? 0
    const count = last.attempts[step.id] ?? prior
    const next = await save(
      await bound(sessionID),
      {
        ...last,
        current: step.id,
        step: step.index,
        attempts: {
          ...last.attempts,
          [step.id]: count === prior ? count + 1 : count,
        },
        statuses: {
          ...last.statuses,
          [step.id]: "error" as const,
        },
        time: { ...last.time, updated: Date.now() },
      },
    ).then((session) => WorkflowState.read(session.dsl_context)!)
    const policy = step.error_policy ?? workflow.error_policy
    if (policy.strategy === "retry" && (next.attempts[step.id] ?? 0) < policy.max_attempts) {
      return mark(sessionID, next, step, "pending")
    }
    if (policy.strategy === "continue") {
      return next
    }
    return error(sessionID, next, reason)
  }

  async function mark(sessionID: SessionID, state: WorkflowState.Info, step: WorkflowParser.Step, status: WorkflowState.Status) {
    const current = await latest(sessionID, state)
    const next: WorkflowState.Info = {
      ...current,
      current: step.id,
      step: step.index,
      statuses: {
        ...current.statuses,
        [step.id]: status,
      },
      time: { ...current.time, updated: Date.now() },
    }
    await save(await bound(sessionID), next)
    return next
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

  async function notify(sessionID: SessionID, state: WorkflowState.Info, agent: string | undefined) {
    const statuses = Object.values(state.statuses)
    const body = {
      type:
        state.status === "completed"
          ? "workflow.completed"
          : state.status === "error"
            ? "workflow.failed"
            : state.status === "waiting_user" || state.status === "waiting_permission"
              ? "workflow.paused"
              : "workflow.result",
      run_id: state.runID,
      workflow_id: state.workflowID,
      workflow_name: state.workflowName,
      status: state.status,
      summary: {
        total: state.total,
        completed: statuses.filter((status) => status === "completed").length,
        failed: statuses.filter((status) => status === "error").length,
        skipped: statuses.filter((status) => status === "skipped" || status === "cancelled").length,
        pending: statuses.filter((status) => status === "pending").length,
      },
      completed: state.completed,
      nodes: state.nodes,
      statuses: state.statuses,
      variables: state.variables,
      pause: state.pause,
      error: state.error,
    }
    await SessionPrompt.prompt({
      sessionID,
      agent,
      parts: [
        {
          type: "text",
          synthetic: true,
          text: [
            "<workflow-result>",
            JSON.stringify(body, null, 2),
            "</workflow-result>",
            "",
            "The workflow runtime has finished or paused this background run.",
            "Use this result as authoritative. If it completed, summarize the node outputs for the user and do not rerun completed nodes. If it failed or paused, decide whether to revise, resume, or ask the user.",
          ].join("\n"),
        },
      ],
    }).catch((err: unknown) => {
      log.error("workflow continuation prompt failed", { runID: state.runID, err })
    })
  }

  async function save(session: Session.Info, state: WorkflowState.Info) {
    return Session.setDslContext({
      sessionID: session.id,
      dsl_context: WorkflowState.write(session.dsl_context, state),
    })
  }
}
