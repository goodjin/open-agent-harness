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

  function tokens(input: string) {
    return Math.ceil(input.length / 4)
  }

  function resId(ref: string) {
    if (!ref.startsWith("resource://")) return
    return ref.slice("resource://".length)
  }

  function memId(ref: string) {
    if (!ref.startsWith("memory://")) return
    return ref.slice("memory://".length)
  }

  function access(item: Harness.Visibility, ctx: Harness.Visibility) {
    if (item === "public") return true
    if (item === "team") return ctx === "team"
    if (item === "project") return ctx === "project" || ctx === "team"
    return ctx === "private"
  }

  function uniq(list: Harness.Ref[]) {
    return [...new Set(list)]
  }

  function links(input: { resource_refs?: Harness.Ref[]; projection_ref?: Harness.Ref; trace_ref?: Harness.Ref; context_ref?: Harness.Ref }) {
    return uniq([...(input.resource_refs ?? []), input.projection_ref, input.trace_ref, input.context_ref].filter((item): item is Harness.Ref => Boolean(item)))
  }

  async function accepted(run: string, ref: Harness.Ref) {
    const list = (await HarnessStore.acceptance(run)).filter((item) => item.target.ref === ref && item.required)
    if (!list.length) return false
    return list.every((item) => item.result === "approved" || item.result === "waived")
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

  export async function writeDocument(run: string, input: z.input<typeof Harness.DocumentWrite>) {
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

  export async function compileContext(input: z.input<typeof Harness.ContextCompileInput>) {
    const payload = Harness.ContextCompileInput.parse(input)
    const time = now()
    const refs = uniq([...payload.refs, ...payload.resource_refs, ...payload.handoff_refs, ...payload.memory_refs])
    const seed = tokens(`${payload.goal}\n${payload.user_input}`)
    const state = await refs.reduce(
      async (prev, ref) => {
        const acc = await prev
        const mode = payload.expansion[ref] ?? "summary"
        const deferred = mode === "on_demand" ? "deferred until on demand" : mode === "on_failure" ? "deferred until on failure" : undefined
        if (deferred) {
          return {
            ...acc,
            excluded: [...acc.excluded, Harness.ContextExcludedRecord.parse({ ref, mode, reason: deferred })],
            explanations: [...acc.explanations, { ref, decision: "excluded" as const, mode, reason: deferred }],
          }
        }
        const mid = memId(ref)
        if (mid) {
          const mem = await HarnessStore.memoryRecord(mid)
          if (mem && access(mem.visibility, payload.visibility)) {
            const cost = tokens(mem.summary)
            return {
              ...acc,
              used: acc.used + cost,
              included: [
                ...acc.included,
                Harness.ContextRecord.parse({ ref, mode: "summary", visibility: mem.visibility, summary: mem.summary, content: mem.summary, reason: "memory summary expansion", tokens: cost }),
              ],
              explanations: [...acc.explanations, { ref, decision: "included" as const, mode: "summary" as const, reason: "memory summary expansion" }],
            }
          }
        }
        const rid = resId(ref)
        if (!rid) {
          const text = `ref ${ref}`
          const cost = tokens(text)
          return {
            ...acc,
            used: acc.used + cost,
            included: [
              ...acc.included,
              Harness.ContextRecord.parse({ ref, mode: "summary", visibility: payload.visibility, summary: text, content: text, reason: "non-resource ref kept as summary", tokens: cost }),
            ],
            explanations: [...acc.explanations, { ref, decision: "included" as const, mode: "summary" as const, reason: "non-resource ref kept as summary" }],
          }
        }
        const data = await readResource(payload.run_id, rid)
        if (!access(data.resource.visibility, payload.visibility)) {
          const reason = `visibility ${data.resource.visibility} not available to ${payload.visibility}`
          return {
            ...acc,
            excluded: [...acc.excluded, Harness.ContextExcludedRecord.parse({ ref, mode, visibility: data.resource.visibility, reason })],
            explanations: [...acc.explanations, { ref, decision: "excluded" as const, mode, reason }],
          }
        }
        const full = mode === "full" || mode === "adaptive"
        const structured = JSON.stringify({ kind: data.resource.kind, summary: data.resource.summary, evidence: data.resource.evidence, uri: data.resource.uri })
        const text = mode === "structured" ? structured : full ? data.body : data.resource.summary
        const cost = tokens(text)
        const sum = data.resource.summary
        if (acc.used + cost <= payload.token_budget) {
          return {
            ...acc,
            used: acc.used + cost,
            included: [...acc.included, Harness.ContextRecord.parse({ ref, mode, visibility: data.resource.visibility, summary: sum, content: text, reason: `${mode} expansion selected`, tokens: cost })],
            explanations: [...acc.explanations, { ref, decision: "included" as const, mode, reason: `${mode} expansion selected` }],
          }
        }
        const low = tokens(sum)
        if (acc.used + low <= payload.token_budget) {
          return {
            ...acc,
            used: acc.used + low,
            included: [
              ...acc.included,
              Harness.ContextRecord.parse({ ref, mode: "summary", visibility: data.resource.visibility, summary: sum, content: sum, reason: "downgraded by token budget", tokens: low }),
            ],
            explanations: [...acc.explanations, { ref, decision: "included" as const, mode: "summary" as const, reason: "downgraded by token budget" }],
          }
        }
        return {
          ...acc,
          excluded: [...acc.excluded, Harness.ContextExcludedRecord.parse({ ref, mode, visibility: data.resource.visibility, reason: "token budget exceeded" })],
          explanations: [...acc.explanations, { ref, decision: "excluded" as const, mode, reason: "token budget exceeded" }],
        }
      },
      Promise.resolve({ used: seed, included: [] as Harness.ContextRecord[], excluded: [] as Harness.ContextExcludedRecord[], explanations: [] as Harness.ContextPreview["explanations"] }),
    )
    const bundle = Harness.ContextBundle.parse({
      id: id("ctx"),
      run_id: payload.run_id,
      assignment_id: payload.assignment_id,
      goal: payload.goal,
      user_input: payload.user_input,
      included: state.included,
      excluded: state.excluded,
      refs,
      summary: state.included
        .map((item) => item.summary)
        .join("\n")
        .slice(0, 600),
      token_budget: payload.token_budget,
      tokens_used: state.used,
      visibility: payload.visibility,
      created_at: time,
    })
    await HarnessStore.putContextBundle(bundle)
    await HarnessStore.projection(payload.run_id, "context-preview", { bundle, explanations: state.explanations })
    await HarnessStore.append(event("context.compiled", { run: payload.run_id, summary: bundle.summary, payload: { context_id: bundle.id, refs: refs.length } }))
    return bundle
  }

  export async function previewContext(input: z.input<typeof Harness.ContextCompileInput>) {
    const bundle = await compileContext(input)
    const projections = await HarnessStore.projections(bundle.run_id)
    const item = projections.find((next) => next.name === "context-preview")
    return Harness.ContextPreview.parse(item?.data ?? { bundle, explanations: [] })
  }

  export function normalizeSync(input: Omit<z.input<typeof Harness.HandoffWrite>, "kind"> & { kind?: Harness.HandoffKind }) {
    const item = Harness.HandoffWrite.parse({ ...input, kind: "sync", state: input.state ?? "ready" })
    return Harness.HandoffWrite.parse({ ...item, resource_refs: uniq(item.resource_refs) })
  }

  export async function writeHandoff(run: string, input: z.input<typeof Harness.HandoffWrite>) {
    const payload = Harness.HandoffWrite.parse(input)
    const time = now()
    const hid = id("handoff")
    const item = Harness.HandoffRecord.parse({
      ...payload,
      id: hid,
      run_id: run,
      uri: `handoff://${hid}`,
      refs: links(payload),
      resource_refs: uniq(payload.resource_refs),
      created_at: time,
      updated_at: time,
    })
    await HarnessStore.putHandoff(item)
    await HarnessStore.append(event(`handoff.${item.kind}`, { run, actor: item.source.id, summary: item.summary, payload: { handoff_id: item.id, target: item.target.id } }))
    await HarnessStore.projection(run, "handoffs", await HarnessStore.handoffs(run))
    return item
  }

  export async function handoffContext(run: string, id: string, input: z.input<typeof Harness.HandoffContextInput>) {
    const payload = Harness.HandoffContextInput.parse(input)
    const item = await HarnessStore.handoff(run, id)
    if (!item) throw new Error(`Handoff not found: ${id}`)
    const out = Harness.HandoffRefs.parse({
      handoff_ref: item.uri,
      resource_refs: item.resource_refs,
      projection_ref: item.projection_ref,
      trace_ref: item.trace_ref,
      context_ref: item.context_ref,
    })
    const list = uniq([out.handoff_ref, ...out.resource_refs, out.projection_ref, out.trace_ref, out.context_ref].filter((ref): ref is Harness.Ref => Boolean(ref)))
    return {
      refs: out,
      bundle: await compileContext({
        run_id: run,
        goal: payload.goal,
        refs: list,
        expansion: Object.fromEntries(item.resource_refs.map((ref) => [ref, "adaptive"])) as Record<string, Harness.RefExpansionMode>,
        token_budget: payload.token_budget,
        visibility: payload.visibility,
      }),
    }
  }

  export function acceptancePolicy(input: z.input<typeof Harness.AcceptancePolicyInput>) {
    const payload = Harness.AcceptancePolicyInput.parse(input)
    const level: Harness.AcceptanceLevel =
      payload.sample_rate > 0
        ? "sampled"
        : payload.risk === "high" && payload.artifact_type === "code" && payload.permission === "write"
          ? "combined"
          : payload.risk === "high" || payload.side_effects.includes("external_service") || payload.resource_scope === "team"
            ? "human"
            : payload.artifact_type === "handoff" || payload.agent_kind === "verifier"
              ? "agent"
              : payload.artifact_type === "code" || payload.criteria.some((item) => item.toLowerCase().includes("test"))
                ? "test"
                : payload.criteria.length
                  ? "auto"
                  : "none"
    return Harness.AcceptancePolicy.parse({
      level,
      required: level !== "none",
      checks: payload.criteria,
      reviewer: level === "agent" ? "verifier" : level === "human" ? "owner" : undefined,
    })
  }

  async function acceptState(run: string) {
    const list = await HarnessStore.acceptance(run)
    await HarnessStore.projection(run, "acceptance-state", list)
    return list
  }

  export async function bindAcceptance(run: string, input: z.input<typeof Harness.AcceptanceBind>) {
    const payload = Harness.AcceptanceBind.parse(input)
    const time = now()
    const item = Harness.AcceptanceRecord.parse({
      id: id("accept"),
      run_id: run,
      target: payload.target,
      criteria: payload.criteria,
      policy: payload.policy,
      required: payload.required,
      created_at: time,
      updated_at: time,
    })
    await HarnessStore.putAcceptance(item)
    await HarnessStore.append(event("acceptance.bound", { run, summary: payload.target.ref, payload: { acceptance_id: item.id, target: payload.target.ref } }))
    await acceptState(run)
    return item
  }

  export async function recordAcceptance(run: string, aid: string, input: z.input<typeof Harness.AcceptanceResultInput>) {
    const payload = Harness.AcceptanceResultInput.parse(input)
    const item = await HarnessStore.acceptanceRecord(run, aid)
    if (!item) throw new Error(`Acceptance not found: ${aid}`)
    const next = Harness.AcceptanceRecord.parse({ ...item, ...payload, updated_at: now() })
    await HarnessStore.putAcceptance(next)
    if (payload.result === "changes_requested") {
      await HarnessStore.putAssignment(
        run,
        Harness.Assignment.parse({
          id: id("assign"),
          task_id: next.target.ref,
          actor: payload.reviewer ?? "runtime",
          role: "repair",
          status: "pending",
          capabilities: ["repair"],
          authority: {},
          context: payload.reason ?? "changes requested",
          updated_at: next.updated_at,
        }),
      )
    }
    await HarnessStore.append(event(`acceptance.${payload.result}`, { run, actor: payload.reviewer, summary: payload.reason, payload: { acceptance_id: aid, target: next.target.ref, evidence: payload.evidence } }))
    await acceptState(run)
    return next
  }

  export async function putWorkflow(input: z.input<typeof Harness.WorkflowWrite>) {
    const payload = Harness.WorkflowWrite.parse(input)
    const time = now()
    const item = Harness.WorkflowAsset.parse({
      ...payload,
      id: id("workflow"),
      created_at: time,
      updated_at: time,
    })
    await HarnessStore.putWorkflow(item)
    return item
  }

  export async function workflows() {
    return HarnessStore.workflows()
  }

  export async function saveWorkflowFromRun(run: string, input: z.input<typeof Harness.WorkflowSaveInput>) {
    const payload = Harness.WorkflowSaveInput.parse(input)
    const item = await HarnessStore.run(run)
    const actions = await HarnessStore.actions(run)
    const asset = await putWorkflow({
      owner: payload.owner,
      source: payload.source,
      visibility: payload.visibility,
      profile: {
        goal: item.goal,
        inputs_schema: {},
        criteria: [],
        nodes: actions.map((act) => ({
          id: act.id,
          title: act.title,
          type: act.type,
          depends_on: act.depends_on,
          criteria: act.criteria,
          failure: act.failure,
          gate: act.gate,
          budget: act.budget,
          artifacts: act.expected_artifacts,
          visibility: act.visibility,
        })),
      },
    })
    return { asset }
  }

  export async function runWorkflow(id: string, input: z.input<typeof Harness.WorkflowRunInput>) {
    const payload = Harness.WorkflowRunInput.parse(input)
    const asset = await HarnessStore.workflow(id)
    if (!asset) throw new Error(`Workflow not found: ${id}`)
    const run = await create({ goal: asset.profile.goal, constraints: [], memory_scopes: ["project"], automation: "guided" })
    await Promise.all(
      asset.profile.nodes.map(async (node) => {
        await command({
          type: "action.accept",
          run_id: run.id,
          actor: "workflow",
          payload: {
            id: node.id,
            kind: "act",
            type: node.type,
            title: node.title,
            depends_on: node.depends_on,
            criteria: node.criteria,
            failure: node.failure,
            gate: node.gate,
            budget: node.budget,
            visibility: node.visibility,
            expected_artifacts: node.artifacts,
          },
        })
        if (node.criteria.length) {
          await bindAcceptance(run.id, {
            target: { type: "action", ref: `action://${node.id}` },
            criteria: node.criteria,
            policy: acceptancePolicy({ criteria: node.criteria, artifact_type: node.gate === "test" ? "code" : "workflow" }),
            required: true,
          })
        }
      }),
    )
    await HarnessStore.projection(run.id, "workflow-run", { workflow_id: asset.id, version: asset.version, inputs: payload.inputs })
    return { asset, run: await refresh(run) }
  }

  export async function recoverWorkflowNode(run: string, node: string, input: z.input<typeof Harness.WorkflowRecoveryInput>) {
    const payload = Harness.WorkflowRecoveryInput.parse(input)
    const act = await HarnessStore.action(run, node)
    if (!act) throw new Error(`Action not found: ${node}`)
    if (payload.op === "inspect") return { action: act, evidence: act.expected_artifacts }
    if (payload.op === "retry" || payload.op === "skip") {
      const next = Harness.ActionRecord.parse({ ...act, status: payload.op === "retry" ? "ready" : "completed", updated_at: now() })
      await HarnessStore.putAction(next)
      await project(run)
      return { action: next }
    }
    if (payload.op === "repair") {
      const assignment = Harness.Assignment.parse({
        id: id("assign"),
        task_id: node,
        actor: "runtime",
        role: "repair",
        status: "pending",
        capabilities: ["repair"],
        authority: {},
        context: payload.reason ?? "repair workflow node",
        updated_at: now(),
      })
      await HarnessStore.putAssignment(run, assignment)
      return { assignment }
    }
    const time = now()
    const decision = Harness.Decision.parse({
      id: id("decision"),
      run_id: run,
      task_id: node,
      question: payload.reason ?? `Decide recovery for ${node}`,
      options: [
        { id: "retry", label: "Retry" },
        { id: "skip", label: "Skip" },
      ],
      created_at: time,
      updated_at: time,
    })
    await HarnessStore.putDecision(decision)
    return { decision }
  }

  export async function createMemoryCandidate(run: string, input: z.input<typeof Harness.MemoryWrite>) {
    const payload = Harness.MemoryWrite.parse({ ...input, run_id: input.run_id ?? run })
    const time = now()
    const mid = id("mem")
    const item = Harness.MemoryRecord.parse({
      ...payload,
      id: mid,
      uri: `memory://${mid}`,
      status: "candidate",
      created_at: time,
      updated_at: time,
    })
    await HarnessStore.putMemoryRecord(item)
    await HarnessStore.append(event("memory.candidate", { run, summary: item.summary, payload: { memory_id: item.id, namespace: item.namespace } }))
    await HarnessStore.projection(run, "memory-candidates", await HarnessStore.memoryRecords())
    return item
  }

  export async function promoteMemory(run: string, id: string, input: z.input<typeof Harness.MemoryPromotionInput>) {
    const payload = Harness.MemoryPromotionInput.parse(input)
    const item = await HarnessStore.memoryRecord(id)
    if (!item) throw new Error(`Memory not found: ${id}`)
    const acc = await HarnessStore.acceptanceRecord(run, payload.acceptance_id)
    if (!acc || (acc.result !== "approved" && acc.result !== "waived")) throw new Error("Memory promotion requires approved acceptance")
    const next = Harness.MemoryRecord.parse({ ...item, status: "current", updated_at: now() })
    await HarnessStore.putMemoryRecord(next)
    await HarnessStore.append(event("memory.promoted", { run, summary: next.summary, payload: { memory_id: next.id, acceptance_id: acc.id } }))
    await HarnessStore.projection(run, "memory-records", await HarnessStore.memoryRecords())
    return next
  }

  export async function memoryContext(run: string, input: z.input<typeof Harness.MemoryContextInput>) {
    const payload = Harness.MemoryContextInput.parse(input)
    const cur = (await HarnessStore.projections(run)).find((item) => item.name === "memory-current" && typeof item.data === "object" && item.data && "namespace" in item.data && item.data.namespace === payload.namespace)
    if (cur && typeof cur.data === "object" && cur.data && "summary" in cur.data && typeof cur.data.summary === "string") {
      const cost = tokens(cur.data.summary)
      const bundle = Harness.ContextBundle.parse({
        id: id("ctx"),
        run_id: run,
        goal: payload.goal,
        included: [
          Harness.ContextRecord.parse({
            ref: "projection://memory-current",
            mode: "summary",
            visibility: payload.visibility,
            summary: cur.data.summary,
            content: cur.data.summary,
            reason: "current projection takes precedence",
            tokens: cost,
          }),
        ],
        excluded: payload.memory_refs.map((ref) => Harness.ContextExcludedRecord.parse({ ref, mode: "summary", reason: "projection overrides historical memory" })),
        refs: ["projection://memory-current", ...payload.memory_refs],
        summary: cur.data.summary,
        token_budget: payload.token_budget,
        tokens_used: cost,
        visibility: payload.visibility,
        created_at: now(),
      })
      await HarnessStore.putContextBundle(bundle)
      await HarnessStore.projection(run, "context-preview", { bundle, explanations: [] })
      return { bundle }
    }
    return {
      bundle: await compileContext({
        run_id: run,
        goal: payload.goal,
        memory_refs: payload.memory_refs,
        token_budget: payload.token_budget,
        visibility: payload.visibility,
      }),
    }
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
      if (payload.status === "completed" && payload.criteria.length && !(await accepted(run.id, `action://${payload.id}`))) throw new Error(`Acceptance gate required: action://${payload.id}`)
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
