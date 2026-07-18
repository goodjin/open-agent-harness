import { Button } from "@open-agent-harness/ui/button"
import { Markdown } from "@open-agent-harness/ui/markdown"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/context/language"

export type ProposalPart = {
  type: string
  text: string
  synthetic?: boolean
  ignored?: boolean
  metadata?: Record<string, unknown>
}

type Status = "proposed" | "confirming" | "revising" | "creating" | "started" | "failed" | "cancelled"

type Base = {
  id: string
  body?: string
  refs: string[]
  status: Status
  error?: string
  target?: string
}

export type TaskProposal =
  | (Base & {
      kind: "update"
      revision: string
      summary?: string
      children: string[]
    })
  | (Base & {
      kind: "handoff"
      handoff: string
      title?: string
    })

type Update = Extract<TaskProposal, { kind: "update" }>

type Result = { status?: string; target_session_id?: string }
type View = { id: string; status: Status; dismissed: boolean; target?: string; error?: string }

const record = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input)
const text = (input: unknown) => (typeof input === "string" && input.length ? input : undefined)
const list = (input: unknown) => (Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : [])

const status = (input: unknown, kind: TaskProposal["kind"], part: string): Status => {
  if (part === "task_handoff_started" || input === "started") return "started"
  if (input === "failed") return "failed"
  if (input === "blocked") return "failed"
  if (input === "cancelled") return "cancelled"
  if (input === "revising") return "revising"
  if (input === "creating" || input === "confirmed") return kind === "update" ? "revising" : "creating"
  return "proposed"
}

export function proposalIndex(
  messages: { id: string; role: string; parentID?: string }[],
  parts: Record<string, unknown[] | undefined>,
) {
  return messages.reduce((map, message) => {
    if (message.role !== "assistant" || !message.parentID) return map
    const items = parts[message.id] ?? []
    if (!items.length) return map
    const prev = map.get(message.parentID)
    if (prev) {
      prev.push(...items)
      return map
    }
    map.set(message.parentID, [...items])
    return map
  }, new Map<string, unknown[]>())
}

export function proposal(input: unknown, body?: string): TaskProposal | undefined {
  if (!record(input) || input.type !== "text" || input.synthetic !== true || input.ignored !== true) return
  if (!record(input.metadata)) return
  const kind = text(input.metadata.kind)
  if (kind === "task_update_proposal") {
    const id = text(input.metadata.proposal_id)
    const revision = text(input.metadata.draft_revision_id) ?? text(input.metadata.old_revision_id)
    if (!id || !revision) return
    return {
      kind: "update",
      id,
      revision,
      body,
      summary: text(input.metadata.difference_summary),
      children: list(input.metadata.affected_child_ids),
      refs: list(input.metadata.reusable_result_refs),
      status: status(input.metadata.status, "update", kind),
      error: text(input.metadata.error),
    }
  }
  if (kind !== "task_handoff_proposal" && kind !== "task_handoff_started") return
  const handoff = text(input.metadata.handoff_id)
  if (!handoff) return
  return {
    kind: "handoff",
    id: text(input.metadata.proposal_id) ?? `handoff:${handoff}`,
    handoff,
    body,
    title: text(input.metadata.title),
    refs: list(input.metadata.context_refs),
    status: status(input.metadata.status, "handoff", kind),
    error: text(input.metadata.error),
    target: text(input.metadata.target_session_id),
  }
}

const progress = (input: unknown, body?: string): Update | undefined => {
  if (!record(input) || input.type !== "text" || input.synthetic !== true || input.ignored !== true) return
  if (!record(input.metadata) || input.metadata.kind !== "task_update_progress") return
  const id = text(input.metadata.proposal_id)
  const revision = text(input.metadata.draft_revision_id) ?? text(input.metadata.old_revision_id)
  if (!id || !revision) return
  return {
    kind: "update",
    id,
    revision,
    body,
    summary: text(input.metadata.difference_summary),
    children: list(input.metadata.affected_child_ids),
    refs: list(input.metadata.reusable_result_refs),
    status: status(input.metadata.status, "update", "task_update_progress"),
    error: text(input.metadata.error),
  }
}

export function proposals(
  parts: unknown[],
  bodies: Map<string, string | undefined>,
  decisions = new Map<string, "pending" | "confirmed" | "cancelled">(),
) {
  const map = parts
    .flatMap((part) => {
      const metadata = record(part) && record(part.metadata) ? part.metadata : undefined
      const item = proposal(part, bodies.get(text(metadata?.proposal_id) ?? ""))
      return item ? [item] : []
    })
    .reduce((map, item) => {
      const key = item.kind === "handoff" ? item.handoff : item.id
      const prev = map.get(key)
      if (!prev || prev.kind !== item.kind) {
        map.set(key, item)
        return map
      }
      if (item.kind === "update" && prev.kind === "update") {
        map.set(key, {
          ...prev,
          ...item,
          body: item.body ?? prev.body,
          summary: item.summary ?? prev.summary,
          children: item.children.length ? item.children : prev.children,
          refs: item.refs.length ? item.refs : prev.refs,
        })
        return map
      }
      if (item.kind === "handoff" && prev.kind === "handoff")
        map.set(key, {
          ...prev,
          ...item,
          id: prev.id.startsWith("handoff:") ? item.id : prev.id,
          body: item.body ?? prev.body,
          title: item.title ?? prev.title,
          refs: item.refs.length ? item.refs : prev.refs,
        })
      return map
    }, new Map<string, TaskProposal>())
  parts
    .flatMap((part) => {
      const metadata = record(part) && record(part.metadata) ? part.metadata : undefined
      const item = progress(part, bodies.get(text(metadata?.proposal_id) ?? ""))
      return item ? [item] : []
    })
    .forEach((item) => {
      const prev = map.get(item.id)
      if (!prev || prev.kind !== "update") return
      map.set(item.id, {
        ...prev,
        ...item,
        body: item.body ?? prev.body,
        summary: item.summary ?? prev.summary,
        children: item.children.length ? item.children : prev.children,
        refs: item.refs.length ? item.refs : prev.refs,
      })
    })
  return Array.from(map.values()).map((item) => {
    if (item.status !== "proposed") return item
    const decision = decisions.get(item.id)
    if (decision === "cancelled") return { ...item, status: "cancelled" as const }
    if (decision === "confirmed")
      return { ...item, status: item.kind === "update" ? ("revising" as const) : ("creating" as const) }
    return item
  })
}

export function proposalError(input: unknown, fallback: string) {
  if (record(input) && record(input.data)) {
    const message = text(input.data.message)
    if (message) return message
  }
  if (input instanceof Error && input.message) return input.message
  if (typeof input === "string" && input.length) return input
  return fallback
}

export function proposalFlow(input: {
  send: (proposal: TaskProposal, action: "confirm" | "cancel") => Promise<Result>
  state: (view: View) => void
  focus: () => void
  error?: (error: unknown) => string
}) {
  let current: TaskProposal | undefined
  let key: string | undefined
  let token = 0
  let busy = false
  let dismissed = false
  let shown: View | undefined

  const emit = (value: Partial<Omit<View, "id">> = {}) => {
    if (!current) return
    shown = {
      id: current.id,
      status: current.status,
      dismissed,
      target: current.target,
      error: current.error,
      ...value,
    }
    input.state(shown)
  }
  const act = async (action: "confirm" | "cancel") => {
    if (!current || busy) return
    const item = current
    const mark = token
    busy = true
    dismissed = false
    emit({ status: "confirming" })
    const result = await input.send(item, action).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    if (mark !== token) return
    busy = false
    if ("error" in result) {
      emit({ status: "failed", error: input.error?.(result.error) ?? proposalError(result.error, "Request failed") })
      return
    }
    const next =
      action === "cancel"
        ? "cancelled"
        : result.value.status === undefined && item.kind === "update"
          ? "revising"
          : status(
              result.value.status,
              item.kind,
              item.kind === "handoff" ? "task_handoff_proposal" : "task_update_progress",
            )
    emit({ status: next, target: result.value.target_session_id ?? item.target, error: undefined })
  }

  return {
    change(item: TaskProposal, scope = "") {
      const next = `${scope}\u0000${item.id}`
      if (key === next) {
        current = item
        if (busy || dismissed) return
        if (shown?.status === "started" && item.status !== "started") return
        if (item.status === "proposed" && shown?.status !== "proposed") return
        if (item.status === "failed" && shown?.status === "failed" && !item.error) {
          emit({ error: shown.error })
          return
        }
        emit()
        return
      }
      token++
      key = next
      current = item
      busy = false
      dismissed = false
      shown = undefined
      emit()
    },
    confirm: () => act("confirm"),
    cancel: () => act("cancel"),
    discuss() {
      if (!current) return
      token++
      busy = false
      dismissed = true
      emit()
      input.focus()
    },
    stop() {
      token++
      busy = false
    },
  }
}

export function SessionTaskProposal(props: {
  value: TaskProposal
  scope: string
  confirm: (proposal: TaskProposal, action: "confirm" | "cancel") => Promise<Result>
  discuss: () => void
  open: (target: string) => void
}) {
  const language = useLanguage()
  const [view, setView] = createSignal<View>({
    id: props.value.id,
    status: props.value.status,
    dismissed: false,
    target: props.value.target,
    error: props.value.error,
  })
  const flow = proposalFlow({
    send: props.confirm,
    state: setView,
    focus: props.discuss,
    error: (error) => proposalError(error, language.t("common.requestFailed")),
  })
  createEffect(() => flow.change(props.value, props.scope))
  onCleanup(flow.stop)
  const key = () => `session.task.proposal.status.${view().status}` as const
  const label = () => language.t(key())
  const pending = () => view().status === "proposed" || view().status === "failed"

  return (
    <Show when={!view().dismissed}>
      <div class="px-6 md:px-8 pt-4">
        <section
          data-component="session-task-proposal"
          class="rounded-md border border-border-weak-base bg-background-base overflow-hidden"
          aria-label={props.value.kind === "update" ? language.t("session.task.proposal.update") : language.t("session.task.proposal.handoff")}
        >
          <header class="flex items-start justify-between gap-3 border-b border-border-weaker-base px-3 py-2">
            <div class="min-w-0">
              <div class="text-12-medium text-text-strong">
                {props.value.kind === "update" ? language.t("session.task.proposal.update") : language.t("session.task.proposal.handoff")}
              </div>
              <Show when={props.value.kind === "handoff" ? props.value.title : props.value.summary}>
                {(value) => <div class="mt-0.5 text-11-regular text-text-weak break-words">{value()}</div>}
              </Show>
            </div>
            <span class="shrink-0 rounded-sm border border-border-weak-base px-1.5 py-0.5 text-10-medium text-text-weak" role="status" aria-live="polite">
              {label()}
            </span>
          </header>
          <div class="flex flex-col gap-3 p-3">
            <Show when={props.value.kind === "update" && props.value.children.length}>
              <div class="text-11-regular text-text-weak">
                {language.t("session.task.proposal.children", { sessions: props.value.kind === "update" ? props.value.children.join(", ") : "" })}
              </div>
            </Show>
            <Show when={props.value.kind === "handoff"}>
              <div class="text-11-regular text-text-weak">{language.t("session.task.proposal.ownership")}</div>
            </Show>
            <Show when={props.value.refs.length}>
              <div class="text-11-regular text-text-weak">
                {language.t("session.task.proposal.refs", { refs: props.value.refs.join(", ") })}
              </div>
            </Show>
            <Show when={props.value.body}>
              {(body) => (
                <div data-scrollable class="max-h-[420px] overflow-auto rounded-sm bg-background-strong p-3 text-12-regular text-text-strong">
                  <Markdown text={body()} />
                </div>
              )}
            </Show>
            <Show when={view().error}>
              {(error) => <div role="alert" class="text-11-regular text-text-danger-base">{error()}</div>}
            </Show>
            <Show when={view().status === "started" && view().target}>
              {(target) => (
                <Button variant="secondary" size="small" onClick={() => props.open(target())} aria-label={language.t("session.task.proposal.openTarget")}>
                  {language.t("session.task.proposal.openTarget")}
                </Button>
              )}
            </Show>
            <Show when={pending()}>
              <div class="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" size="small" onClick={flow.discuss} aria-label={language.t("session.task.proposal.discuss")}>
                  {language.t("session.task.proposal.discuss")}
                </Button>
                <Show when={view().status !== "failed"}>
                  <Button variant="secondary" size="small" onClick={() => void flow.cancel()} aria-label={language.t("session.task.proposal.cancel")}>
                    {language.t("session.task.proposal.cancel")}
                  </Button>
                </Show>
                <Button variant="primary" size="small" onClick={() => void flow.confirm()} aria-label={view().status === "failed" ? language.t("session.task.proposal.retry") : language.t("session.task.proposal.confirm")}>
                  {view().status === "failed" ? language.t("session.task.proposal.retry") : language.t("session.task.proposal.confirm")}
                </Button>
              </div>
            </Show>
          </div>
        </section>
      </div>
    </Show>
  )
}
