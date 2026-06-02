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

  function clean(input: string[]) {
    return [...new Set(input.map((item) => item.trim()).filter(Boolean))]
  }

  function refs(input: Harness.Event) {
    return clean([
      ...strings(input.payload.refs),
      ...strings(input.payload.artifacts),
      ...strings(input.payload.raw_refs),
    ])
  }

  function raw(input: Harness.Event) {
    return clean(strings(input.payload.raw_refs))
  }

  function terminal(input: unknown) {
    return input === "completed" || input === "failed" || input === "cancelled"
  }

  function handoff(input: unknown) {
    if (input === "completed") return "completed"
    if (input === "failed") return "failed"
    if (input === "blocked") return "blocked"
    return "partial"
  }

  function prompt(input: { goal: string; status: Harness.HandoffStatus; reasons: Harness.HandoffCause[] }) {
    return [
      "Write a concise handoff self-report in plain text using this format.",
      "",
      `Status: ${input.status}`,
      `Goal: ${input.goal}`,
      `Reasons: ${input.reasons.join(", ") || "runtime_boundary"}`,
      "",
      "Done:",
      "- ",
      "",
      "Artifacts:",
      "- ",
      "",
      "Unresolved:",
      "- ",
      "",
      "Risks:",
      "- ",
      "",
      "Next:",
      "- ",
    ].join("\n")
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

  export async function createHandoff(input: Harness.CreateHandoff) {
    const data = Harness.CreateHandoff.parse(input)
    await HarnessStore.run(data.source.run_id)
    const time = now()
    const facts = data.facts
      .filter((item) => item.refs.length > 0)
      .map((item) => Harness.HandoffFact.parse({ ...item, confidence: "evidenced" }))
    const notes = clean([
      ...data.notes,
      ...data.facts.filter((item) => item.refs.length === 0).map((item) => item.text),
    ])
    const next = data.next.map((item) => (typeof item === "string" ? { goal: item, depends_on: [] } : item))
    const handoff = Harness.Handoff.parse({
      type: "handoff",
      version: "1",
      id: id("handoff"),
      source: data.source,
      target: data.target,
      status: data.status,
      goal: data.goal,
      summary: data.summary,
      facts,
      notes,
      artifacts: data.artifacts,
      decisions: data.decisions,
      constraints: data.constraints,
      risks: data.risks,
      unresolved: data.unresolved,
      next,
      raw_refs: data.raw_refs,
      visibility: data.visibility,
      created_by: "runtime",
      created_at: time,
    })
    await HarnessStore.putHandoff(handoff)
    await HarnessStore.append(
      event("handoff.created", {
        run: data.source.run_id,
        summary: data.summary,
        payload: {
          handoff_id: handoff.id,
          source_session: data.source.session_id,
          source_assignment: data.source.assignment_id,
          status: data.status,
          target_executor: data.target.executor,
          target_capability: data.target.capability,
          artifacts: data.artifacts.map((item) => item.ref),
          raw_refs: data.raw_refs,
        },
      }),
    )
    return handoff
  }

  export async function buildHandoffSource(input: Harness.BuildHandoffSource) {
    const data = Harness.BuildHandoffSource.parse(input)
    const sum = await HarnessStore.summary(data.run_id)
    if (!sum) throw new Error(`Run not found: ${data.run_id}`)
    const events = sum.events.sort((a, b) => a.time - b.time)
    const timeline = events.map((item, i) =>
      Harness.HandoffTrace.parse({
        seq: i + 1,
        type: item.type,
        status: typeof item.payload.status === "string" ? item.payload.status : undefined,
        summary: item.summary,
        refs: refs(item),
        time: item.time,
      }),
    )
    return Harness.HandoffSourceBundle.parse({
      type: "handoff.source",
      version: "1",
      id: id("handoff-source"),
      source: data.source ?? { run_id: data.run_id },
      status: data.status,
      goal: data.goal ?? sum.run.goal,
      self_report: data.self_report,
      timeline,
      artifacts: sum.artifacts.map((item) => ({
        ref: item.path,
        type: item.kind,
        status: "available",
        summary: item.summary,
      })),
      decisions: sum.decisions.map((item) => `${item.status}: ${item.question}${item.answer ? ` -> ${item.answer}` : ""}`),
      unresolved: clean([...(data.self_report?.unresolved ?? []), ...sum.decisions.filter((item) => item.status === "pending").map((item) => item.question)]),
      raw_refs: clean([...data.raw_refs, ...events.flatMap(raw)]),
    })
  }

  export async function planHandoff(input: Harness.PlanHandoff) {
    const data = Harness.PlanHandoff.parse(input)
    const sum = await HarnessStore.summary(data.run_id)
    if (!sum) throw new Error(`Run not found: ${data.run_id}`)
    const assign = data.source?.assignment_id ? sum.assignments.find((item) => item.id === data.source?.assignment_id) : undefined
    const state = data.assignment_status ?? assign?.status
    const reasons = Harness.HandoffCause.array().parse(
      clean([
        ...(terminal(state) ? ["assignment_terminal"] : []),
        ...(data.next.length > 0 ? ["downstream_next"] : []),
        ...(data.intent ? ["model_intent"] : []),
        ...(data.policy ? ["policy"] : []),
        ...(data.user ? ["user"] : []),
        ...(data.budget ? ["context_budget"] : []),
        ...(data.fan_in ? ["workflow_fan_in"] : []),
        ...(data.final ? ["final_continuation"] : []),
      ]),
    )
    const trigger = reasons.length > 0
    const status = trigger ? (data.status ?? handoff(state)) : data.status
    const report = trigger && (data.request_self_report ?? true)
    return Harness.HandoffPlan.parse({
      type: "handoff.plan",
      run_id: data.run_id,
      source: data.source ?? { run_id: data.run_id },
      target: data.target,
      trigger,
      reasons,
      request_self_report: report,
      status,
      prompt: report && status ? prompt({ goal: sum.run.goal, status, reasons }) : undefined,
    })
  }

  export async function requestHandoffSelfReport(input: Harness.RequestHandoffSelfReport) {
    const data = Harness.RequestHandoffSelfReport.parse(input)
    const run = await HarnessStore.run(data.run_id)
    const item = Harness.HandoffSelfReportRequest.parse({
      type: "handoff.self_report_request",
      id: id("handoff-report"),
      source: data.source ?? { run_id: run.id },
      status: data.status,
      reasons: data.reasons,
      prompt: prompt({ goal: data.goal ?? run.goal, status: data.status, reasons: data.reasons }),
      created_at: now(),
    })
    await HarnessStore.append(
      event("handoff.self_report_requested", {
        run: run.id,
        summary: "Handoff self-report requested.",
        payload: {
          request_id: item.id,
          source_session: item.source.session_id,
          source_assignment: item.source.assignment_id,
          status: item.status,
          reasons: item.reasons,
          prompt: item.prompt,
        },
      }),
    )
    return item
  }

  export function renderHandoff(input: Harness.Handoff) {
    const data = Harness.Handoff.parse(input)
    const source = data.source.agent_id ?? data.source.session_id ?? data.source.assignment_id ?? data.source.run_id
    const lines = [
      "## Handoff",
      "",
      `Source: \`${source}\``,
      `Status: \`${data.status}\``,
      "",
      "### Goal",
      "",
      data.goal,
      "",
      "### Summary",
      "",
      data.summary,
      "",
      ...section("What Was Done", data.facts.flatMap((item) => [`- ${item.text}`, ...item.refs.map((ref) => `  Ref: \`${ref}\``)])),
      ...section(
        "Available Artifacts",
        data.artifacts.flatMap((item) => [`- \`${item.ref}\``, ...(item.summary ? [`  ${item.summary}`] : [])]),
      ),
      ...section("Notes", data.notes.map((item) => `- ${item}`)),
      ...section("Remaining Risk", data.risks.map((item) => `- ${item}`)),
      ...section("Unresolved", data.unresolved.map((item) => `- ${item}`)),
      ...section(
        "Suggested Next Steps",
        data.next.map((item, i) => `${i + 1}. ${item.goal}${item.depends_on.length ? `\n   Depends: ${item.depends_on.map((dep) => `\`${dep}\``).join(", ")}` : ""}`),
      ),
      ...section("Raw Evidence", data.raw_refs.map((item) => `- Full source ref: \`${item}\``)),
    ]
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()
  }

  function section(title: string, lines: string[]) {
    if (lines.length === 0) return []
    return ["### " + title, "", ...lines, ""]
  }

  type RunCommand = Harness.Command & { type: Exclude<Harness.Command["type"], "handoff.plan" | "handoff.self_report.request"> }

  export function command(input: RunCommand): Promise<Harness.Run>
  export function command(input: Harness.Command & { type: "handoff.plan" }): Promise<Harness.HandoffPlan>
  export function command(input: Harness.Command & { type: "handoff.self_report.request" }): Promise<Harness.HandoffSelfReportRequest>
  export function command(input: Harness.Command): Promise<Harness.Run | Harness.HandoffPlan | Harness.HandoffSelfReportRequest>
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
    if (input.type === "handoff.plan") return planHandoff(Harness.PlanHandoff.parse({ ...input.payload, run_id: run.id }))
    if (input.type === "handoff.self_report.request") return requestHandoffSelfReport(Harness.RequestHandoffSelfReport.parse({ ...input.payload, run_id: run.id }))
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
      handoffs: item.handoffs,
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
      "## Handoffs",
      ...data.handoffs.map((item) => `- ${item.status}: ${item.summary}`),
      "",
      "## Events",
      ...data.events.map((item) => `- ${new Date(item.time).toISOString()} ${item.type}: ${item.summary ?? item.actor}`),
    ]
    return lines.join("\n")
  }
}
