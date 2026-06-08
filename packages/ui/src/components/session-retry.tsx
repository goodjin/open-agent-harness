import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import type { SessionStatus } from "@open-agent-harness/sdk/v2/client"
import { useI18n } from "../context/i18n"
import type { UserActions } from "./message-part"
import { Card } from "./card"
import { Tooltip } from "./tooltip"
import { Spinner } from "./spinner"

type Props = {
  status: SessionStatus
  show?: boolean
  sessionID: string
  messageID: string
  actions?: UserActions
}

export function SessionRetry(props: Props) {
const i18n = useI18n()
const limited = createMemo(() => {
  if (props.status.type !== "rate_limited") return
  return props.status
})
  const retry = createMemo(() => {
    if (props.status.type !== "retry") return
    return props.status
  })
  const failed = createMemo(() => props.status.type === "error" || props.status.type === "timeout")
  const [note, setNote] = createSignal("")
  const [open, setOpen] = createSignal(false)
  const [busy, setBusy] = createSignal<"retry" | "continue" | undefined>()
  const [seconds, setSeconds] = createSignal(0)

  createEffect(
    on(
      () => retry(),
      (current) => {
        if (!current) return
        const update = () => {
          const next = retry()?.next
          if (!next) return
          setSeconds(Math.round((next - Date.now()) / 1000))
        }
        update()
        const timer = setInterval(update, 1000)
        onCleanup(() => clearInterval(timer))
      },
    ),
  )
  const message = createMemo(() => {
    if (retry()) return retry()?.message ?? ""
    if (!failed()) return ""
    if ("message" in props.status) return props.status.message
    return ""
  })
  const truncated = createMemo(() => {
    const current = message()
    if (!current) return false
    return current.length > 80
  })
  const info = createMemo(() => {
    const current = retry()
    if (!current) return ""
    const count = Math.max(0, seconds())
    const delay = count > 0 ? i18n.t("ui.sessionTurn.retry.inSeconds", { seconds: count }) : ""
    const retrying = i18n.t("ui.sessionTurn.retry.retrying")
    const line = [retrying, delay].filter(Boolean).join(" ")
    if (!line) return i18n.t("ui.sessionTurn.retry.attempt", { attempt: current.attempt })
    return i18n.t("ui.sessionTurn.retry.attemptLine", { line, attempt: current.attempt })
  })
  const statusMessage = createMemo(() => {
    const value = message()
    if (typeof value !== "string") return ""
    if (value.length <= 160) return value
    return `${value.slice(0, 160)}...`
  })

  const canRetry = () => !busy() && !!props.actions?.retry
  const canContinue = () => !busy() && !!props.actions?.continue

  const runRetry = () => {
    if (!canRetry()) return
    setBusy("retry")
    const next = props.actions?.retry
    if (!next) return
    Promise.resolve()
      .then(() =>
        next({
          sessionID: props.sessionID,
          messageID: props.messageID,
        }),
      )
      .finally(() => {
        if (busy() === "retry") setBusy(undefined)
      })
  }

  const runContinue = () => {
    const input = note().trim()
    if (!props.actions?.continue || !canContinue()) return
    if (!input) return
    setBusy("continue")
    setOpen(false)
    Promise.resolve()
      .then(() =>
        props.actions?.continue?.({
          sessionID: props.sessionID,
          messageID: props.messageID,
          text: input,
        }),
      )
      .finally(() => {
        if (busy() === "continue") setBusy(undefined)
      })
    setNote("")
  }

  return (
    <Show when={(retry() || limited() || failed()) && (props.show ?? true)} keyed>
      <div data-component="session-retry-card">
        <Card variant={retry() ? "error" : "normal"} class="error-card">
          <div class="flex items-start gap-2">
            <Spinner class="size-4 mt-0.5" />
            <div class="min-w-0">
              <Show
                when={limited()}
                fallback={
                  <Show when={truncated()} fallback={<div data-slot="session-turn-retry-message">{statusMessage()}</div>}>
                    <Tooltip value={message()} placement="top">
                      <div data-slot="session-turn-retry-message" class="cursor-help truncate">
                        {statusMessage()}
                      </div>
                    </Tooltip>
                  </Show>
                }
              >
                {(item) => (
                  <div data-slot="session-turn-retry-message">
                    {i18n.t("ui.sessionTurn.rateLimited.message", {
                      provider: item().providerID,
                      model: item().modelID,
                      scope: item().scope,
                    })}
                  </div>
                )}
              </Show>
              <Show
                when={limited()}
                fallback={
                  <Show when={info()}>
                    {(line) => <div data-slot="session-turn-retry-info">{line()}</div>}
                  </Show>
                }
              >
                {(item) => (
                  <div data-slot="session-turn-retry-info">
                    {i18n.t("ui.sessionTurn.rateLimited.info", {
                      active: item().active,
                      limit: item().limit,
                      queued: item().queued,
                    })}
                  </div>
                )}
              </Show>
              <Show when={failed()}>
                <div class="mt-2 flex gap-2 flex-wrap">
                  <button
                    type="button"
                    class="rounded-md border border-border-strong-base bg-surface-weak px-2.5 py-1 text-12-medium hover:bg-surface-raised-base-hover disabled:opacity-50"
                    onClick={runRetry}
                    disabled={!canRetry()}
                  >
                    重试
                  </button>
                  <button
                    type="button"
                    class="rounded-md border border-border-strong-base bg-surface-weak px-2.5 py-1 text-12-medium hover:bg-surface-raised-base-hover disabled:opacity-50"
                    onClick={() => setOpen((value) => !value)}
                    disabled={!canContinue()}
                  >
                    {open() ? "收起" : "继续"}
                  </button>
                </div>
              </Show>
              <Show when={open()}>
                <div class="mt-2 flex flex-col gap-2">
                  <textarea
                    value={note()}
                    onInput={(event) => setNote(event.currentTarget.value)}
                    placeholder="可输入补充说明后继续"
                    class="min-h-20 w-full resize-y rounded-md border border-border-strong-base bg-surface-weak p-2 text-12-regular outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  />
                  <div class="flex justify-end">
                    <button
                      type="button"
                      class="rounded-md border border-border-strong-base bg-surface-weak px-2.5 py-1 text-12-medium hover:bg-surface-raised-base-hover disabled:opacity-50"
                      onClick={runContinue}
                      disabled={!canContinue() || !note().trim()}
                    >
                      发送继续
                    </button>
                  </div>
                </div>
              </Show>
            </div>
          </div>
        </Card>
      </div>
    </Show>
  )
}
