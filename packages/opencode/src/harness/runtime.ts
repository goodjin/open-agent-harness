import z from "zod"
import { Harness } from "./schema"
import { HarnessStore } from "./store"

export namespace HarnessRuntime {
  function id(prefix: string) {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`
  }

  function now() {
    return Date.now()
  }

  function strings(input: unknown) {
    if (!Array.isArray(input)) return []
    return input.filter((item): item is string => typeof item === "string")
  }

  function scope(input: unknown) {
    if (input === "run" || input === "project" || input === "team" || input === "global") return input
    return "project"
  }

  function event(type: string, input: { run?: string; actor?: string; summary?: string; payload?: Record<string, unknown> }) {
    return Harness.Event.parse({
      id: id("event"),
      run_id: input.run,
      type,
      actor: input.actor ?? "runtime",
      time: now(),
      summary: input.summary,
      payload: input.payload ?? {},
    })
  }

  async function record(run: Harness.Run) {
    const time = now()
    const item =
      (await HarnessStore.actionGraph(run.id)) ??
      Harness.ActionGraph.parse({
        id: id("graph"),
        run_id: run.id,
        status: "active",
        created_at: time,
        updated_at: time,
      })
    const next = Harness.ActionGraph.parse({ ...item, updated_at: time })
    await HarnessStore.putActionGraph(next)
    return next
  }

  async function project(run: string) {
    const graph = await HarnessStore.actionGraph(run)
    if (!graph) throw new Error(`Action Graph not found: ${run}`)
    const actions = await HarnessStore.actions(run)
    const edges = await HarnessStore.edges(run)
    const events = await HarnessStore.events(run)
    const done = new Set(actions.filter((item) => item.status === "completed").map((item) => item.id))
    const blocked = actions
      .filter((item) => item.status === "blocked" || item.depends_on.some((dep) => !done.has(dep)))
      .map((item) => ({
        id: item.id,
        reason: item.status === "blocked" ? "status blocked" : "waiting for dependencies",
      }))
    const out = Harness.ActionGraphProjection.parse({
      graph,
      nodes: actions,
      edges,
      blocked,
      ready: actions.filter((item) => item.status === "ready" && !blocked.some((next) => next.id === item.id)).map((item) => item.id),
      source_events: events.length,
    })
    await HarnessStore.projection(run, "action-graph", out)
    return out
  }

  function brief(input: Harness.DocumentWrite) {
    return input.summary ?? `${input.title}: ${input.body.slice(0, 120)}${input.body.length > 120 ? "..." : ""}`
  }

  async function resources(run: string) {
    const list = await HarnessStore.resources(run)
    await HarnessStore.projection(run, "resource-index", list)
    return list
  }

  function cost(input: "low" | "medium" | "high") {
    return { low: 1, medium: 2, high: 3 }[input]
  }

  async function agents(run?: string) {
    const list = await HarnessStore.agentTemplates()
    if (run) await HarnessStore.projection(run, "agent-templates", list)
    return list
  }

  async function refresh(run: Harness.Run) {
    const tasks = await HarnessStore.tasks(run.id)
    const decisions = await HarnessStore.decisions(run.id)
    const assignments = await HarnessStore.assignments(run.id)
    const completed = tasks.filter((item) => ["approved", "merged"].includes(item.status)).length
    const active = assignments.filter((item) => item.status === "running").length
    const pending = decisions.filter((item) => item.status === "pending").length
    const next = Harness.Run.parse({
      ...run,
      progress: { completed, total: tasks.length },
      active_assignments: active,
      pending_decisions: pending,
      updated_at: now(),
    })
    await HarnessStore.putRun(next)
    await HarnessStore.projection(next.id, "run-state", next)
    await HarnessStore.projection(next.id, "task-state", tasks)
    return next
  }

  export async function create(input: Harness.CreateRun) {
    const time = now()
    const run = Harness.Run.parse({
      id: id("run"),
      name: input.name ?? input.goal.slice(0, 80),
      status: "ready",
      goal: input.goal,
      mode: input.mode ?? "development",
      constraints: input.constraints,
      memory_scopes: input.memory_scopes,
      automation: input.automation,
      created_at: time,
      updated_at: time,
    })
    await HarnessStore.putRun(run)
    const task = Harness.Task.parse({
      id: id("task"),
      run_id: run.id,
      title: "规划 Run",
      type: "planning",
      status: "ready",
      goal: `为目标创建可执行任务结构：${input.goal}`,
      acceptance: ["Run 结构清晰", "任务具备验收标准"],
      gates: [
        {
          id: "schema_valid",
          status: "passed",
          evidence: ["run.create accepted"],
        },
      ],
      created_at: time,
      updated_at: time,
    })
    await HarnessStore.putTask(task)
    await HarnessStore.append(event("run.created", { run: run.id, actor: "user", summary: run.goal, payload: input }))
    await HarnessStore.append(event("task.created", { run: run.id, summary: task.title, payload: { task_id: task.id } }))
    return refresh(run)
  }

  export async function putAgentTemplate(input: z.input<typeof Harness.AgentTemplateRecord>) {
    const time = now()
    const item = Harness.AgentTemplateRecord.parse({
      ...input,
      created_at: input.created_at || time,
      updated_at: time,
    })
    await HarnessStore.putAgentTemplate(item)
    return item
  }

  export async function agentTemplates() {
    return agents()
  }

  export async function routeAgents(input: Harness.AgentRoute) {
    const route = Harness.AgentRoute.parse(input)
    const list = await agents()
    const excluded: { id: string; reason: string }[] = []
    const candidates = list.filter((item) => {
      if (!item.entry[route.entry]) {
        excluded.push({ id: item.id, reason: "entry unavailable" })
        return false
      }
      if (item.availability !== "available") {
        excluded.push({ id: item.id, reason: "unavailable" })
        return false
      }
      if (route.capability.length && !route.capability.every((tag) => item.capability.tags.includes(tag))) {
        excluded.push({ id: item.id, reason: "capability mismatch" })
        return false
      }
      if (route.permission.write !== undefined && item.permission.write !== route.permission.write) {
        excluded.push({ id: item.id, reason: "permission mismatch" })
        return false
      }
      if (route.permission.scopes.length && !route.permission.scopes.every((scope) => item.permission.scopes.includes(scope))) {
        excluded.push({ id: item.id, reason: "scope mismatch" })
        return false
      }
      if (cost(item.capability.cost) > cost(route.budget.max_cost)) {
        excluded.push({ id: item.id, reason: "budget exceeded" })
        return false
      }
      return true
    })
    return { candidates, excluded, projection: route.projection }
  }

  export async function assignAgent(run: string, input: Harness.AgentAssignmentInput) {
    const payload = Harness.AgentAssignmentInput.parse(input)
    const template = await HarnessStore.agentTemplate(payload.template_id)
    if (!template) throw new Error(`Agent template not found: ${payload.template_id}`)
    const action = await HarnessStore.action(run, payload.action_id)
    if (!action) throw new Error(`Action not found: ${payload.action_id}`)
    if (action.type !== "agent") throw new Error(`Action is not agent type: ${payload.action_id}`)
    const time = now()
    const assignment = Harness.Assignment.parse({
      id: id("assign"),
      task_id: action.id,
      actor: template.id,
      role: payload.role,
      status: "pending",
      capabilities: template.capability.tags,
      authority: payload.authority,
      context: payload.context_summary,
      updated_at: time,
    })
    const session = Harness.AgentSessionRecord.parse({
      id: id("agent-session"),
      run_id: run,
      template_id: template.id,
      assignment_id: assignment.id,
      action_id: action.id,
      authority: payload.authority,
      context_summary: payload.context_summary,
      trace_refs: payload.trace_refs,
      status: "pending",
      created_at: time,
      updated_at: time,
    })
    await HarnessStore.putAssignment(run, assignment)
    await HarnessStore.putAgentSession(session)
    await HarnessStore.append(event("agent.assigned", { run, actor: template.id, summary: action.title, payload: { assignment_id: assignment.id, session_id: session.id, action_id: action.id } }))
    await HarnessStore.projection(run, "agent-sessions", await HarnessStore.agentSessions(run))
    return { assignment, session, template }
  }

  export async function writeDocument(run: string, input: Harness.DocumentWrite) {
    const payload = Harness.DocumentWrite.parse(input)
    const time = now()
    const rid = id("res")
    const res = Harness.ResourceRecord.parse({
      id: rid,
      run_id: run,
      kind: payload.kind,
      uri: `resource://${rid}`,
      summary: brief(payload),
      producer: payload.producer,
      source_action: payload.source_action,
      visibility: payload.visibility,
      evidence: payload.evidence,
      lifecycle: "active",
      media_type: payload.media_type,
      size: payload.body.length,
      created_at: time,
      updated_at: time,
    })
    await HarnessStore.putResource(res)
    await HarnessStore.putBody(run, res.id, payload.body)
    await HarnessStore.append(event("resource.written", { run, actor: payload.producer.id, summary: res.summary, payload: { resource_id: res.id, source_action: res.source_action } }))
    await resources(run)
    return {
      resource: res,
      session: Harness.ResourceSessionPart.parse({
        type: "resource_ref",
        title: payload.title,
        summary: res.summary,
        ref: res.uri,
        next: payload.body.length > payload.threshold ? ["preview", "full_read", "redacted_export"] : ["full_read"],
      }),
    }
  }

  export async function readResource(run: string, id: string) {
    const resource = await HarnessStore.resource(run, id)
    if (!resource) throw new Error(`Resource not found: ${id}`)
    const body = await HarnessStore.body(run, id)
    if (body === undefined) throw new Error(`Resource body not found: ${id}`)
    return Harness.ResourceRead.parse({ resource, body })
  }

  export async function previewResource(run: string, id: string) {
    const data = await readResource(run, id)
    return Harness.ResourcePreview.parse({
      resource: data.resource,
      preview: data.body.slice(0, 240),
      truncated: data.body.length > 240,
    })
  }

  export async function exportResource(run: string, id: string, format: "redacted") {
    const data = await readResource(run, id)
    if (format !== "redacted") throw new Error(`Unsupported export: ${format}`)
    return {
      resource: data.resource,
      body: data.body.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "[redacted-email]"),
    }
  }

  export async function tombstoneResource(run: string, id: string) {
    const data = await readResource(run, id)
    const next = Harness.ResourceRecord.parse({ ...data.resource, lifecycle: "tombstoned", updated_at: now() })
    await HarnessStore.putResource(next)
    await HarnessStore.append(event("resource.tombstoned", { run, payload: { resource_id: id } }))
    await resources(run)
    return next
  }

  export function command(input: Harness.Command & { type: "resource.write" }): Promise<{ run: Harness.Run; resource: Harness.ResourceRecord; session: Harness.ResourceSessionPart }>
  export function command(input: Harness.Command & { type: "resource.tombstone" }): Promise<{ run: Harness.Run; resource: Harness.ResourceRecord }>
  export function command(input: Harness.Command): Promise<Harness.Run>
  export async function command(input: Harness.Command) {
    if (input.type === "run.create") return create(Harness.CreateRun.parse(input.payload))
    if (!input.run_id) throw new Error("run_id is required")
    const run = await HarnessStore.maybeRun(input.run_id)
    if (!run) throw new Error(`Run not found: ${input.run_id}`)
    const time = now()
    if (input.type === "run.pause") {
      const next = Harness.Run.parse({ ...run, status: "paused", updated_at: time })
      await HarnessStore.putRun(next)
      await HarnessStore.append(event("run.paused", { run: run.id, actor: input.actor }))
      return refresh(next)
    }
    if (input.type === "run.resume") {
      const next = Harness.Run.parse({ ...run, status: "running", updated_at: time })
      await HarnessStore.putRun(next)
      await HarnessStore.append(event("run.resumed", { run: run.id, actor: input.actor }))
      return refresh(next)
    }
    if (input.type === "run.abort") {
      const next = Harness.Run.parse({ ...run, status: "aborted", updated_at: time })
      await HarnessStore.putRun(next)
      await HarnessStore.append(event("run.aborted", { run: run.id, actor: input.actor }))
      return refresh(next)
    }
    if (input.type === "action.accept") {
      const payload = Harness.ActionAccept.parse(input.payload)
      const item = await record(run)
      const key = payload.idempotency_key
      const found = key ? (await HarnessStore.actions(run.id)).find((next) => next.idempotency_key === key) : undefined
      const act = Harness.ActionRecord.parse({
        ...payload,
        id: found?.id ?? payload.id ?? id("act"),
        run_id: run.id,
        graph_id: item.id,
        created_at: found?.created_at ?? time,
        updated_at: time,
      })
      await HarnessStore.putAction(act)
      const old = (await HarnessStore.edges(run.id)).filter((next) => next.to !== act.id)
      await HarnessStore.putEdges(run.id, [
        ...old,
        ...act.depends_on.map((dep) =>
          Harness.ActionEdge.parse({
            run_id: run.id,
            graph_id: item.id,
            from: dep,
            to: act.id,
          }),
        ),
      ])
      await HarnessStore.append(event("action.accepted", { run: run.id, actor: input.actor, summary: act.title, payload: { action_id: act.id } }))
      await project(run.id)
      return refresh(run)
    }
    if ((input.type === "action.cancel" || input.type === "action.retry") && input.task_id) {
      const act = await HarnessStore.action(run.id, input.task_id)
      if (!act) throw new Error(`Action not found: ${input.task_id}`)
      const status = input.type === "action.cancel" ? "cancelled" : "ready"
      await HarnessStore.putAction(Harness.ActionRecord.parse({ ...act, status, updated_at: time }))
      await HarnessStore.append(event(input.type.replace(".", "_"), { run: run.id, actor: input.actor, payload: { action_id: act.id } }))
      await project(run.id)
      return refresh(run)
    }
    if (input.type === "resource.write") {
      const out = await writeDocument(run.id, Harness.DocumentWrite.parse(input.payload))
      return {
        run: await refresh(run),
        resource: out.resource,
        session: out.session,
      }
    }
    if (input.type === "resource.tombstone" && input.payload.id) {
      const resource = await tombstoneResource(run.id, String(input.payload.id))
      return {
        run: await refresh(run),
        resource,
      }
    }
    if ((input.type === "task.retry" || input.type === "task.cancel" || input.type === "verify.rerun") && input.task_id) {
      const task = await HarnessStore.task(run.id, input.task_id)
      if (!task) throw new Error(`Task not found: ${input.task_id}`)
      const status = input.type === "task.cancel" ? "cancelled" : input.type === "verify.rerun" ? "verifying" : "ready"
      await HarnessStore.putTask(Harness.Task.parse({ ...task, status, updated_at: time }))
      await HarnessStore.append(event(input.type.replace(".", "_"), { run: run.id, actor: input.actor, payload: { task_id: input.task_id } }))
      return refresh(run)
    }
    if (input.type === "decision.answer" && input.decision_id) {
      const dec = await HarnessStore.decision(run.id, input.decision_id)
      if (!dec) throw new Error(`Decision not found: ${input.decision_id}`)
      const answer = String(input.payload.answer ?? "")
      if (!answer) throw new Error("answer is required")
      if (dec.options.length > 0 && !dec.options.some((item) => item.id === answer)) throw new Error(`Invalid decision option: ${answer}`)
      await HarnessStore.putDecision(Harness.Decision.parse({ ...dec, status: "answered", answer, updated_at: time }))
      await HarnessStore.append(event("decision.answered", { run: run.id, actor: input.actor, payload: { decision_id: input.decision_id, answer } }))
      return refresh(run)
    }
    if (input.type === "concept.replace.request") {
      const concept = Harness.Concept.parse({
        id: input.concept_id ?? id("concept"),
        kind: String(input.payload.kind ?? "concept"),
        scope: scope(input.payload.scope),
        namespace: String(input.payload.namespace ?? "project"),
        status: "draft",
        version: Number(input.payload.version ?? 1),
        summary: String(input.payload.summary ?? ""),
        source: typeof input.payload.source === "string" ? input.payload.source : undefined,
        refs: strings(input.payload.refs),
        replaces: strings(input.payload.replaces),
        new_information: typeof input.payload.new_information === "string" ? input.payload.new_information : undefined,
        evidence: strings(input.payload.evidence),
        updated_at: time,
      })
      if (!concept.new_information) throw new Error("new_information is required")
      await HarnessStore.putConcept(concept)
      await HarnessStore.append(event("concept.replace_requested", { run: run.id, actor: input.actor, payload: { concept_id: concept.id } }))
      return refresh(run)
    }
    throw new Error(`Unsupported command: ${input.type}`)
  }

  export async function actionGraph(run: string) {
    return project(run)
  }

  export async function rebuildActionGraph(run: string) {
    return project(run)
  }

  export async function graph(run: string) {
    const tasks = await HarnessStore.tasks(run)
    return {
      nodes: tasks.map((task) => ({
        id: task.id,
        label: task.title,
        status: task.status,
        gates: task.gates,
        artifacts: task.artifacts.length,
      })),
      edges: tasks.flatMap((task) => task.depends_on.map((dep) => ({ from: dep, to: task.id }))),
    }
  }

  export async function concepts(id?: string) {
    const list = await HarnessStore.concepts()
    const keep = id
      ? new Set(
          list
            .filter((item) => item.id === id || item.replaces.includes(id) || item.replaced_by.includes(id))
            .flatMap((item) => [item.id, ...item.replaces, ...item.replaced_by]),
        )
      : undefined
    const nodes = list
      .filter((item) => !keep || keep.has(item.id))
      .map((item) => ({ id: item.id, label: item.summary, status: item.status, kind: item.kind, scope: item.scope, refs: item.refs }))
    return {
      nodes,
      edges: list
        .filter((item) => !keep || keep.has(item.id))
        .flatMap((item) => [
          ...item.replaces.filter((target) => !keep || keep.has(target)).map((target) => ({ from: item.id, to: target, type: "replaces" })),
          ...item.replaced_by.filter((target) => !keep || keep.has(target)).map((target) => ({ from: target, to: item.id, type: "replaced_by" })),
        ]),
    }
  }

  export async function eventQuery(input: { run?: string; task?: string; actor?: string; type?: string; concept?: string; limit?: number; cursor?: string }) {
    const list = input.run ? await HarnessStore.events(input.run) : await HarnessStore.allEvents()
    const offset = input.cursor ? Number(input.cursor) : 0
    const filtered = list
      .filter((item) => !input.actor || item.actor === input.actor)
      .filter((item) => !input.type || item.type === input.type)
      .filter((item) => !input.task || item.payload.task_id === input.task)
      .filter((item) => !input.concept || item.payload.concept_id === input.concept)
      .sort((a, b) => b.time - a.time)
    const limit = input.limit ?? 50
    return {
      items: filtered.slice(offset, offset + limit),
      cursor: offset + limit < filtered.length ? String(offset + limit) : undefined,
    }
  }

  export async function chain(id: string) {
    const item = await HarnessStore.event(id)
    if (!item) throw new Error(`Event not found: ${id}`)
    const list = item.run_id ? await HarnessStore.events(item.run_id) : await HarnessStore.allEvents()
    const task = typeof item.payload.task_id === "string" ? item.payload.task_id : undefined
    const concept = typeof item.payload.concept_id === "string" ? item.payload.concept_id : undefined
    return {
      event: item,
      related: list.filter((next) => next.id !== item.id && (next.payload.task_id === task || next.payload.concept_id === concept)).sort((a, b) => a.time - b.time),
      projections: item.run_id ? await HarnessStore.projections(item.run_id) : [],
    }
  }

  export async function rebuild(run: string) {
    const sum = await HarnessStore.summary(run)
    if (!sum) throw new Error(`Run not found: ${run}`)
    return {
      run: sum.run,
      projections: [
        { name: "run-state", data: sum.run },
        { name: "task-state", data: sum.tasks },
      ],
      source_events: sum.events.length,
      dry_run: true,
    }
  }

  export async function audit(run: string) {
    const item = await HarnessStore.summary(run)
    if (!item) throw new Error(`Run not found: ${run}`)
    return {
      run: item.run,
      decisions: item.decisions,
      gates: item.tasks.flatMap((task) => task.gates.map((gate) => ({ task_id: task.id, ...gate }))),
      artifacts: item.artifacts,
      events: item.events,
    }
  }

  export async function exportAudit(run: string, format: "json" | "markdown") {
    const data = await audit(run)
    if (format === "json") return data
    const lines = [
      `# Harness Audit: ${data.run.name}`,
      "",
      `- Run: ${data.run.id}`,
      `- Status: ${data.run.status}`,
      `- Goal: ${data.run.goal}`,
      "",
      "## Decisions",
      ...data.decisions.map((item) => `- ${item.level} ${item.status}: ${item.question}${item.answer ? ` -> ${item.answer}` : ""}`),
      "",
      "## Gates",
      ...data.gates.map((item) => `- ${item.task_id}/${item.id}: ${item.status}${item.evidence.length ? ` (${item.evidence.join("; ")})` : ""}`),
      "",
      "## Artifacts",
      ...data.artifacts.map((item) => `- ${item.kind}: ${item.path}`),
      "",
      "## Events",
      ...data.events.map((item) => `- ${new Date(item.time).toISOString()} ${item.type}: ${item.summary ?? item.actor}`),
    ]
    return lines.join("\n")
  }
}
