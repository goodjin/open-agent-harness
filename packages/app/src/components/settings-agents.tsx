import { Button } from "@open-agent-harness/ui/button"
import { Icon } from "@open-agent-harness/ui/icon"
import { Switch } from "@open-agent-harness/ui/switch"
import { Tag } from "@open-agent-harness/ui/tag"
import { TextField } from "@open-agent-harness/ui/text-field"
import { showToast } from "@open-agent-harness/ui/toast"
import { Tabs } from "@open-agent-harness/ui/tabs"
import type { AgentManageDiagnostic, AgentManageInfo } from "@open-agent-harness/sdk/v2"
import { createEffect, createResource, For, Show, type Component, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { SettingsList } from "./settings-list"
import {
  blank,
  costs,
  fill,
  json,
  load,
  message,
  modes,
  overview,
  perms,
  runners,
  save as saveAgent,
  scopes,
  summary,
  tabs,
  toggle as toggleAgent,
  typed,
  versions,
  type Cost,
  type Form,
  type Mode,
  type Perm,
  type Runner,
  type Scope,
  type Tab,
  type View,
} from "./settings-agents-helpers"

const SelectField: Component<{
  label: string
  value: string
  options: string[]
  onChange: (value: string) => void
  disabled?: boolean
  inline?: boolean
}> = (props) => (
  <label
    class="flex gap-1 text-12-medium text-text-weak"
    classList={{
      "flex-col": !props.inline,
      "flex-row items-center gap-2": props.inline,
    }}
  >
    <span class="shrink-0">{props.label}</span>
    <select
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.currentTarget.value)}
      class="h-8 rounded-md border border-border-base bg-surface-base px-2 text-13-regular text-text-strong"
      classList={{ "min-w-28": props.inline }}
    >
      <For each={props.options}>{(item) => <option value={item}>{item}</option>}</For>
    </select>
  </label>
)

const Check: Component<{ label: string; checked: boolean; onChange: (value: boolean) => void }> = (props) => (
  <div class="flex items-center justify-between gap-3 rounded-md border border-border-weak-base px-3 py-2">
    <span class="text-13-regular text-text-strong">{props.label}</span>
    <Switch checked={props.checked} onChange={props.onChange} hideLabel>
      {props.label}
    </Switch>
  </div>
)

const Field: Component<{
  label: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  multiline?: boolean
  class?: string
}> = (props) => (
  <TextField
    label={props.label}
    value={props.value}
    onChange={props.onChange}
    disabled={props.disabled}
    multiline={props.multiline}
    class={props.class}
  />
)

const Section: Component<{ title: string; children: JSX.Element }> = (props) => (
  <div class="flex flex-col gap-3">
    <h3 class="text-14-medium text-text-strong">{props.title}</h3>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">{props.children}</div>
  </div>
)

const Logo: Component<{ name: string; uri?: string; alt?: string }> = (props) => (
  <Show
    when={props.uri}
    fallback={
      <div class="flex size-9 shrink-0 items-center justify-center rounded-md border border-border-weak-base bg-surface-strong text-13-medium text-text-weak">
        {(props.name.trim()[0] ?? "?").toUpperCase()}
      </div>
    }
  >
    {(uri) => (
      <img
        src={uri()}
        alt={props.alt ?? props.name}
        class="size-9 shrink-0 rounded-md border border-border-weak-base bg-surface-strong object-cover"
      />
    )}
  </Show>
)

const source = (item: AgentManageInfo) => {
  if (item.source === "builtin") return "Source: built-in"
  return `Source: ${item.source}`
}

export const SettingsAgents: Component<{ selected?: string }> = (props) => {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const [view, setView] = createStore<{
    page: "list" | "form"
    mode: View
    selected: string
    saving: boolean
    state: string
    tab: Tab
    diagnostics: AgentManageDiagnostic[]
    opened: boolean
  }>({
    page: "list",
    mode: "edit",
    selected: "",
    saving: false,
    state: "",
    tab: "all",
    diagnostics: [],
    opened: false,
  })
  const [form, setForm] = createStore<Form>(blank())

  const [agents, actions] = createResource(async () => load(globalSDK.client.agent.manage))

  const current = () => agents()?.find((item) => item.id === view.selected)

  const select = (item: AgentManageInfo) => {
    setView("page", "form")
    setView("mode", "edit")
    setView("selected", item.id)
    setView("diagnostics", item.diagnostics)
    setForm(fill(item))
  }

  createEffect(() => {
    if (view.opened) return
    const id = props.selected
    if (!id) return
    const item = agents()?.find((entry) => entry.id === id || entry.name === id)
    if (!item) return
    setView("opened", true)
    select(item)
  })

  const create = () => {
    setView("page", "form")
    setView("mode", "create")
    setView("selected", "")
    setView("diagnostics", [])
    setForm(blank())
  }

  const back = () => setView("page", "list")

  const refresh = async () => {
    await actions.refetch()
  }

  const invalid = (diag: AgentManageDiagnostic[]) => {
    setView("diagnostics", diag)
    showToast({
      title: "Agent validation failed",
      description: diag.map((item) => item.message).join("\n") || language.t("common.requestFailed"),
    })
  }

  const save = async () => {
    setView("saving", true)
    await saveAgent(globalSDK.client.agent.manage, form, view.mode)
      .then(async (out) => {
        if (!out.ok) {
          invalid(out.diagnostics)
          return
        }
        setView("mode", "edit")
        setView("selected", out.id)
        setView("diagnostics", [])
        await refresh()
        showToast({ variant: "success", icon: "circle-check", title: "Agent saved" })
      })
      .catch((e: unknown) => {
        showToast({ title: language.t("common.requestFailed"), description: message(e) })
      })
      .finally(() => setView("saving", false))
  }

  const toggle = async (item: AgentManageInfo) => {
    setView("state", item.id)
    await toggleAgent(globalSDK.client.agent.manage, item)
      .then(async () => {
        await refresh()
        showToast({
          variant: "success",
          icon: "circle-check",
          title: `${item.name} ${item.disabled ? "enabled" : "disabled"}`,
        })
      })
      .catch((e: unknown) => {
        showToast({ title: language.t("common.requestFailed"), description: message(e) })
      })
      .finally(() => setView("state", ""))
  }

  return (
    <div class="flex h-full flex-col overflow-y-auto px-4 pb-10 sm:px-10 sm:pb-10">
      <Show
        when={view.page === "form"}
        fallback={
          <>
            <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
              <div class="flex max-w-[960px] flex-wrap items-center justify-between gap-3 pt-6 pb-6">
                <h2 class="text-16-medium text-text-strong">{language.t("settings.agents.title")}</h2>
                <Button size="large" variant="secondary" icon="plus-small" onClick={create}>
                  New agent
                </Button>
              </div>
            </div>

            <div class="flex max-w-[960px] flex-col gap-1">
              <Tabs value={view.tab} onChange={(value) => setView("tab", value as Tab)} variant="settings" class="mb-3">
                <Tabs.List>
                  <For each={tabs}>
                    {(tab) => (
                      <Tabs.Trigger value={tab}>
                        {tab === "all" ? "All" : tab === "agent" ? "Agents" : "Legacy skills"}
                      </Tabs.Trigger>
                    )}
                  </For>
                </Tabs.List>
              </Tabs>
              <SettingsList>
                <Show
                  when={!agents.loading}
                  fallback={
                    <div class="py-4 text-14-regular text-text-weak">
                      {language.t("common.loading")}
                      {language.t("common.loading.ellipsis")}
                    </div>
                  }
                >
                  <Show
                    when={typed(agents(), view.tab).length > 0}
                    fallback={<div class="py-4 text-14-regular text-text-weak">No manageable agents</div>}
                  >
                    <For each={typed(agents(), view.tab)}>
                      {(item) => (
                        <div class="flex flex-wrap items-center justify-between gap-4 border-b border-border-weak-base py-4 last:border-none">
                          <div class="flex min-w-0 flex-1 items-start gap-3">
                            <Logo name={item.name} uri={item.meta.logo?.uri} alt={item.meta.logo?.alt} />
                            <div class="flex min-w-0 flex-1 flex-col gap-2">
                              <div class="flex min-w-0 flex-wrap items-center gap-2">
                                <span class="truncate text-14-medium text-text-strong">{item.name}</span>
                                <Tag>{source(item)}</Tag>
                                <For each={versions(item.meta)}>{(part) => <Tag>{part}</Tag>}</For>
                                <Show when={item.kind === "skill"}>
                                  <Tag>Legacy skill</Tag>
                                </Show>
                                <Show when={item.disabled}>
                                  <Tag>Disabled</Tag>
                                </Show>
                                <Show when={item.diagnostics.length > 0}>
                                  <Tag>{item.diagnostics.length} diagnostics</Tag>
                                </Show>
                              </div>
                              <span class="line-clamp-2 text-12-regular text-text-weak">
                                {item.effective.description}
                              </span>
                              <span class="text-11-regular text-text-weaker">{summary(item)}</span>
                              <Show when={overview(item.meta).length > 0}>
                                <span class="line-clamp-2 text-11-regular text-text-weaker">
                                  {overview(item.meta).join(" / ")}
                                </span>
                              </Show>
                            </div>
                          </div>
                          <div class="flex shrink-0 items-center gap-2">
                            <Button
                              data-action="agent-select"
                              size="small"
                              variant="secondary"
                              icon="edit"
                              onClick={() => select(item)}
                            >
                              Details
                            </Button>
                            <Button
                              data-action="agent-state"
                              size="small"
                              variant="ghost"
                              disabled={view.state === item.id}
                              onClick={() => void toggle(item)}
                            >
                              {item.disabled ? "Enable" : "Disable"}
                            </Button>
                          </div>
                        </div>
                      )}
                    </For>
                  </Show>
                </Show>
              </SettingsList>
            </div>
          </>
        }
      >
        <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
          <div class="flex max-w-[960px] flex-wrap items-center justify-between gap-3 pt-6 pb-6">
            <div class="flex min-w-0 items-center gap-2">
              <Button size="large" variant="ghost" icon="arrow-left" onClick={back}>
                Back
              </Button>
              <div class="flex min-w-0 items-center gap-2">
                <Icon name={view.mode === "create" ? "plus-small" : "edit"} class="text-icon-weak-base" />
                <span class="truncate text-16-medium text-text-strong">
                  {view.mode === "create" ? "New agent" : current()?.name || language.t("common.edit")}
                </span>
                <Show when={current()}>
                  {(item) => (
                    <>
                      <Tag>{source(item())}</Tag>
                      <Show when={!item().editable}>
                        <Tag>Override</Tag>
                      </Show>
                    </>
                  )}
                </Show>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <SelectField
                label="Scope"
                value={form.scope}
                options={scopes}
                onChange={(value) => setForm("scope", value as Scope)}
                inline
              />
              <Button
                data-action="agent-save"
                size="large"
                variant="primary"
                disabled={view.saving}
                onClick={() => void save()}
              >
                {view.saving ? language.t("common.saving") : language.t("common.save")}
              </Button>
            </div>
          </div>
        </div>

        <div class="flex max-w-[960px] min-w-0 flex-col gap-5">
          <SettingsList>
            <div class="flex flex-col gap-5 py-4">
              <div class="flex flex-col gap-3">
                <h3 class="text-14-medium text-text-strong">Metadata</h3>
                <div class="flex min-w-0 items-start gap-3">
                  <Logo name={form.name || form.id || "Agent"} uri={form.raw?.logo?.uri} alt={form.raw?.logo?.alt} />
                  <div class="flex min-w-0 flex-1 flex-col gap-2">
                    <div class="flex flex-wrap items-center gap-2">
                      <For each={versions(form.raw)}>{(part) => <Tag>{part}</Tag>}</For>
                      <Show when={view.diagnostics.length > 0}>
                        <Tag>{view.diagnostics.length} diagnostics</Tag>
                      </Show>
                      <Show when={versions(form.raw).length === 0 && view.diagnostics.length === 0}>
                        <span class="text-12-regular text-text-weak">No RFC metadata versions</span>
                      </Show>
                    </div>
                    <Show
                      when={overview(form.raw).length > 0}
                      fallback={<span class="text-12-regular text-text-weak">No RFC metadata summary fields</span>}
                    >
                      <div class="flex flex-wrap gap-2">
                        <For each={overview(form.raw)}>{(part) => <Tag>{part}</Tag>}</For>
                      </div>
                    </Show>
                  </div>
                </div>
              </div>

              <Section title="Profile">
                <Field
                  label="ID"
                  value={form.id}
                  disabled={view.mode !== "create"}
                  onChange={(value) => setForm("id", value)}
                />
                <Field label="Name" value={form.name} onChange={(value) => setForm("name", value)} />
                <Field label="Role" value={form.role} onChange={(value) => setForm("role", value)} />
                <Field
                  label="Description"
                  value={form.description}
                  onChange={(value) => setForm("description", value)}
                />
                <Field
                  label="Identity"
                  value={form.identity}
                  multiline
                  class="min-h-48"
                  onChange={(value) => setForm("identity", value)}
                />
                <Field
                  label="Rules"
                  value={form.rules}
                  multiline
                  class="min-h-48"
                  onChange={(value) => setForm("rules", value)}
                />
              </Section>

              <Section title="Runtime">
                <SelectField
                  label="Mode"
                  value={form.mode}
                  options={modes}
                  onChange={(value) => setForm("mode", value as Mode)}
                />
                <SelectField
                  label="Runner"
                  value={form.runner}
                  options={runners}
                  onChange={(value) => setForm("runner", value as Runner)}
                />
                <Check label="Hidden" checked={form.hidden} onChange={(value) => setForm("hidden", value)} />
                <Check label="Entry primary" checked={form.primary} onChange={(value) => setForm("primary", value)} />
                <Check
                  label="Entry delegable"
                  checked={form.delegable}
                  onChange={(value) => setForm("delegable", value)}
                />
                <Check
                  label="Entry mentionable"
                  checked={form.mentionable}
                  onChange={(value) => setForm("mentionable", value)}
                />
                <Check label="Entry default" checked={form.default} onChange={(value) => setForm("default", value)} />
                <Check
                  label="Entry hidden"
                  checked={form.entryHidden}
                  onChange={(value) => setForm("entryHidden", value)}
                />
              </Section>

              <Section title="Capability">
                <Field label="Purpose" value={form.purpose} onChange={(value) => setForm("purpose", value)} />
                <Field label="Tags" value={form.tags} onChange={(value) => setForm("tags", value)} />
                <SelectField
                  label="Cost"
                  value={form.cost}
                  options={costs}
                  onChange={(value) => setForm("cost", value as Cost)}
                />
                <Check label="Writes files" checked={form.writes} onChange={(value) => setForm("writes", value)} />
              </Section>

              <Section title="Permissions">
                <SelectField
                  label="Permission mode"
                  value={form.perm}
                  options={perms}
                  onChange={(value) => setForm("perm", value as Perm)}
                />
                <Check
                  label="Inherit permissions"
                  checked={form.inherit}
                  onChange={(value) => setForm("inherit", value)}
                />
                <Field
                  label="Allowed tools"
                  value={form.allowed}
                  multiline
                  onChange={(value) => setForm("allowed", value)}
                />
                <Field
                  label="Denied tools"
                  value={form.denied}
                  multiline
                  onChange={(value) => setForm("denied", value)}
                />
              </Section>

              <Section title="Advanced JSON">
                <div class="flex flex-col gap-2 sm:col-span-2">
                  <span class="text-12-medium text-text-weak">Raw RFC metadata</span>
                  <pre class="max-h-80 overflow-auto rounded-md border border-border-weak-base bg-surface-base px-3 py-3 text-12-regular text-text-strong">
                    {json(form)}
                  </pre>
                </div>
              </Section>

              <Show when={view.diagnostics.length > 0}>
                <div class="flex flex-col gap-2 rounded-md border border-border-base bg-surface-strong px-3 py-3">
                  <For each={view.diagnostics}>
                    {(item) => (
                      <div class="flex flex-wrap gap-2 text-12-regular">
                        <Tag>{item.level}</Tag>
                        <Show when={item.category}>
                          <Tag>{item.category}</Tag>
                        </Show>
                        <Show when={item.field}>
                          <Tag>{item.field}</Tag>
                        </Show>
                        <span class="text-text-strong">{item.message}</span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </SettingsList>
        </div>
      </Show>
    </div>
  )
}
