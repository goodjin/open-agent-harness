import {
  AssistantMessage,
  type FileDiff,
  Message as MessageType,
  Part as PartType,
} from "@open-agent-harness/sdk/v2/client"
import type { SessionStatus } from "@open-agent-harness/sdk/v2"
import { useData } from "../context"
import { useFileComponent } from "../context/file"

import { Binary } from "@open-agent-harness/util/binary"
import { getDirectory, getFilename } from "@open-agent-harness/util/path"
import { createEffect, createMemo, createSignal, For, on, ParentProps, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { AssistantParts, Message, MessageDivider, PART_MAPPING, type UserActions } from "./message-part"
import { partView } from "./message-part-view"
import { Card } from "./card"
import { Accordion } from "./accordion"
import { StickyAccordionHeader } from "./sticky-accordion-header"
import { DiffChanges } from "./diff-changes"
import { Icon } from "./icon"
import { TextShimmer } from "./text-shimmer"
import { SessionRetry } from "./session-retry"
import { createAutoScroll } from "../hooks"
import { useI18n } from "../context/i18n"
import { diffRows, diffStats, diffUnique, heading, thinkingText, turnAssistants } from "./session-turn-helpers"

export { turnAssistants } from "./session-turn-helpers"

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function unwrap(message: string) {
  const text = message.replace(/^Error:\s*/, "").trim()

  const parse = (value: string) => {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  }

  const read = (value: string) => {
    const first = parse(value)
    if (typeof first !== "string") return first
    return parse(first.trim())
  }

  let json = read(text)

  if (json === undefined) {
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start !== -1 && end > start) {
      json = read(text.slice(start, end + 1))
    }
  }

  if (!record(json)) return message

  const err = record(json.error) ? json.error : undefined
  if (err) {
    const type = typeof err.type === "string" ? err.type : undefined
    const msg = typeof err.message === "string" ? err.message : undefined
    if (type && msg) return `${type}: ${msg}`
    if (msg) return msg
    if (type) return type
    const code = typeof err.code === "string" ? err.code : undefined
    if (code) return code
  }

  const msg = typeof json.message === "string" ? json.message : undefined
  if (msg) return msg

  const reason = typeof json.error === "string" ? json.error : undefined
  if (reason) return reason

  return message
}

function same<T>(a: readonly T[], b: readonly T[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

function list<T>(value: T[] | undefined | null, fallback: T[]) {
  if (Array.isArray(value)) return value
  return fallback
}

function partState(part: PartType, showReasoningSummaries: boolean) {
  const view = partView(part, showReasoningSummaries)
  if (view.kind === "hidden") return
  if (part.type === "text" || part.type === "reasoning" || part.type === "tool") return "visible" as const
  if (PART_MAPPING[part.type]) return "visible" as const
  return
}

export type SessionTurnFilter = "all" | "thinking" | "input" | "output" | "tool"

function filterPart(part: PartType, filter: SessionTurnFilter, role: MessageType["role"]) {
  if (filter === "all") return true
  if (filter === "input") return role === "user"
  if (role !== "assistant") return false
  if (filter === "thinking") return part.type === "reasoning"
  if (filter === "output") return part.type === "text"
  return part.type === "tool"
}

function time(value: number | undefined) {
  if (typeof value !== "number") return ""
  const date = new Date(value)
  const pad = (next: number) => next.toString().padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const diffLimit = 3

export function SessionTurnDiffs(props: { diffs: FileDiff[]; loadDiff?: (diff: FileDiff) => Promise<FileDiff | undefined> }) {
  const i18n = useI18n()
  const fileComponent = useFileComponent()
  const [state, setState] = createStore({
    open: false,
    details: false,
    expanded: [] as string[],
    detail: {} as Record<string, FileDiff | undefined>,
    loading: {} as Record<string, boolean | undefined>,
  })
  const files = createMemo(() => diffUnique(props.diffs))
  const stats = createMemo(() => diffStats(files()))
  const rows = createMemo(() => diffRows(files(), state.open))
  const expanded = () => state.expanded

  createEffect(
    on(
      () => state.details,
      (value, prev) => {
        if (!value && prev) setState("expanded", [])
      },
      { defer: true },
    ),
  )

  return (
    <Show when={files().length > 0}>
      <div data-component="session-turn-diffs">
        <div data-component="session-turn-diffs-summary">
          <div data-slot="session-turn-diffs-title">
            <span data-slot="session-turn-diffs-label">{i18n.t("ui.sessionTurn.diff.summary")}</span>
            <span data-slot="session-turn-diffs-count">
              {stats().files} {i18n.t(stats().files === 1 ? "ui.common.file.one" : "ui.common.file.other")}
            </span>
            <div data-slot="session-turn-diffs-meta">
              <DiffChanges changes={files()} variant="bars" />
            </div>
          </div>
          <div data-slot="session-turn-diff-list">
            <For each={rows()}>
              {(diff) => (
                <div data-slot="session-turn-diff-row">
                  <span data-slot="session-turn-diff-path">
                    <Show when={diff.file.includes("/")}>
                      <span data-slot="session-turn-diff-directory">{`\u202A${getDirectory(diff.file)}\u202C`}</span>
                    </Show>
                    <span data-slot="session-turn-diff-filename">{getFilename(diff.file)}</span>
                  </span>
                  <span data-slot="session-turn-diff-changes">
                    <DiffChanges changes={diff} />
                  </span>
                </div>
              )}
            </For>
          </div>
          <Show when={files().length > diffLimit || files().length > 0}>
            <div data-slot="session-turn-diffs-actions">
              <Show when={files().length > diffLimit}>
                <button type="button" onClick={() => setState("open", !state.open)}>
                  {state.open
                    ? i18n.t("ui.sessionTurn.diff.collapse")
                    : i18n.t("ui.sessionTurn.diff.expand", { count: files().length - diffLimit })}
                </button>
              </Show>
              <button type="button" onClick={() => setState("details", !state.details)}>
                {state.details ? i18n.t("ui.sessionReview.collapseAll") : i18n.t("ui.sessionReview.expandAll")}
              </button>
            </div>
          </Show>
        </div>
        <Show when={state.details}>
          <div data-component="session-turn-diffs-content">
            <Accordion
              multiple
              style={{ "--sticky-accordion-offset": "40px" }}
              value={expanded()}
              onChange={(value) => setState("expanded", Array.isArray(value) ? value : value ? [value] : [])}
            >
              <For each={files()}>
                {(diff) => {
                  const active = createMemo(() => expanded().includes(diff.file))
                  const [visible, setVisible] = createSignal(false)
                  const item = createMemo(() => state.detail[diff.file] ?? diff)

                  createEffect(
                    on(
                      active,
                      (value) => {
                        if (!value) return
                        if (!props.loadDiff) return
                        if (state.detail[diff.file] || state.loading[diff.file]) return
                        setState("loading", diff.file, true)
                        props
                          .loadDiff(diff)
                          .then((full) => {
                            if (full) setState("detail", diff.file, full)
                          })
                          .finally(() => setState("loading", diff.file, false))
                      },
                      { defer: true },
                    ),
                  )

                  createEffect(
                    on(
                      active,
                      (value) => {
                        if (!value) {
                          setVisible(false)
                          return
                        }

                        requestAnimationFrame(() => {
                          if (!active()) return
                          setVisible(true)
                        })
                      },
                      { defer: true },
                    ),
                  )

                  return (
                    <Accordion.Item value={diff.file}>
                      <StickyAccordionHeader>
                        <Accordion.Trigger>
                          <div data-slot="session-turn-diff-trigger">
                            <span data-slot="session-turn-diff-path">
                              <Show when={diff.file.includes("/")}>
                                <span data-slot="session-turn-diff-directory">
                                  {`\u202A${getDirectory(diff.file)}\u202C`}
                                </span>
                              </Show>
                              <span data-slot="session-turn-diff-filename">{getFilename(diff.file)}</span>
                            </span>
                            <div data-slot="session-turn-diff-meta">
                              <span data-slot="session-turn-diff-changes">
                                <DiffChanges changes={diff} />
                              </span>
                              <span data-slot="session-turn-diff-chevron">
                                <Icon name="chevron-down" size="small" />
                              </span>
                            </div>
                          </div>
                        </Accordion.Trigger>
                      </StickyAccordionHeader>
                      <Accordion.Content>
                        <Show when={visible()}>
                          <div data-slot="session-turn-diff-view" data-scrollable>
                            <Show when={!state.loading[diff.file]} fallback={<TextShimmer text={i18n.t("ui.list.loading")} />}>
                              <Dynamic
                                component={fileComponent}
                                mode="diff"
                                before={{ name: diff.file, contents: item().before }}
                                after={{ name: diff.file, contents: item().after }}
                              />
                            </Show>
                          </div>
                        </Show>
                      </Accordion.Content>
                    </Accordion.Item>
                  )
                }}
              </For>
            </Accordion>
          </div>
        </Show>
      </div>
    </Show>
  )
}

export function SessionTurn(
  props: ParentProps<{
    sessionID: string
    messageID: string
    actions?: UserActions
    showReasoningSummaries?: boolean
    shellToolDefaultOpen?: boolean
    editToolDefaultOpen?: boolean
    filter?: SessionTurnFilter
    active?: boolean
    status?: SessionStatus
    onUserInteracted?: () => void
    classes?: {
      root?: string
      content?: string
      container?: string
    }
  }>,
) {
  const data = useData()
  const i18n = useI18n()

  const emptyMessages: MessageType[] = []
  const emptyParts: PartType[] = []
  const emptyAssistant: AssistantMessage[] = []
  const idle = { type: "idle" as const }

  const allMessages = createMemo(() => list(data.store.message?.[props.sessionID], emptyMessages))

  const messageIndex = createMemo(() => {
    const messages = allMessages() ?? emptyMessages
    const result = Binary.search(messages, props.messageID, (m) => m.id)

    const index = result.found ? result.index : messages.findIndex((m) => m.id === props.messageID)
    if (index < 0) return -1

    const msg = messages[index]
    if (!msg || msg.role !== "user") return -1

    return index
  })

  const message = createMemo(() => {
    const index = messageIndex()
    if (index < 0) return undefined

    const messages = allMessages() ?? emptyMessages
    const msg = messages[index]
    if (!msg || msg.role !== "user") return undefined

    return msg
  })

  const pending = createMemo(() => {
    if (typeof props.active === "boolean") return
    const messages = allMessages() ?? emptyMessages
    return messages.findLast(
      (item): item is AssistantMessage => item.role === "assistant" && typeof item.time.completed !== "number",
    )
  })

  const pendingUser = createMemo(() => {
    const item = pending()
    if (!item?.parentID) return
    const messages = allMessages() ?? emptyMessages
    const result = Binary.search(messages, item.parentID, (m) => m.id)
    const msg = result.found ? messages[result.index] : messages.find((m) => m.id === item.parentID)
    if (!msg || msg.role !== "user") return
    return msg
  })

  const active = createMemo(() => {
    if (typeof props.active === "boolean") return props.active
    const msg = message()
    const parent = pendingUser()
    if (!msg || !parent) return false
    return parent.id === msg.id
  })

  const parts = createMemo(() => {
    const msg = message()
    if (!msg) return emptyParts
    return list(data.store.part?.[msg.id], emptyParts)
  })

  const compaction = createMemo(() => parts().find((part) => part.type === "compaction"))

  const assistantMessages = createMemo(
    () => {
      const msg = message()
      if (!msg) return emptyAssistant

      const messages = allMessages() ?? emptyMessages
      const index = messageIndex()
      if (index < 0) return emptyAssistant

      return turnAssistants(messages, msg.id)
    },
    emptyAssistant,
    { equals: same },
  )

  const interrupted = createMemo(() => assistantMessages().some((m) => m.error?.name === "MessageAbortedError"))
  const divider = createMemo(() => {
    if (compaction()) return i18n.t("ui.messagePart.compaction")
    if (interrupted()) return i18n.t("ui.message.interrupted")
    return ""
  })
  const error = createMemo(
    () => assistantMessages().find((m) => m.error && m.error.name !== "MessageAbortedError")?.error,
  )
  const showAssistantCopyPartID = createMemo(() => {
    const messages = assistantMessages()

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (!message) continue

      const parts = list(data.store.part?.[message.id], emptyParts)
      for (let j = parts.length - 1; j >= 0; j--) {
        const part = parts[j]
        if (!part || part.type !== "text" || !part.text?.trim()) continue
        return part.id
      }
    }

    return undefined
  })
  const errorText = createMemo(() => {
    const msg = error()?.data?.message
    if (typeof msg === "string") return unwrap(msg)
    if (msg === undefined || msg === null) return ""
    return unwrap(String(msg))
  })

  const status = createMemo(() => {
    if (props.status !== undefined) return props.status
    if (typeof props.active === "boolean" && !props.active) return idle
    return data.store.session_status[props.sessionID] ?? idle
  })
  const working = createMemo(() => status().type !== "idle" && active())
  const showReasoningSummaries = createMemo(() => props.showReasoningSummaries ?? true)
  const filter = createMemo(() => props.filter ?? "all")

  const assistantCopyPartID = createMemo(() => {
    if (working()) return null
    return showAssistantCopyPartID() ?? null
  })
  const turnDurationMs = createMemo(() => {
    const start = message()?.time.created
    if (typeof start !== "number") return undefined

    const end = assistantMessages().reduce<number | undefined>((max, item) => {
      const completed = item.time.completed
      if (typeof completed !== "number") return max
      if (max === undefined) return completed
      return Math.max(max, completed)
    }, undefined)

    if (typeof end !== "number") return undefined
    if (end < start) return undefined
    return end - start
  })
  const userTime = createMemo(() => time(message()?.time.created))
  const assistantTime = createMemo(() => time(assistantMessages()[0]?.time.created))
  const assistantVisible = createMemo(() =>
    assistantMessages().reduce((count, message) => {
      const parts = list(data.store.part?.[message.id], emptyParts)
      return (
        count +
        parts.filter((part) => filterPart(part, filter(), "assistant") && partState(part, showReasoningSummaries()) === "visible")
          .length
      )
    }, 0),
  )
  const visibleItems = createMemo(() =>
    assistantMessages().flatMap((message) =>
      list(data.store.part?.[message.id], emptyParts).flatMap((part) => {
        if (!filterPart(part, filter(), "assistant")) return []
        if (partState(part, showReasoningSummaries()) !== "visible") return []
        return [{ message, part }]
      }),
    ),
  )
  const visibleParts = createMemo(() => visibleItems().map((item) => item.part))
  const messageDone = (message: AssistantMessage) =>
    typeof message.time.completed === "number" || !!message.error
  const partDone = (part: PartType) => {
    const value = (part as { time?: unknown }).time
    return record(value) && typeof value.end === "number"
  }
  const partStatus = createMemo(() => {
    const item = visibleItems().at(-1)
    if (!item) return ""
    const part = item.part
    if (part.type === "reasoning") {
      if (working() && !partDone(part) && !messageDone(item.message)) return thinking()
      return i18n.t("ui.sessionTurn.status.thinkingDone")
    }
    if (part.type === "text") {
      if (working() && !messageDone(item.message)) return i18n.t("ui.sessionTurn.status.responseStreaming")
      return i18n.t("ui.sessionTurn.status.responseDone")
    }
    if (part.type === "tool") {
      if (part.state.status === "running" || part.state.status === "pending") return i18n.t("ui.sessionTurn.status.toolStreaming")
      return i18n.t("ui.sessionTurn.status.toolDone")
    }
    return ""
  })
  const reasoningHeading = createMemo(() =>
    assistantMessages()
      .flatMap((message) => list(data.store.part?.[message.id], emptyParts))
      .filter((part): part is PartType & { type: "reasoning"; text: string } => part.type === "reasoning")
      .map((part) => heading(part.text))
      .filter((text): text is string => !!text)
      .at(-1),
  )
  const thinking = createMemo(() =>
    thinkingText(
      i18n.t("ui.sessionTurn.status.thinking"),
      i18n.t("ui.sessionTurn.status.thinkingWithTopic"),
      reasoningHeading(),
    ),
  )
  const showThinking = createMemo(() => {
    if (!working() || !!error()) return false
    if (status().type === "retry") return false
    if (status().type === "rate_limited") return false
    return visibleParts().some((part) => part.type === "reasoning")
  })

  const autoScroll = createAutoScroll({
    working,
    onUserInteracted: props.onUserInteracted,
    overflowAnchor: "dynamic",
  })

  return (
    <div data-component="session-turn" class={props.classes?.root}>
      <div
        ref={autoScroll.scrollRef}
        onScroll={autoScroll.handleScroll}
        data-slot="session-turn-content"
        class={props.classes?.content}
      >
        <div onClick={autoScroll.handleInteraction}>
          <Show when={message()}>
            <div
              ref={autoScroll.contentRef}
              data-message={message()!.id}
              data-slot="session-turn-message-container"
              class={props.classes?.container}
            >
              <Show when={userTime()}>
                <div data-slot="session-turn-message-time">{userTime()}</div>
              </Show>
              <div data-slot="session-turn-message-content" aria-live="off">
                <Message
                  message={message()!}
                  parts={parts().filter((part) => filterPart(part, filter(), "user"))}
                  actions={props.actions}
                />
              </div>
              <Show when={divider()}>
                <div data-slot="session-turn-compaction">
                  <MessageDivider label={divider()} />
                </div>
              </Show>
              <Show when={assistantVisible() > 0}>
                <div data-slot="session-turn-assistant-content" aria-hidden={working()}>
                  <Show when={assistantTime()}>
                    <div data-slot="session-turn-message-time">{assistantTime()}</div>
                  </Show>
                  <AssistantParts
                    messages={assistantMessages()}
                    showAssistantCopyPartID={assistantCopyPartID()}
                    turnDurationMs={turnDurationMs()}
                    working={working()}
                    showReasoningSummaries={showReasoningSummaries()}
                    shellToolDefaultOpen={props.shellToolDefaultOpen}
                    editToolDefaultOpen={props.editToolDefaultOpen}
                    filter={filter()}
                    actions={props.actions}
                  />
                  <Show when={partStatus()}>
                    <div data-slot="session-turn-part-status">{partStatus()}</div>
                  </Show>
                </div>
              </Show>
              <Show when={filter() !== "input" && filter() !== "output" && filter() !== "tool" && showThinking()}>
                <div data-slot="session-turn-thinking">
                  <TextShimmer text={thinking()} />
                </div>
              </Show>
              <Show when={filter() === "all"}>
                <SessionRetry
                  status={status()}
                  show={active()}
                  sessionID={props.sessionID}
                  messageID={props.messageID}
                  actions={props.actions}
                />
              </Show>
              <Show when={error()}>
                <Card variant="error" class="error-card" data-scrollable>
                  {errorText()}
                </Card>
              </Show>
            </div>
          </Show>
          {props.children}
        </div>
      </div>
    </div>
  )
}
