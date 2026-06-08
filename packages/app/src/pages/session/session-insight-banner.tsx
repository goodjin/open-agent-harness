import type { Message } from "@open-agent-harness/sdk/v2/client"
import { Icon } from "@open-agent-harness/ui/icon"
import { IconButton } from "@open-agent-harness/ui/icon-button"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { requestSettingsPanel } from "@/components/dialog-settings"
import { load } from "@/components/settings-agents-helpers"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { useSync } from "@/context/sync"
import { useSessionLayout } from "@/pages/session/session-layout"
import { getSessionContextMetrics } from "@/components/session/session-context-metrics"
import {
  agentName,
  lastAssistant,
  lastUser,
  metaSummary,
  modelName,
  parentLabel,
  short,
  statusName,
  timeAgo,
  totals,
} from "./session-insight-banner-helpers"

const chip = "inline-flex min-w-0 items-center gap-1 rounded-md border border-border-weak-base bg-surface-base px-2 py-1 text-11-medium text-text-base"

const stop = (fn: () => void) => (event: MouseEvent) => {
  event.stopPropagation()
  fn()
}

export function SessionInsightBanner() {
  const global = useGlobalSDK()
  const language = useLanguage()
  const local = useLocal()
  const navigate = useNavigate()
  const sync = useSync()
  const { params } = useSessionLayout()
  const [open, setOpen] = createSignal(false)
  const [agents] = createResource(async () => load(global.client.agent.manage))

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const msgs = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : ([] as Message[])))
  const user = createMemo(() => lastUser(msgs()))
  const assistant = createMemo(() => lastAssistant(msgs()))
  const status = createMemo(() => statusName(params.id ? sync.data.session_status[params.id] : undefined))
  const agent = createMemo(() => agentName({ user: user(), assistant: assistant(), fallback: local.agent.current()?.name }))
  const model = createMemo(() => modelName({ user: user(), assistant: assistant(), providers: sync.data.provider.all }))
  const parent = createMemo(() => sync.data.session.find((item) => item.id === info()?.parentID))
  const usage = createMemo(() => totals(msgs()))
  const context = createMemo(() => getSessionContextMetrics(msgs(), sync.data.provider.all).context)
  const item = createMemo(() => agents()?.find((entry) => entry.id === agent() || entry.name === agent()))
  const meta = createMemo(() => metaSummary(item()?.meta))

  const number = createMemo(() => new Intl.NumberFormat(language.intl(), { notation: "compact", maximumFractionDigits: 1 }))
  const usd = createMemo(() => new Intl.NumberFormat(language.intl(), { style: "currency", currency: "USD" }))
  const date = createMemo(() => new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium", timeStyle: "short" }))

  const token = createMemo(() => {
    const ctx = context()
    if (ctx) return `${number().format(ctx.total)} tokens${ctx.usage === null ? "" : ` / ${ctx.usage}%`}`
    const sum = usage().input + usage().output + usage().reasoning + usage().cache
    return `${number().format(sum)} tokens`
  })

  const openAgent = () => {
    requestSettingsPanel({ defaultTab: "agents", agent: item()?.id ?? agent() })
  }

  const openParent = () => {
    const parentID = info()?.parentID
    if (!params.dir || !parentID) return
    navigate(`/${params.dir}/session/${parentID}`)
  }

  const Row = (props: { label: string; value?: string | number }) => (
    <Show when={props.value !== undefined && props.value !== ""}>
      <div class="flex min-w-0 flex-col gap-1 rounded-md border border-border-weak-base bg-surface-base p-2">
        <span class="text-10-medium uppercase text-text-weaker">{props.label}</span>
        <span class="min-w-0 truncate text-12-medium text-text-strong">{props.value}</span>
      </div>
    </Show>
  )

  return (
    <Show when={info()}>
      {(session) => (
        <div class="border-b border-border-weak-base bg-background-stronger px-3 py-2 md:px-4">
          <div class="flex w-full flex-col gap-2 text-left">
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <span class="min-w-0 truncate text-12-medium text-text-strong">{session().title || short(session().id)}</span>
              <button type="button" class={chip} onClick={stop(openAgent)} title="Open agent details">
                <Icon name="brain" class="size-3 text-icon-weak-base" />
                <span class="truncate">{item()?.name || agent()}</span>
              </button>
              <span class={chip}>{model()}</span>
              <span class={chip}>{status()}</span>
              <span class={chip}>{token()}</span>
              <span class={chip}>{usd().format(usage().cost)}</span>
              <Show when={session().parentID}>
                <button type="button" class={chip} onClick={stop(openParent)} title="Open parent session">
                  <Icon name="arrow-left" class="size-3 text-icon-weak-base" />
                  <span class="truncate">{parentLabel(session(), parent())}</span>
                </button>
              </Show>
              <span class="text-11-regular text-text-weaker">updated {timeAgo(session().time.updated)}</span>
              <IconButton
                icon="chevron-down"
                variant="ghost"
                class="ml-auto size-6 rotate-0 transition-transform"
                classList={{ "rotate-180": open() }}
                onClick={stop(() => setOpen((value) => !value))}
                aria-label={open() ? language.t("session.todo.collapse") : language.t("session.todo.expand")}
                aria-expanded={open()}
              />
            </div>
            <Show when={open()}>
              <div class="grid w-full grid-cols-2 gap-2 pt-1 sm:grid-cols-3 xl:grid-cols-6">
                <Row label="Session" value={short(session().id)} />
                <Row label="Created" value={date().format(session().time.created)} />
                <Row label="Updated" value={date().format(session().time.updated)} />
                <Row label="Agent" value={item()?.name || agent()} />
                <Row label="Model" value={model()} />
                <Row label="Status" value={status()} />
                <Row label="Input" value={number().format(usage().input)} />
                <Row label="Output" value={number().format(usage().output)} />
                <Row label="Reasoning" value={number().format(usage().reasoning)} />
                <Row label="Cache" value={number().format(usage().cache)} />
                <Row label="Cost" value={usd().format(usage().cost)} />
                <Row label="Parent" value={parentLabel(session(), parent())} />
                <For each={meta()}>{(entry) => <Row label="Metadata" value={entry} />}</For>
              </div>
            </Show>
          </div>
        </div>
      )}
    </Show>
  )
}
