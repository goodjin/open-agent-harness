import z from "zod"
import { Database, sql } from "../storage/db"

export namespace TaskLedgerAudit {
  const ID = z.string().min(3).max(256)
  const Hash = z.string().regex(/^[0-9a-f]{64}$/)
  const Data = z.record(z.string(), z.unknown())
  const Severity = z.enum(["repairable", "blocked"])
  const Entity = z.enum(["task", "revision", "requirement", "resource", "event", "command"])
  const Code = z.enum([
    "task_missing",
    "task_contract_invalid",
    "revision_pointer_missing",
    "revision_pointer_invalid",
    "revision_active_conflict",
    "revision_contract_invalid",
    "requirement_pointer_missing",
    "requirement_pointer_invalid",
    "requirement_chain_invalid",
    "requirement_contract_invalid",
    "requirement_orphan",
    "requirement_ref_invalid",
    "requirement_hash_mismatch",
    "resource_contract_invalid",
    "resource_revision_invalid",
    "resource_identity_conflict",
    "resource_lifecycle_invalid",
    "revision_spec_missing",
    "revision_spec_invalid",
    "revision_plan_missing",
    "revision_plan_invalid",
    "event_sequence_invalid",
    "event_contract_invalid",
    "event_revision_invalid",
    "event_command_invalid",
    "event_resource_invalid",
    "command_contract_invalid",
    "command_key_invalid",
    "command_incomplete",
    "command_apply_missing",
    "command_state_invalid",
    "command_event_invalid",
    "command_result_invalid",
    "terminal_state_invalid",
  ])

  export const Issue = z
    .object({
      severity: Severity,
      code: Code,
      entity: Entity,
      id: z.string().max(256).nullable(),
      refs: z.array(z.string().max(256)).max(8),
    })
    .strict()
  export type Issue = z.infer<typeof Issue>

  export const Result = z
    .object({
      task_id: z.string().startsWith("task_"),
      status: z.enum(["ok", "repairable", "blocked"]),
      issues: z.array(Issue).max(50),
      evidence: z
        .object({
          revisions: z.number().int().nonnegative(),
          requirements: z.number().int().nonnegative(),
          resources: z.number().int().nonnegative(),
          events: z.number().int().nonnegative(),
          commands: z.number().int().nonnegative(),
          last_event_seq: z.number().int().nonnegative(),
          issue_count: z.number().int().nonnegative(),
          truncated: z.boolean(),
          command_identity_scope: z.literal("persisted_facts_only"),
        })
        .strict(),
    })
    .strict()
  export type Result = z.infer<typeof Result>

  const Task = z
    .object({
      id: z.string().startsWith("task_"),
      session_id: ID,
      status: z.enum(["running", "waiting_user", "revising", "blocked", "completed", "failed"]),
      current_revision_id: z.string().startsWith("revision_").nullable(),
      requirement_id: z.string().startsWith("requirement_").nullable(),
      last_event_seq: z.number().int().nonnegative(),
      source_type: z.enum(["user", "delegation", "handoff", "legacy"]),
      source_ref: Data,
    })
    .strict()
  type Task = z.infer<typeof Task>

  const Revision = z
    .object({
      id: z.string().startsWith("revision_"),
      task_id: z.string().startsWith("task_"),
      version: z.number().int().positive(),
      previous_id: z.string().startsWith("revision_").nullable(),
      status: z.enum(["draft", "active", "completed", "failed", "archived"]),
      body_hash: Hash,
      source_message_id: z.string().nullable(),
      terminal_status: z.enum(["completed", "blocked", "failed"]).nullable(),
      requirement_id: z.string().startsWith("requirement_").nullable(),
      spec_ref: z.string().nullable(),
      plan_ref: z.string().nullable(),
      workflow: Data,
    })
    .strict()
  type Revision = z.infer<typeof Revision>

  const Requirement = z
    .object({
      id: z.string().startsWith("requirement_"),
      task_id: z.string().startsWith("task_"),
      version: z.number().int().positive(),
      source_refs: z.array(z.string().min(1)),
      body_ref: z.string().min(1),
      body_hash: Hash,
      constraints: Data,
      acceptance: z.array(Data),
      created_by: z.enum(["user", "agent", "migration"]),
      confirmed_at: z.number().int().nonnegative().nullable(),
      supersedes_id: z.string().startsWith("requirement_").nullable(),
      time_created: z.number().int().nonnegative(),
    })
    .strict()
  type Requirement = z.infer<typeof Requirement>

  const Resource = z
    .object({
      id: z.string().startsWith("resource_"),
      task_id: z.string().startsWith("task_"),
      revision_id: z.string().startsWith("revision_").nullable(),
      kind: z.enum(["requirement", "spec", "plan"]),
      uri: z.string().min(1),
      hash: Hash,
      size: z.number().int().nonnegative(),
      summary: z.string().nullable(),
      producer_type: z.enum(["requirement", "revision", "assignment", "migration"]),
      producer_id: z.string().min(1),
      visibility: z.enum(["private", "task", "project", "exportable"]),
      lifecycle: z.enum(["active", "archived", "tombstoned"]),
      time_created: z.number().int().nonnegative(),
    })
    .strict()
  type Resource = z.infer<typeof Resource>

  const Event = z
    .object({
      task_id: z.string().startsWith("task_"),
      seq: z.number().int().positive(),
      id: z.string().startsWith("event_"),
      type: z.string().min(1),
      revision_id: z.string().startsWith("revision_").nullable(),
      command_id: z.string().startsWith("command_").nullable(),
      data: Data,
      resource_refs: z.array(z.string().startsWith("resource_")),
      time_created: z.number().int().nonnegative(),
    })
    .strict()
  type Event = z.infer<typeof Event>

  const Command = z
    .object({
      id: z.string().startsWith("command_"),
      task_id: z.string().startsWith("task_"),
      kind: z.enum([
        "task.create",
        "task.revise",
        "revision.activate",
        "task.workflow.sync",
        "task.finish",
        "task.migrate",
      ]),
      idempotency_key: z.string().min(1),
      status: z.enum(["accepted", "applied", "rejected"]),
      result_ref: z.string().nullable(),
      time_created: z.number().int().nonnegative(),
      time_applied: z.number().int().nonnegative().nullable(),
    })
    .strict()
  type Command = z.infer<typeof Command>

  type Raw = Record<string, unknown>
  type Add = (
    severity: z.infer<typeof Severity>,
    code: z.infer<typeof Code>,
    entity: z.infer<typeof Entity>,
    id: unknown,
    refs?: unknown[],
  ) => void

  function text(input: unknown) {
    try {
      return String(input).slice(0, 256)
    } catch {
      return "[invalid]"
    }
  }

  function collector() {
    const state = { blocked: false, all: new Map<string, Issue>() }
    const add: Add = (severity, code, entity, id, refs = []) => {
      const normalized = [...new Set(refs.map(text))].sort().slice(0, 8)
      const item = Issue.parse({ severity, code, entity, id: id === null || id === undefined ? null : text(id), refs: normalized })
      const key = JSON.stringify(item)
      state.blocked ||= severity === "blocked"
      if (!state.all.has(key)) state.all.set(key, item)
    }
    return { state, add }
  }

  function decode(row: Raw, fields: string[]) {
    const copy = { ...row }
    for (const field of fields) {
      if (typeof row[field] !== "string") return
      try {
        copy[field] = JSON.parse(row[field])
      } catch {
        return
      }
    }
    return copy
  }

  function parsed<T extends z.ZodType>(
    rows: Raw[],
    schema: T,
    fields: string[],
    code: z.infer<typeof Code>,
    entity: z.infer<typeof Entity>,
    add: Add,
  ) {
    return rows.flatMap((row) => {
      const value = decode(row, fields)
      const result = value ? schema.safeParse(value) : undefined
      if (result?.success) return [result.data as z.output<T>]
      add("blocked", code, entity, row.id, fields.map((field) => row[field]))
      return []
    })
  }

  function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
    const values = map.get(key)
    if (values) values.push(value)
    if (!values) map.set(key, [value])
  }

  function auditLineage(start: Requirement, taskID: string, map: Map<string, Requirement>, memo: Map<string, boolean>, used: Set<string>) {
    if (memo.has(start.id)) return memo.get(start.id)!
    const path: Requirement[] = []
    const seen = new Set<string>()
    let current: Requirement | undefined = start
    let valid = true
    while (current) {
      used.add(current.id)
      if (memo.has(current.id)) {
        valid = memo.get(current.id)!
        break
      }
      if (seen.has(current.id) || current.task_id !== taskID) {
        valid = false
        break
      }
      seen.add(current.id)
      path.push(current)
      if (current.version === 1) {
        valid = current.supersedes_id === null
        break
      }
      const prior: Requirement | undefined = current.supersedes_id ? map.get(current.supersedes_id) : undefined
      if (!prior || prior.version !== current.version - 1) {
        valid = false
        break
      }
      current = prior
    }
    path.forEach((item) => memo.set(item.id, valid))
    return valid
  }

  function keyedRevision(item: Command, task: Task) {
    const prefix =
      item.kind === "revision.activate"
        ? `revision.activate:${task.id}:`
        : item.kind === "task.workflow.sync"
          ? `task.workflow.sync:${task.id}:`
          : item.kind === "task.finish"
            ? `task.finish:${task.id}:`
            : item.kind === "task.migrate"
              ? `task.migrate:${task.id}:`
              : undefined
    if (!prefix || !item.idempotency_key.startsWith(prefix)) return
    const rest = item.idempotency_key.slice(prefix.length)
    if (item.kind === "task.workflow.sync" || item.kind === "task.finish") {
      const match = /^(revision_[^:]+):[0-9a-f]{64}$/.exec(rest)
      return match?.[1]
    }
    return /^revision_[^:]+$/.test(rest) ? rest : undefined
  }

  function digest(key: string, prefix: string) {
    return key.startsWith(prefix) && /^[0-9a-f]{64}$/.test(key.slice(prefix.length))
  }

  function commandKey(
    item: Command,
    linked: Event[],
    task: Task,
    revisions: Map<string, Revision>,
    requirements: Map<string, Requirement>,
    assignments: Set<string>,
    messages: Set<string>,
  ) {
    const target = linked.find((event) => event.revision_id)?.revision_id
    const revision = target ? revisions.get(target) : undefined
    const requirement = revision?.requirement_id ? requirements.get(revision.requirement_id) : undefined
    if (item.kind === "task.create") {
      if (item.idempotency_key.startsWith("task.create:assignment:")) {
        const assignment = item.idempotency_key.slice("task.create:assignment:".length)
        return requirement
          ? requirement.source_refs.includes(`assignment:${assignment}`)
          : assignments.has(assignment)
      }
      const source = task.source_ref
      if (task.source_type === "handoff" && typeof source.handoffID !== "string") return false
      if (task.source_type === "delegation" && typeof source.sessionID !== "string") return false
      if (task.source_type === "delegation" && source.runID !== undefined && typeof source.runID !== "string")
        return false
      if (task.source_type === "delegation" && source.actionID !== undefined && typeof source.actionID !== "string")
        return false
      if (task.source_type === "legacy" && source.runID !== undefined && typeof source.runID !== "string")
        return false
      if (task.source_type === "user" && source.messageID !== undefined && typeof source.messageID !== "string")
        return false
      const expected =
        task.source_type === "handoff"
          ? `task.create:handoff:${source.handoffID}`
          : task.source_type === "delegation" &&
              typeof source.sessionID === "string" &&
              typeof source.runID === "string" &&
              typeof source.actionID === "string"
            ? `task.create:delegation:${source.sessionID}:${source.runID}:${source.actionID}`
            : task.source_type === "legacy" && typeof source.runID === "string"
              ? `task.create:legacy:${task.session_id}:${source.runID}`
              : task.source_type === "user" && typeof source.messageID === "string"
                ? `task.create:user:${task.session_id}:${source.messageID}`
                : `task.create:${task.source_type}:${task.session_id}`
      return item.idempotency_key === expected
    }
    if (item.kind === "task.revise") {
      if (item.idempotency_key.startsWith("task.revise:assignment:")) {
        const assignment = item.idempotency_key.slice("task.revise:assignment:".length)
        return requirement
          ? requirement.source_refs.includes(`assignment:${assignment}`)
          : assignments.has(assignment)
      }
      const message = `task.revise:message:${task.id}:`
      if (item.idempotency_key.startsWith(message)) {
        const id = item.idempotency_key.slice(message.length)
        return revision ? revision.source_message_id === id : messages.has(id)
      }
      return digest(item.idempotency_key, `task.revise:${task.id}:`)
    }
    const keyed = keyedRevision(item, task)
    return !!keyed && revisions.has(keyed)
  }

  const families = {
    "task.create": ["task.created", "requirement.recorded", "revision.activated"],
    "task.revise": ["requirement.revised", "revision.created", "revision.drafted"],
    "revision.activate": ["revision.archived", "revision.activated"],
    "task.workflow.sync": ["task.workflow_synced"],
    "task.finish": ["result.recorded"],
    "task.migrate": ["task.migrated"],
  } as const

  function family(item: Command, linked: Event[], task: Task, revisions: Map<string, Revision>, add: Add) {
    const base = families[item.kind]
    const types = linked.map((event) => event.type)
    const terminal = item.kind === "task.finish" && linked[1] && ["task.completed", "task.blocked", "task.failed"].includes(linked[1].type)
    const expected = terminal ? [...base, linked[1]!.type] : [...base]
    const prefix = types.every((type, index) => type === expected[index])
    const complete = prefix && types.length === expected.length
    const known = linked.every((event) => !!event.revision_id && revisions.has(event.revision_id))
    const keyed = keyedRevision(item, task)
    const target = keyed ? revisions.get(keyed) : undefined
    const prior = target?.previous_id ? revisions.get(target.previous_id) : undefined
    const ids = [...new Set(linked.map((event) => event.revision_id))]
    const role =
      item.kind === "revision.activate"
        ? item.status === "rejected" ||
          (!!target &&
            !!prior &&
            target.previous_id === prior.id &&
            (!linked[0] || linked[0].revision_id === prior.id) &&
            (!linked[1] || linked[1].revision_id === target.id))
        : !linked.length ||
          (ids.length === 1 &&
            (!["task.workflow.sync", "task.finish", "task.migrate"].includes(item.kind) || ids[0] === keyed))
    const staged =
      item.kind !== "revision.activate" || !complete || item.status === "rejected"
        ? true
        : item.status === "accepted"
          ? prior?.status === "archived" &&
            target?.status === "active" &&
            task.current_revision_id === target.id
          : prior?.status === "archived" &&
            !!target &&
            (target.status === "archived"
              ? task.current_revision_id !== target.id
              : task.current_revision_id === target.id &&
                ["active", "completed", "failed"].includes(target.status))
    const valid = prefix && (item.status !== "applied" || complete) && known && role && staged
    if (!valid)
      add("blocked", "command_event_invalid", "command", item.id, [
        ...linked.map((event) => `${event.seq}:${event.type}:${event.revision_id}`),
        keyed,
        target?.previous_id,
        target?.status,
        task.current_revision_id,
      ])
    if (item.status === "accepted" && valid) {
      if (complete) add("repairable", "command_apply_missing", "command", item.id, [linked.length])
      if (!complete) add("repairable", "command_incomplete", "command", item.id, [linked.length])
    }
    if (item.status !== "applied") return
    if (item.kind === "revision.activate" && linked.length >= 2) {
      const next = linked[1]?.revision_id
      if (!valid || item.result_ref !== `revision://${next}`)
        add("blocked", "command_result_invalid", "command", item.id, [prior?.id, next, item.result_ref])
    }
    if (item.kind === "task.create" && item.result_ref !== `task://${task.id}`)
      add("blocked", "command_result_invalid", "command", item.id, [item.result_ref])
    if (item.kind === "task.revise") {
      const id = linked[0]?.revision_id
      if (!id || item.result_ref !== `revision://${id}`)
        add("blocked", "command_result_invalid", "command", item.id, [id, item.result_ref])
    }
    if (item.kind === "task.workflow.sync") {
      const id = linked[0]?.revision_id
      if (!id || item.result_ref !== `task://${task.id}/revision/${id}/workflow`)
        add("blocked", "command_result_invalid", "command", item.id, [id, item.result_ref])
    }
    if (item.kind === "task.migrate") {
      const id = linked[0]?.revision_id
      if (!id || item.result_ref !== `task://${task.id}/revision/${id}/migration-baseline`)
        add("blocked", "command_result_invalid", "command", item.id, [id, item.result_ref])
    }
    if (item.kind === "task.finish" && linked[0]?.data.result_ref !== item.result_ref)
      add("blocked", "command_result_invalid", "command", item.id, [linked[0]?.data.result_ref, item.result_ref])
  }

  export function audit(taskID: string) {
    const id = z.string().startsWith("task_").parse(taskID)
    return Database.transaction((tx) => {
      const { state, add } = collector()
      const taskRows = tx.all<Raw>(sql`
        SELECT id, session_id, status, current_revision_id, requirement_id, last_event_seq, source_type,
          CAST(source_ref AS TEXT) AS source_ref FROM session_task WHERE id = ${id}
      `)
      const revisionRows = tx.all<Raw>(sql`
        SELECT id, task_id, version, previous_id, status, body_hash, source_message_id, terminal_status,
          requirement_id, spec_ref, plan_ref, CAST(workflow AS TEXT) AS workflow
        FROM task_revision WHERE task_id = ${id} ORDER BY version, id
      `)
      const requirementRows = tx.all<Raw>(sql`
        SELECT id, task_id, version, CAST(source_refs AS TEXT) AS source_refs, body_ref, body_hash,
          CAST(constraints AS TEXT) AS constraints, CAST(acceptance AS TEXT) AS acceptance,
          created_by, confirmed_at, supersedes_id, time_created FROM task_requirement WHERE task_id = ${id}
        ORDER BY version, id
      `)
      const resourceRows = tx.all<Raw>(sql`
        SELECT id, task_id, revision_id, kind, uri, hash, size, summary, producer_type, producer_id,
          visibility, lifecycle, time_created FROM task_resource WHERE task_id = ${id}
        ORDER BY time_created, id
      `)
      const eventRows = tx.all<Raw>(sql`
        SELECT task_id, seq, id, type, revision_id, command_id, CAST(data AS TEXT) AS data,
          CAST(resource_refs AS TEXT) AS resource_refs, time_created
        FROM task_event WHERE task_id = ${id} ORDER BY seq
      `)
      const commandRows = tx.all<Raw>(sql`
        SELECT id, task_id, kind, idempotency_key, status, result_ref, time_created, time_applied
        FROM task_command WHERE task_id = ${id} ORDER BY rowid
      `)
      const tasks = parsed(taskRows, Task, ["source_ref"], "task_contract_invalid", "task", add) as Task[]
      const revisions = parsed(revisionRows, Revision, ["workflow"], "revision_contract_invalid", "revision", add) as Revision[]
      const requirements = parsed(
        requirementRows,
        Requirement,
        ["source_refs", "constraints", "acceptance"],
        "requirement_contract_invalid",
        "requirement",
        add,
      ) as Requirement[]
      const resources = parsed(resourceRows, Resource, [], "resource_contract_invalid", "resource", add) as Resource[]
      const events = parsed(eventRows, Event, ["data", "resource_refs"], "event_contract_invalid", "event", add) as Event[]
      const commands = parsed(commandRows, Command, [], "command_contract_invalid", "command", add) as Command[]
      const task = tasks[0]
      if (!task) add("blocked", taskRows.length ? "task_contract_invalid" : "task_missing", "task", id)

      const revision = new Map(revisions.map((item) => [item.id, item]))
      const requirement = new Map(requirements.map((item) => [item.id, item]))
      const resource = new Map(resources.map((item) => [item.id, item]))
      const command = new Map(commands.map((item) => [item.id, item]))
      const resourcesByRevision = new Map<string, Resource[]>()
      const revisionsByRequirement = new Map<string, Revision[]>()
      const eventsByCommand = new Map<string, Event[]>()
      const identities = new Map<string, Resource[]>()
      const requirementsByIdentity = new Map<string, Requirement[]>()
      const assignments = new Set<string>()
      const messages = new Set<string>()
      revisions.forEach((item) => item.requirement_id && push(revisionsByRequirement, item.requirement_id, item))
      revisions.forEach((item) => item.source_message_id && messages.add(item.source_message_id))
      requirements.forEach((item) => {
        push(requirementsByIdentity, `${item.body_hash}\0${item.body_ref}`, item)
        item.source_refs.forEach((ref) => {
          if (ref.startsWith("assignment:")) assignments.add(ref.slice("assignment:".length))
        })
      })
      resources.forEach((item) => {
        if (item.revision_id) push(resourcesByRevision, item.revision_id, item)
        push(identities, `${item.kind}\0${item.hash}\0${item.uri}`, item)
      })
      events.forEach((item) => item.command_id && push(eventsByCommand, item.command_id, item))

      const active = revisions.flatMap((item) => (item.status === "active" ? [item] : []))
      const current = task?.current_revision_id
        ? revision.get(task.current_revision_id)
        : active.length === 1
          ? active[0]
          : undefined
      if (task && !task.current_revision_id)
        add(active.length === 1 ? "repairable" : "blocked", "revision_pointer_missing", "task", task.id, active.map((item) => item.id))
      if (task?.current_revision_id && !current)
        add("blocked", "revision_pointer_invalid", "task", task.id, [task.current_revision_id])
      if (active.length > 1) add("blocked", "revision_active_conflict", "task", task?.id, active.map((item) => item.id))

      const memo = new Map<string, boolean>()
      const used = new Set<string>()
      const direct = new Set<string>()
      if (task?.requirement_id) direct.add(task.requirement_id)
      revisions.forEach((item) => item.requirement_id && direct.add(item.requirement_id))
      direct.forEach((ref) => {
        const item = requirement.get(ref)
        if (!item) return add("blocked", "requirement_pointer_invalid", "requirement", ref)
        if (!auditLineage(item, id, requirement, memo, used))
          add("blocked", "requirement_chain_invalid", "requirement", item.id, [item.version, item.supersedes_id])
      })
      requirements.forEach((item) => {
        const owners = revisionsByRequirement.get(item.id) ?? []
        owners.forEach((owner) => {
          const refs = (resourcesByRevision.get(owner.id) ?? []).flatMap((entry) =>
            entry.uri === item.body_ref ? [entry] : [],
          )
          if (refs.length !== 1) add("blocked", "requirement_ref_invalid", "requirement", item.id, refs.map((entry) => entry.id))
          if (refs[0]?.hash !== item.body_hash)
            add("blocked", "requirement_hash_mismatch", "requirement", item.id, [item.body_hash, refs[0]?.hash])
        })
      })

      if (task && current) {
        const taskreq = task.requirement_id ? requirement.get(task.requirement_id) : undefined
        const revreq = current.requirement_id ? requirement.get(current.requirement_id) : undefined
        if (taskreq && revreq && taskreq.id !== revreq.id)
          add("blocked", "requirement_pointer_invalid", "task", task.id, [taskreq.id, revreq.id])
        if (!taskreq || !revreq) {
          const candidates = [
            ...new Map(
              (resourcesByRevision.get(current.id) ?? [])
                .flatMap((item) => requirementsByIdentity.get(`${item.hash}\0${item.uri}`) ?? [])
                .filter((item) => auditLineage(item, id, requirement, memo, used))
                .map((item) => [item.id, item]),
            ).values(),
          ]
          const known = taskreq ?? revreq
          const safe = known ? candidates.some((item) => item.id === known.id) : candidates.length === 1
          add(
            safe ? "repairable" : "blocked",
            "requirement_pointer_missing",
            !taskreq ? "task" : "revision",
            !taskreq ? task.id : current.id,
            candidates.map((item) => item.id),
          )
        }
        const currentResources = resourcesByRevision.get(current.id) ?? []
        const specs = currentResources.flatMap((item) =>
          item.kind === "spec" &&
          item.lifecycle === "active" &&
          item.hash === current.body_hash &&
          item.task_id === id &&
          item.revision_id === current.id
            ? [item]
            : [],
        )
        if (!current.spec_ref)
          add(specs.length === 1 ? "repairable" : "blocked", "revision_spec_missing", "revision", current.id, specs.map((item) => item.id))
        if (current.spec_ref) {
          const exact = specs.flatMap((item) => (item.uri === current.spec_ref ? [item] : []))
          if (exact.length !== 1) add("blocked", "revision_spec_invalid", "revision", current.id, [current.spec_ref, ...exact.map((item) => item.id)])
        }
        const plans = currentResources.flatMap((item) =>
          item.kind === "plan" &&
          item.lifecycle === "active" &&
          item.task_id === id &&
          item.revision_id === current.id
            ? [item]
            : [],
        )
        if (!current.plan_ref && plans.length === 1)
          add("repairable", "revision_plan_missing", "revision", current.id, [plans[0]!.id])
        if (!current.plan_ref && plans.length > 1)
          add("blocked", "revision_plan_invalid", "revision", current.id, plans.map((item) => item.id))
        if (current.plan_ref) {
          const exact = plans.flatMap((item) => (item.uri === current.plan_ref ? [item] : []))
          if (exact.length !== 1)
            add("blocked", "revision_plan_invalid", "revision", current.id, [current.plan_ref, ...exact.map((item) => item.id)])
        }
      }
      requirements.forEach((item) => {
        if (!used.has(item.id)) add("blocked", "requirement_orphan", "requirement", item.id)
      })

      resources.forEach((item) => {
        const owner = item.revision_id ? revision.get(item.revision_id) : undefined
        if (item.revision_id && !owner) add("blocked", "resource_revision_invalid", "resource", item.id, [item.revision_id])
        if (owner?.status === "archived" && item.lifecycle === "active")
          add("blocked", "resource_lifecycle_invalid", "resource", item.id, [owner.id, item.lifecycle])
      })
      identities.forEach((items) => {
        if (items.length > 1) add("blocked", "resource_identity_conflict", "resource", items[0]?.id, items.map((item) => item.id))
      })

      if (task && (events.length !== task.last_event_seq || events.some((item, index) => item.seq !== index + 1)))
        add("blocked", "event_sequence_invalid", "task", task.id, [task.last_event_seq, events.length, events.at(-1)?.seq])
      events.forEach((item) => {
        if (item.revision_id && !revision.has(item.revision_id))
          add("blocked", "event_revision_invalid", "event", item.id, [item.revision_id])
        if (item.command_id && !command.has(item.command_id))
          add("blocked", "event_command_invalid", "event", item.id, [item.command_id])
        const missing = item.resource_refs.flatMap((ref) => (!resource.has(ref) ? [ref] : []))
        if (missing.length || new Set(item.resource_refs).size !== item.resource_refs.length)
          add("blocked", "event_resource_invalid", "event", item.id, [...missing, ...item.resource_refs])
        item.resource_refs.forEach((ref) => {
          if (resource.get(ref)?.lifecycle === "tombstoned")
            add("blocked", "resource_lifecycle_invalid", "resource", ref, [item.id])
        })
      })

      if (task)
        commands.forEach((item) => {
          const linked = eventsByCommand.get(item.id) ?? []
          if (!commandKey(item, linked, task, revision, requirement, assignments, messages))
            add("blocked", "command_key_invalid", "command", item.id, [
              "scope:persisted_facts_only",
              item.idempotency_key,
            ])
          if (
            (item.status === "accepted" && (item.result_ref !== null || item.time_applied !== null)) ||
            (item.status === "applied" && item.time_applied === null) ||
            (item.status === "rejected" && (item.result_ref !== null || item.time_applied !== null || linked.length))
          )
            add("blocked", "command_state_invalid", "command", item.id, [item.status, item.result_ref, item.time_applied])
          family(item, linked, task, revision, add)
        })

      if (task && current) {
        const last = events.at(-1)
        const terminal =
          last?.type === "task.completed" ? "completed" : last?.type === "task.failed" ? "failed" : last?.type === "task.blocked" ? "blocked" : undefined
        if (terminal) {
          const prior = events.at(-2)
          const valid =
            last?.revision_id === current.id &&
            prior?.type === "result.recorded" &&
            prior.revision_id === current.id &&
            prior.command_id === last!.command_id &&
            task.status === terminal &&
            (terminal === "blocked" ? current.status === "active" : current.status === terminal)
          if (!valid) add("blocked", "terminal_state_invalid", "task", task.id, [task.status, current.status, last!.revision_id, prior?.type])
        }
        if (task.status === "completed" || task.status === "failed" || task.status === "blocked") {
          const type = `task.${task.status}`
          const status = task.status === "blocked" ? "active" : task.status
          if (last?.type !== type || last.revision_id !== current.id || current.status !== status)
            add("blocked", "terminal_state_invalid", "task", task.id, [task.status, current.status, last?.type, last?.revision_id])
        }
      }

      const all = [...state.all.values()]
      return Result.parse({
        task_id: id,
        status: state.blocked ? "blocked" : all.length ? "repairable" : "ok",
        issues: all.slice(0, 50),
        evidence: {
          revisions: revisionRows.length,
          requirements: requirementRows.length,
          resources: resourceRows.length,
          events: eventRows.length,
          commands: commandRows.length,
          last_event_seq: task?.last_event_seq ?? 0,
          issue_count: all.length,
          truncated: all.length > 50,
          command_identity_scope: "persisted_facts_only",
        },
      })
    })
  }
}
