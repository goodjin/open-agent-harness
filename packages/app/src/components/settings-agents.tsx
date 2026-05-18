import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Switch } from "@opencode-ai/ui/switch"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import type { AgentManageDiagnostic, AgentManageInfo } from "@opencode-ai/sdk/v2"
import { createEffect, createResource, For, Show, type Component, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { SettingsList } from "./settings-list"
import {
  blank,
  costs,
  fill,
  load,
  message,
  modes,
  perms,
  runners,
  save as saveAgent,
  scopes,
  summary,
  toggle as toggleAgent,
  type Cost,
  type Form,
  type Mode,
  type Perm,
  type Runner,
  type Scope,
  type View,
} from "./settings-agents-helpers"

const SelectField: Component<{
  label: string
  value: string
  options: string[]
  onChange: (value: string) => void
  disabled?: boolean
}> = (props) => (
  <label class="flex flex-col gap-1 text-12-medium text-text-weak">
    {props.label}
    <select
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.currentTarget.value)}
      class="h-8 rounded-md border border-border-base bg-surface-base px-2 text-13-regular text-text-strong"
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
}> = (props) => (
  <TextField
    label={props.label}
    value={props.value}
    onChange={props.onChange}
    disabled={props.disabled}
    multiline={props.multiline}
  />
)

const Section: Component<{ title: string; children: JSX.Element }> = (props) => (
  <div class="flex flex-col gap-3">
    <h3 class="text-14-medium text-text-strong">{props.title}</h3>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">{props.children}</div>
  </div>
)

export const SettingsAgents: Component = () => {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const [view, setView] = createStore<{
    mode: View
    selected: string
    saving: boolean
    state: string
    diagnostics: AgentManageDiagnostic[]
  }>({
    mode: "edit",
    selected: "",
    saving: false,
    state: "",
    diagnostics: [],
  })
  const [form, setForm] = createStore<Form>(blank())

  const [agents, actions] = createResource(async () => load(globalSDK.client.agent.manage))

  const current = () => agents()?.find((item) => item.id === view.selected)

  const select = (item: AgentManageInfo) => {
    setView("mode", "edit")
    setView("selected", item.id)
    setView("diagnostics", item.diagnostics)
    setForm(fill(item))
  }

  const create = () => {
    setView("mode", "create")
    setView("selected", "")
    setView("diagnostics", [])
    setForm(blank())
  }

  createEffect(() => {
    const list = agents()
    if (!list?.length) return
    if (view.mode === "create") return
    if (view.selected && list.some((item) => item.id === view.selected)) return
    select(list[0])
  })

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
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex max-w-[960px] flex-wrap items-center justify-between gap-3 pt-6 pb-6">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.agents.title")}</h2>
          <Button size="large" variant="secondary" icon="plus-small" onClick={create}>
            New agent
          </Button>
        </div>
      </div>

      <div class="grid max-w-[960px] grid-cols-1 gap-6 lg:grid-cols-[320px_1fr]">
        <div class="flex flex-col gap-1">
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
                when={(agents()?.length ?? 0) > 0}
                fallback={<div class="py-4 text-14-regular text-text-weak">No manageable agents</div>}
              >
                <For each={agents()}>
                  {(item) => (
                    <div class="border-b border-border-weak-base py-3 last:border-none">
                      <button
                        type="button"
                        data-action="agent-select"
                        onClick={() => select(item)}
                        class="flex w-full flex-col gap-2 rounded-md px-2 py-2 text-left hover:bg-surface-strong"
                        classList={{ "bg-surface-strong": view.selected === item.id }}
                      >
                        <div class="flex min-w-0 items-center justify-between gap-2">
                          <span class="truncate text-14-medium text-text-strong">{item.name}</span>
                          <div class="flex shrink-0 items-center gap-1">
                            <Tag>{item.source}</Tag>
                            <Show when={item.disabled}>
                              <Tag>Disabled</Tag>
                            </Show>
                          </div>
                        </div>
                        <span class="line-clamp-2 text-12-regular text-text-weak">{item.effective.description}</span>
                        <span class="text-11-regular text-text-weaker">{summary(item)}</span>
                      </button>
                      <div class="flex justify-end pt-1">
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

        <div class="flex min-w-0 flex-col gap-5">
          <SettingsList>
            <div class="flex flex-col gap-5 py-4">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="flex min-w-0 items-center gap-2">
                  <Icon name={view.mode === "create" ? "plus-small" : "edit"} class="text-icon-weak-base" />
                  <span class="truncate text-14-medium text-text-strong">
                    {view.mode === "create" ? "New agent" : current()?.name || language.t("common.edit")}
                  </span>
                  <Show when={current()}>
                    {(item) => (
                      <>
                        <Tag>{item().source}</Tag>
                        <Show when={!item().editable}>
                          <Tag>Override</Tag>
                        </Show>
                      </>
                    )}
                  </Show>
                </div>
                <div class="flex items-center gap-2">
                  <SelectField
                    label="Scope"
                    value={form.scope}
                    options={scopes}
                    onChange={(value) => setForm("scope", value as Scope)}
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

              <Section title="Profile">
                <Field label="ID" value={form.id} disabled={view.mode !== "create"} onChange={(value) => setForm("id", value)} />
                <Field label="Name" value={form.name} onChange={(value) => setForm("name", value)} />
                <Field label="Role" value={form.role} onChange={(value) => setForm("role", value)} />
                <Field label="Description" value={form.description} onChange={(value) => setForm("description", value)} />
                <Field label="Identity" value={form.identity} multiline onChange={(value) => setForm("identity", value)} />
                <Field label="Rules" value={form.rules} multiline onChange={(value) => setForm("rules", value)} />
              </Section>

              <Section title="Runtime">
                <SelectField label="Mode" value={form.mode} options={modes} onChange={(value) => setForm("mode", value as Mode)} />
                <SelectField
                  label="Runner"
                  value={form.runner}
                  options={runners}
                  onChange={(value) => setForm("runner", value as Runner)}
                />
                <Check label="Hidden" checked={form.hidden} onChange={(value) => setForm("hidden", value)} />
                <Check label="Entry primary" checked={form.primary} onChange={(value) => setForm("primary", value)} />
                <Check label="Entry delegable" checked={form.delegable} onChange={(value) => setForm("delegable", value)} />
                <Check label="Entry mentionable" checked={form.mentionable} onChange={(value) => setForm("mentionable", value)} />
                <Check label="Entry default" checked={form.default} onChange={(value) => setForm("default", value)} />
                <Check label="Entry hidden" checked={form.entryHidden} onChange={(value) => setForm("entryHidden", value)} />
              </Section>

              <Section title="Capability">
                <Field label="Purpose" value={form.purpose} onChange={(value) => setForm("purpose", value)} />
                <Field label="Tags" value={form.tags} onChange={(value) => setForm("tags", value)} />
                <SelectField label="Cost" value={form.cost} options={costs} onChange={(value) => setForm("cost", value as Cost)} />
                <Check label="Writes files" checked={form.writes} onChange={(value) => setForm("writes", value)} />
              </Section>

              <Section title="Permissions">
                <SelectField
                  label="Permission mode"
                  value={form.perm}
                  options={perms}
                  onChange={(value) => setForm("perm", value as Perm)}
                />
                <Check label="Inherit permissions" checked={form.inherit} onChange={(value) => setForm("inherit", value)} />
                <Field label="Allowed tools" value={form.allowed} multiline onChange={(value) => setForm("allowed", value)} />
                <Field label="Denied tools" value={form.denied} multiline onChange={(value) => setForm("denied", value)} />
              </Section>

              <Show when={view.diagnostics.length > 0}>
                <div class="flex flex-col gap-2 rounded-md border border-border-base bg-surface-strong px-3 py-3">
                  <For each={view.diagnostics}>
                    {(item) => (
                      <div class="flex gap-2 text-12-regular">
                        <Tag>{item.level}</Tag>
                        <span class="text-text-strong">{item.message}</span>
                        <Show when={item.field}>
                          <span class="text-text-weak">{item.field}</span>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </SettingsList>
        </div>
      </div>
    </div>
  )
}
