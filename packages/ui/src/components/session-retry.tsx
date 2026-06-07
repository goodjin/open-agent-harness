import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import type { SessionStatus } from "@open-agent-harness/sdk/v2/client"
import { useI18n } from "../context/i18n"
import { Card } from "./card"
import { Tooltip } from "./tooltip"
import { Spinner } from "./spinner"

export function SessionRetry(props: { status: SessionStatus; show?: boolean }) {
  const i18n = useI18n()
  const limited = createMemo(() => {
    if (props.status.type !== "rate_limited") return
    return props.status
  })
  const retry = createMemo(() => {
    if (props.status.type !== "retry") return
    return props.status
  })
  const [seconds, setSeconds] = createSignal(0)
  createEffect(
    on(retry, (current) => {
      if (!current) return
      const update = () => {
        const next = retry()?.next
        if (!next) return
        setSeconds(Math.round((next - Date.now()) / 1000))
      }
      update()
      const timer = setInterval(update, 1000)
      onCleanup(() => clearInterval(timer))
    }),
  )
  const message = createMemo(() => {
    const current = retry()
    if (!current) return ""
    if (current.message.includes("exceeded your current quota") && current.message.includes("gemini")) {
      return i18n.t("ui.sessionTurn.retry.geminiHot")
    }
    if (current.message.length > 80) return current.message.slice(0, 80) + "..."
    return current.message
  })
  const truncated = createMemo(() => {
    const current = retry()
    if (!current) return false
    return current.message.length > 80
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

  return (
    <Show when={(retry() || limited()) && (props.show ?? true)} keyed>
      <div data-slot="session-turn-retry">
        <Card variant={retry() ? "error" : "normal"} class="error-card">
          <div class="flex items-start gap-2">
            <Spinner class="size-4 mt-0.5" />
            <div class="min-w-0">
              <Show
                when={limited()}
                fallback={
                  <Show when={truncated()} fallback={<div data-slot="session-turn-retry-message">{message()}</div>}>
                    <Tooltip value={retry()?.message ?? ""} placement="top">
                      <div data-slot="session-turn-retry-message" class="cursor-help truncate">
                        {message()}
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
                  <Show when={info()}>{(line) => <div data-slot="session-turn-retry-info">{line()}</div>}</Show>
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
            </div>
          </div>
        </Card>
      </div>
    </Show>
  )
}
