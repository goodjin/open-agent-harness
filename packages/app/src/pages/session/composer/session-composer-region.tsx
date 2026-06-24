import { For, Show, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@open-agent-harness/ui/button"
import { Icon } from "@open-agent-harness/ui/icon"
import { useSpring } from "@open-agent-harness/ui/motion-spring"
import { PromptInput } from "@/components/prompt-input"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import type { SessionResumePrompt } from "@/pages/session/helpers"
import { getSessionHandoff, setSessionHandoff } from "@/pages/session/handoff"
import { useSessionKey } from "@/pages/session/session-layout"
import { SessionFollowupDock } from "@/pages/session/composer/session-followup-dock"
import { SessionRevertDock } from "@/pages/session/composer/session-revert-dock"
import type { SessionComposerState } from "@/pages/session/composer/session-composer-state"
import { SessionTodoDock } from "@/pages/session/composer/session-todo-dock"
import type { FollowupDraft } from "@/components/prompt-input/submit"

export function SessionComposerRegion(props: {
  state: SessionComposerState
  ready: boolean
  centered: boolean
  inputRef: (el: HTMLDivElement) => void
  newSessionWorktree: string
  onNewSessionWorktreeReset: () => void
  onSubmit: () => void
  followup?: {
    queue: () => boolean
    items: { id: string; text: string }[]
    target?: string
    sending?: string
    edit?: { id: string; prompt: FollowupDraft["prompt"]; context: FollowupDraft["context"] }
    onQueue: (draft: FollowupDraft) => void
    onAbort: () => void
    onSend: (id: string) => void
    onEdit: (id: string) => void
    onEditLoaded: () => void
  }
  revert?: {
    items: { id: string; text: string }[]
    restoring?: string
    disabled?: boolean
    onRestore: (id: string) => void
  }
  resume?: {
    prompt: SessionResumePrompt
    busy: boolean
    onResume: () => void
  }
  setPromptDockRef: (el: HTMLDivElement) => void
}) {
  const prompt = usePrompt()
  const language = useLanguage()
  const route = useSessionKey()

  const handoffPrompt = createMemo(() => getSessionHandoff(route.sessionKey())?.prompt)

  const previewPrompt = () =>
    prompt
      .current()
      .map((part) => {
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        if (part.type === "image") return `[image:${part.filename}]`
        return part.content
      })
      .join("")
      .trim()

  createEffect(() => {
    if (!prompt.ready()) return
    setSessionHandoff(route.sessionKey(), { prompt: previewPrompt() })
  })

  const [store, setStore] = createStore({
    ready: false,
    height: 320,
    body: undefined as HTMLDivElement | undefined,
  })
  let timer: number | undefined
  let frame: number | undefined

  const clear = () => {
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
    }
    if (frame !== undefined) {
      cancelAnimationFrame(frame)
      frame = undefined
    }
  }

  createEffect(() => {
    route.sessionKey()
    const ready = props.ready
    const delay = 140

    clear()
    setStore("ready", false)
    if (!ready) return

    frame = requestAnimationFrame(() => {
      frame = undefined
      timer = window.setTimeout(() => {
        setStore("ready", true)
        timer = undefined
      }, delay)
    })
  })

  onCleanup(clear)

  const open = createMemo(() => store.ready && props.state.dock() && !props.state.closing())
  const progress = useSpring(() => (open() ? 1 : 0), { visualDuration: 0.3, bounce: 0 })
  const value = createMemo(() => Math.max(0, Math.min(1, progress())))
  const dock = createMemo(() => (store.ready && props.state.dock()) || value() > 0.001)
  const rolled = createMemo(() => (props.revert?.items.length ? props.revert : undefined))
  const lift = createMemo(() => (rolled() ? 18 : 36 * value()))
  const full = createMemo(() => Math.max(78, store.height))

  createEffect(() => {
    const el = store.body
    if (!el) return
    const update = () => {
      setStore("height", el.getBoundingClientRect().height)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    onCleanup(() => observer.disconnect())
  })

  return (
    <div
      ref={props.setPromptDockRef}
      data-component="session-prompt-dock"
      class="shrink-0 w-full pb-3 flex flex-col justify-center items-center bg-background-stronger pointer-events-none"
    >
      <div
        classList={{
          "w-full px-3 pointer-events-auto": true,
          "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered,
        }}
      >
        <Show
          when={prompt.ready()}
          fallback={
            <>
              <Show when={rolled()} keyed>
                {(revert) => (
                  <div class="pb-2">
                    <SessionRevertDock
                      items={revert.items}
                      restoring={revert.restoring}
                      disabled={revert.disabled}
                      onRestore={revert.onRestore}
                    />
                  </div>
                )}
              </Show>
              <div class="w-full min-h-32 md:min-h-40 rounded-md border border-border-weak-base bg-background-base/50 px-4 py-3 text-text-weak whitespace-pre-wrap pointer-events-none">
                {handoffPrompt() || language.t("prompt.loading")}
              </div>
            </>
          }
        >
          <Show when={dock()}>
            <div
              classList={{
                "overflow-hidden": true,
                "pointer-events-none": value() < 0.98,
              }}
              style={{
                "max-height": `${full() * value()}px`,
              }}
            >
              <div ref={(el) => setStore("body", el)}>
                <SessionTodoDock
                  sessionID={route.params.id}
                  todos={props.state.todos()}
                  collapseLabel={language.t("session.todo.collapse")}
                  expandLabel={language.t("session.todo.expand")}
                  dockProgress={value()}
                />
              </div>
            </div>
          </Show>
          <Show when={rolled()} keyed>
            {(revert) => (
              <div
                style={{
                  "margin-top": `${-36 * value()}px`,
                }}
              >
                <SessionRevertDock
                  items={revert.items}
                  restoring={revert.restoring}
                  disabled={revert.disabled}
                  onRestore={revert.onRestore}
                />
              </div>
            )}
          </Show>
          <div
            classList={{
              "relative z-10": true,
            }}
            style={{
              "margin-top": `${-lift()}px`,
            }}
          >
            <Show when={props.followup?.items.length}>
              <SessionFollowupDock
                items={props.followup!.items}
                target={props.followup!.target}
                sending={props.followup!.sending}
                onSend={props.followup!.onSend}
                onEdit={props.followup!.onEdit}
              />
            </Show>
            <Show when={props.resume} keyed>
              {(resume) => (
                <div
                  data-component="session-resume-prompt"
                  class="mb-2 flex min-h-10 items-center gap-3 rounded-md border border-icon-warning-base/40 bg-background-base px-3 py-2 text-left shadow-xs"
                >
                  <Icon name="warning" size="small" class="shrink-0 text-icon-warning-base" />
                  <div class="min-w-0 flex-1">
                    <div class="text-12-medium text-text-strong">{resume.prompt.label}</div>
                    <div class="truncate text-12-regular text-text-weak">{resume.prompt.description}</div>
                  </div>
                  <Button
                    variant="secondary"
                    size="small"
                    class="h-7 shrink-0 px-2"
                    disabled={resume.busy}
                    onClick={resume.onResume}
                  >
                    {resume.prompt.action}
                  </Button>
                </div>
              )}
            </Show>
            <Show when={props.state.liveStatus()} keyed>
              {(status) => (
                <div
                  data-component="session-live-status"
                  class="mb-2 flex min-h-8 items-center gap-2 rounded-md border bg-background-base px-3 py-2 text-left shadow-xs"
                  classList={{
                    "border-icon-info-base/30": status.tone === "info",
                    "border-icon-warning-base/40": status.tone === "warning",
                    "border-icon-critical-base/40": status.tone === "danger",
                    "border-icon-success-base/40": status.tone === "success",
                  }}
                >
                  <span
                    class="h-2 w-2 shrink-0 rounded-full"
                    classList={{
                      "bg-icon-info-base": status.tone === "info",
                      "bg-icon-warning-base": status.tone === "warning",
                      "bg-icon-critical-base": status.tone === "danger",
                      "bg-icon-success-base": status.tone === "success",
                    }}
                    aria-hidden="true"
                  />
                  <div class="min-w-0 flex flex-1 flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span class="shrink-0 text-12-medium text-text-strong">{status.label}</span>
                    <span class="min-w-0 flex-1 truncate text-12-regular text-text-weak">{status.description}</span>
                    <Show when={status.metrics?.length}>
                      <div class="flex shrink-0 flex-wrap items-center gap-1">
                        <For each={status.metrics}>
                          {(item) => (
                            <span class="rounded border border-border-weak-base bg-background-strong px-1.5 py-0.5 text-11-medium text-text-weak">
                              {item}
                            </span>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </div>
              )}
            </Show>
            <PromptInput
              ref={props.inputRef}
              newSessionWorktree={props.newSessionWorktree}
              onNewSessionWorktreeReset={props.onNewSessionWorktreeReset}
              edit={props.followup?.edit}
              onEditLoaded={props.followup?.onEditLoaded}
              shouldQueue={props.followup?.queue}
              onQueue={props.followup?.onQueue}
              onAbort={props.followup?.onAbort}
              onSubmit={props.onSubmit}
            />
          </div>
        </Show>
      </div>
    </div>
  )
}
