import { For, Show, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@open-agent-harness/ui/button"
import { DockPrompt } from "@open-agent-harness/ui/dock-prompt"
import { Icon } from "@open-agent-harness/ui/icon"
import { showToast } from "@open-agent-harness/ui/toast"
import type { QuestionAnswer, QuestionRequest } from "@open-agent-harness/sdk/v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

type Notes = Record<string, string>

const cache = new Map<string, { tab: number; answers: QuestionAnswer[]; custom: string[]; customOn: boolean[]; notes: Record<number, Notes> }>()

const OPTION_DESCRIPTION_LIMIT = 140

type DescriptionView = { text: string; hidden: number }

export function limitDescription(text: string, limit: number = OPTION_DESCRIPTION_LIMIT): DescriptionView {
  if (!text) return { text: "", hidden: 0 }
  if (text.length <= limit) return { text, hidden: 0 }
  return { text: text.slice(0, limit), hidden: text.length - limit }
}

export function answersWithNotes(answers: QuestionAnswer, notes: Notes): QuestionAnswer {
  return answers.map((item) => {
    const note = (notes[item] ?? "").trim()
    if (!note) return item
    return `${item}: ${note}`
  })
}

export const SessionQuestionDock: Component<{ request: QuestionRequest; onSubmit: () => void }> = (props) => {
  const sdk = useSDK()
  const language = useLanguage()

  const questions = createMemo(() => props.request.questions)
  const total = createMemo(() => questions().length)

  const cached = cache.get(props.request.id)
  const [store, setStore] = createStore({
    tab: cached?.tab ?? 0,
    answers: cached?.answers ?? ([] as QuestionAnswer[]),
    custom: cached?.custom ?? ([] as string[]),
    customOn: cached?.customOn ?? ([] as boolean[]),
    notes: cached?.notes ?? ({} as Record<number, Notes>),
    editing: false,
    sending: false,
  })

  let root: HTMLDivElement | undefined
  let replied = false

  const question = createMemo(() => questions()[store.tab])
  const options = createMemo(() => question()?.options ?? [])
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const on = createMemo(() => store.customOn[store.tab] === true)
  const multi = createMemo(() => question()?.multiple === true)
  const custom = createMemo(() => question()?.custom !== false)

  const summary = createMemo(() => {
    const n = Math.min(store.tab + 1, total())
    return language.t("session.question.progress", { current: n, total: total() })
  })

  const last = createMemo(() => store.tab >= total() - 1)

  const customUpdate = (value: string, selected: boolean = on()) => {
    const prev = input().trim()
    const next = value.trim()

    setStore("custom", store.tab, value)
    if (!selected) return

    if (multi()) {
      setStore("answers", store.tab, (current = []) => {
        const removed = prev ? current.filter((item) => item.trim() !== prev) : current
        if (!next) return removed
        if (removed.some((item) => item.trim() === next)) return removed
        return [...removed, next]
      })
      return
    }

    setStore("answers", store.tab, next ? [next] : [])
  }

  const measure = () => {
    if (!root) return

    const scroller = document.querySelector(".scroll-view__viewport")
    const head = scroller instanceof HTMLElement ? scroller.firstElementChild : undefined
    const top =
      head instanceof HTMLElement && head.classList.contains("sticky") ? head.getBoundingClientRect().bottom : 0
    if (!top) {
      root.style.removeProperty("--question-prompt-max-height")
      return
    }

    const dock = root.closest('[data-component="session-prompt-dock"]')
    if (!(dock instanceof HTMLElement)) return

    const dockBottom = dock.getBoundingClientRect().bottom
    const below = Math.max(0, dockBottom - root.getBoundingClientRect().bottom)
    const gap = 8
    const max = Math.max(240, Math.floor(dockBottom - top - gap - below))
    root.style.setProperty("--question-prompt-max-height", `${max}px`)
  }

  onMount(() => {
    let raf: number | undefined
    const update = () => {
      if (raf !== undefined) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = undefined
        measure()
      })
    }

    update()
    window.addEventListener("resize", update)

    const dock = root?.closest('[data-component="session-prompt-dock"]')
    const scroller = document.querySelector(".scroll-view__viewport")
    const observer = new ResizeObserver(update)
    if (dock instanceof HTMLElement) observer.observe(dock)
    if (scroller instanceof HTMLElement) observer.observe(scroller)

    onCleanup(() => {
      window.removeEventListener("resize", update)
      observer.disconnect()
      if (raf !== undefined) cancelAnimationFrame(raf)
    })
  })

  onCleanup(() => {
    if (replied) return
    cache.set(props.request.id, {
      tab: store.tab,
      answers: store.answers.map((a) => (a ? [...a] : [])),
      custom: store.custom.map((s) => s ?? ""),
      customOn: store.customOn.map((b) => b ?? false),
      notes: store.notes,
    })
  })

  const fail = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    showToast({ title: language.t("common.requestFailed"), description: message })
  }

  const reply = async (answers: QuestionAnswer[]) => {
    if (store.sending) return

    props.onSubmit()
    setStore("sending", true)
    try {
      await sdk.client.question.reply({ requestID: props.request.id, answers })
      replied = true
      cache.delete(props.request.id)
    } catch (err) {
      fail(err)
    } finally {
      setStore("sending", false)
    }
  }

  const reject = async () => {
    if (store.sending) return

    props.onSubmit()
    setStore("sending", true)
    try {
      await sdk.client.question.reject({ requestID: props.request.id })
      replied = true
      cache.delete(props.request.id)
    } catch (err) {
      fail(err)
    } finally {
      setStore("sending", false)
    }
  }

  const submit = () => void reply(questions().map((_, i) => answersWithNotes(store.answers[i] ?? [], store.notes[i] ?? {})))

  const pick = (answer: string, custom: boolean = false) => {
    setStore("answers", store.tab, [answer])
    if (custom) setStore("custom", store.tab, answer)
    if (!custom) setStore("customOn", store.tab, false)
    setStore("editing", false)
  }

  const toggle = (answer: string) => {
    setStore("answers", store.tab, (current = []) => {
      if (current.includes(answer)) return current.filter((item) => item !== answer)
      return [...current, answer]
    })
  }

  const note = (answer: string) => store.notes[store.tab]?.[answer] ?? ""

  const noteUpdate = (answer: string, value: string) => {
    setStore("notes", store.tab, answer, value)
  }

  const customToggle = () => {
    if (store.sending) return

    if (!multi()) {
      setStore("customOn", store.tab, true)
      setStore("editing", true)
      customUpdate(input(), true)
      return
    }

    const next = !on()
    setStore("customOn", store.tab, next)
    if (next) {
      setStore("editing", true)
      customUpdate(input(), true)
      return
    }

    const value = input().trim()
    if (value) setStore("answers", store.tab, (current = []) => current.filter((item) => item.trim() !== value))
    setStore("editing", false)
  }

  const customOpen = () => {
    if (store.sending) return
    if (!on()) setStore("customOn", store.tab, true)
    setStore("editing", true)
    customUpdate(input(), true)
  }

  const selectOption = (optIndex: number) => {
    if (store.sending) return

    if (optIndex === options().length) {
      customOpen()
      return
    }

    const opt = options()[optIndex]
    if (!opt) return
    if (multi()) {
      toggle(opt.label)
      return
    }
    pick(opt.label)
  }

  const commitCustom = () => {
    setStore("editing", false)
    customUpdate(input())
  }

  const next = () => {
    if (store.sending) return
    if (store.editing) commitCustom()

    if (store.tab >= total() - 1) {
      submit()
      return
    }

    setStore("tab", store.tab + 1)
    setStore("editing", false)
  }

  const back = () => {
    if (store.sending) return
    if (store.tab <= 0) return
    setStore("tab", store.tab - 1)
    setStore("editing", false)
  }

  const jump = (tab: number) => {
    if (store.sending) return
    setStore("tab", tab)
    setStore("editing", false)
  }

  return (
    <DockPrompt
      kind="question"
      ref={(el) => (root = el)}
      header={
        <>
          <div data-slot="question-header-title">{summary()}</div>
          <div data-slot="question-progress">
            <For each={questions()}>
              {(_, i) => (
                <button
                  type="button"
                  data-slot="question-progress-segment"
                  data-active={i() === store.tab}
                  data-answered={
                    (store.answers[i()]?.length ?? 0) > 0 ||
                    (store.customOn[i()] === true && (store.custom[i()] ?? "").trim().length > 0)
                  }
                  disabled={store.sending}
                  onClick={() => jump(i())}
                  aria-label={`${language.t("ui.tool.questions")} ${i() + 1}`}
                />
              )}
            </For>
          </div>
        </>
      }
      footer={
        <>
          <Button variant="ghost" size="large" disabled={store.sending} onClick={reject}>
            {language.t("ui.common.dismiss")}
          </Button>
          <div data-slot="question-footer-actions">
            <Show when={store.tab > 0}>
              <Button variant="secondary" size="large" disabled={store.sending} onClick={back}>
                {language.t("ui.common.back")}
              </Button>
            </Show>
            <Button variant={last() ? "primary" : "secondary"} size="large" disabled={store.sending} onClick={next}>
              {last() ? language.t("ui.common.submit") : language.t("ui.common.next")}
            </Button>
          </div>
        </>
      }
    >
      <div data-slot="question-text">{question()?.question}</div>
      <Show when={multi()} fallback={<div data-slot="question-hint">{language.t("ui.question.singleHint")}</div>}>
        <div data-slot="question-hint">{language.t("ui.question.multiHint")}</div>
      </Show>
      <div data-slot="question-options">
        <For each={options()}>
          {(opt, i) => {
            const picked = () => store.answers[store.tab]?.includes(opt.label) ?? false
            const [descriptionOpen, setDescriptionOpen] = createSignal(false)
            const descriptionView = createMemo(() => limitDescription(opt.description ?? ""))
            const descriptionText = createMemo(() => (descriptionOpen() ? opt.description ?? "" : descriptionView().text))
            const descriptionCanExpand = createMemo(() => descriptionView().hidden > 0)
            const toggleDescription = (e: MouseEvent) => {
              e.preventDefault()
              e.stopPropagation()
              setDescriptionOpen(!descriptionOpen())
            }
            return (
              <div data-slot="question-option-item" data-picked={picked()}>
                <button
                  data-slot="question-option"
                  data-picked={picked()}
                  role={multi() ? "checkbox" : "radio"}
                  aria-checked={picked()}
                  disabled={store.sending}
                  onClick={() => selectOption(i())}
                >
                  <span data-slot="question-option-check" aria-hidden="true">
                    <span
                      data-slot="question-option-box"
                      data-type={multi() ? "checkbox" : "radio"}
                      data-picked={picked()}
                    >
                      <Show when={multi()} fallback={<span data-slot="question-option-radio-dot" />}>
                        <Icon name="check-small" size="small" />
                      </Show>
                    </span>
                  </span>
                  <span data-slot="question-option-main">
                    <span data-slot="option-label">{opt.label}</span>
                    <Show when={opt.description}>
                      <span data-slot="option-description" data-truncated={descriptionView().hidden > 0 && !descriptionOpen()}>
                        {descriptionText()}
                      </span>
                    </Show>
                  </span>
                </button>
                <Show when={descriptionCanExpand()}>
                  <button
                    type="button"
                    data-slot="option-description-toggle"
                    data-expanded={descriptionOpen()}
                    aria-expanded={descriptionOpen()}
                    onClick={toggleDescription}
                  >
                    {descriptionOpen()
                      ? language.t("ui.question.optionDescription.showLess")
                      : language.t("ui.question.optionDescription.showMore")}
                  </button>
                </Show>
                <Show when={picked()}>
                  <textarea
                    data-slot="question-option-note"
                    placeholder={language.t("ui.question.optionNote.placeholder")}
                    value={note(opt.label)}
                    rows={1}
                    disabled={store.sending}
                    onInput={(e) => {
                      noteUpdate(opt.label, e.currentTarget.value)
                      e.currentTarget.style.height = "0px"
                      e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`
                    }}
                  />
                </Show>
              </div>
            )
          }}
        </For>

        <Show when={custom()}>
          <Show
            when={store.editing}
            fallback={
              <button
                data-slot="question-option"
                data-custom="true"
                data-picked={on()}
                role={multi() ? "checkbox" : "radio"}
                aria-checked={on()}
                disabled={store.sending}
                onClick={customOpen}
              >
                <span
                  data-slot="question-option-check"
                  aria-hidden="true"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    customToggle()
                  }}
                >
                  <span data-slot="question-option-box" data-type={multi() ? "checkbox" : "radio"} data-picked={on()}>
                    <Show when={multi()} fallback={<span data-slot="question-option-radio-dot" />}>
                      <Icon name="check-small" size="small" />
                    </Show>
                  </span>
                </span>
                <span data-slot="question-option-main">
                  <span data-slot="option-label">{language.t("ui.messagePart.option.typeOwnAnswer")}</span>
                  <span data-slot="option-description">{input() || language.t("ui.question.custom.placeholder")}</span>
                </span>
              </button>
            }
          >
            <form
              data-slot="question-option"
              data-custom="true"
              data-picked={on()}
              role={multi() ? "checkbox" : "radio"}
              aria-checked={on()}
              onMouseDown={(e) => {
                if (store.sending) {
                  e.preventDefault()
                  return
                }
                if (e.target instanceof HTMLTextAreaElement) return
                const input = e.currentTarget.querySelector('[data-slot="question-custom-input"]')
                if (input instanceof HTMLTextAreaElement) input.focus()
              }}
              onSubmit={(e) => {
                e.preventDefault()
                commitCustom()
              }}
            >
              <span
                data-slot="question-option-check"
                aria-hidden="true"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  customToggle()
                }}
              >
                <span data-slot="question-option-box" data-type={multi() ? "checkbox" : "radio"} data-picked={on()}>
                  <Show when={multi()} fallback={<span data-slot="question-option-radio-dot" />}>
                    <Icon name="check-small" size="small" />
                  </Show>
                </span>
              </span>
              <span data-slot="question-option-main">
                <span data-slot="option-label">{language.t("ui.messagePart.option.typeOwnAnswer")}</span>
                <textarea
                  ref={(el) =>
                    setTimeout(() => {
                      el.focus()
                      el.style.height = "0px"
                      el.style.height = `${el.scrollHeight}px`
                    }, 0)
                  }
                  data-slot="question-custom-input"
                  placeholder={language.t("ui.question.custom.placeholder")}
                  value={input()}
                  rows={1}
                  disabled={store.sending}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault()
                      setStore("editing", false)
                      return
                    }
                    if (e.key !== "Enter" || e.shiftKey) return
                    e.preventDefault()
                    commitCustom()
                  }}
                  onInput={(e) => {
                    customUpdate(e.currentTarget.value)
                    e.currentTarget.style.height = "0px"
                    e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`
                  }}
                />
              </span>
            </form>
          </Show>
        </Show>
      </div>
    </DockPrompt>
  )
}
