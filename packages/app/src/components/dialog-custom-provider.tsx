import { Button } from "@open-agent-harness/ui/button"
import { useDialog } from "@open-agent-harness/ui/context/dialog"
import { Dialog } from "@open-agent-harness/ui/dialog"
import { IconButton } from "@open-agent-harness/ui/icon-button"
import { ProviderIcon } from "@open-agent-harness/ui/provider-icon"
import { TextField } from "@open-agent-harness/ui/text-field"
import { showToast } from "@open-agent-harness/ui/toast"
import { batch, For } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Link } from "@/components/link"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { type FormState, headerRow, modelRow, validateCustomProvider } from "./dialog-custom-provider-form"
import { DialogSelectProvider } from "./dialog-select-provider"

type Props = {
  back?: "providers" | "close"
  providerID?: string
}

export function DialogCustomProvider(props: Props) {
  const dialog = useDialog()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const cfg = props.providerID ? globalSync.data.config.provider?.[props.providerID] : undefined
  const opts = cfg?.options ?? {}
  const heads =
    opts.headers && typeof opts.headers === "object" && !Array.isArray(opts.headers)
      ? Object.entries(opts.headers).filter((item): item is [string, string] => typeof item[1] === "string")
      : []
  const rows = Object.entries(cfg?.models ?? {}).map(([id, model]) => ({
    ...modelRow(),
    id,
    name: typeof model.name === "string" ? model.name : id,
    concurrency: Number.isInteger(model.concurrency) ? String(model.concurrency) : "",
  }))

  const [form, setForm] = createStore<FormState>({
    providerID: props.providerID ?? "",
    name: cfg?.name ?? "",
    baseURL: typeof opts.baseURL === "string" ? opts.baseURL : "",
    apiKey: cfg?.env?.[0] ? `{env: ${cfg.env[0]}}` : "",
    concurrency: Number.isInteger(cfg?.concurrency) ? String(cfg?.concurrency) : "",
    models: rows.length ? rows : [modelRow()],
    headers: heads.length ? heads.map(([key, value]) => ({ ...headerRow(), key, value })) : [headerRow()],
    saving: false,
    err: {},
  })

  const goBack = () => {
    if (props.back === "close") {
      dialog.close()
      return
    }
    dialog.show(() => <DialogSelectProvider />)
  }

  const addModel = () => {
    setForm(
      "models",
      produce((rows) => {
        rows.push(modelRow())
      }),
    )
  }

  const removeModel = (index: number) => {
    if (form.models.length <= 1) return
    setForm(
      "models",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const addHeader = () => {
    setForm(
      "headers",
      produce((rows) => {
        rows.push(headerRow())
      }),
    )
  }

  const removeHeader = (index: number) => {
    if (form.headers.length <= 1) return
    setForm(
      "headers",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const setField = (key: "providerID" | "name" | "baseURL" | "apiKey" | "concurrency", value: string) => {
    setForm(key, value)
    if (key === "apiKey") return
    setForm("err", key, undefined)
  }

  const setModel = (index: number, key: "id" | "name" | "concurrency", value: string) => {
    batch(() => {
      setForm("models", index, key, value)
      setForm("models", index, "err", key, undefined)
    })
  }

  const setHeader = (index: number, key: "key" | "value", value: string) => {
    batch(() => {
      setForm("headers", index, key, value)
      setForm("headers", index, "err", key, undefined)
    })
  }

  const validate = () => {
    const output = validateCustomProvider({
      form,
      t: language.t,
      disabledProviders: globalSync.data.config.disabled_providers ?? [],
      existingProviderIDs: new Set(globalSync.data.provider.all.map((p) => p.id)),
      editProviderID: props.providerID,
    })
    batch(() => {
      setForm("err", output.err)
      output.models.forEach((err, index) => setForm("models", index, "err", err))
      output.headers.forEach((err, index) => setForm("headers", index, "err", err))
    })
    return output.result
  }

  const save = async (e: SubmitEvent) => {
    e.preventDefault()
    if (form.saving) return

    const result = validate()
    if (!result) return

    setForm("saving", true)

    const disabledProviders = globalSync.data.config.disabled_providers ?? []
    const nextDisabled = disabledProviders.filter((id) => id !== result.providerID)

    const auth = result.key
      ? globalSDK.client.auth.set({
          providerID: result.providerID,
          auth: {
            type: "api",
            key: result.key,
          },
        })
      : Promise.resolve()

    auth
      .then(() => {
        const config = (() => {
          if (!props.providerID || !cfg) return result.config
          const options = { ...(cfg.options ?? {}), ...result.config.options }
          if (!("headers" in result.config.options)) delete options.headers
          return { ...cfg, ...result.config, options }
        })()
        return globalSync.updateConfig({ provider: { [result.providerID]: config }, disabled_providers: nextDisabled })
      })
      .then(() => {
        dialog.close()
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.connect.toast.connected.title", { provider: result.name }),
          description: language.t("provider.connect.toast.connected.description", { provider: result.name }),
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
      .finally(() => {
        setForm("saving", false)
      })
  }

  return (
    <Dialog
      title={
        <IconButton
          tabIndex={-1}
          icon="arrow-left"
          variant="ghost"
          onClick={goBack}
          aria-label={language.t("common.goBack")}
        />
      }
      transition
    >
      <div class="flex flex-col gap-6 px-2.5 pb-3 overflow-y-auto max-h-[60vh]">
        <div class="px-2.5 flex gap-4 items-center">
          <ProviderIcon id="synthetic" class="size-5 shrink-0 icon-strong-base" />
          <div class="text-16-medium text-text-strong">{language.t("provider.custom.title")}</div>
        </div>

        <form onSubmit={save} class="px-2.5 pb-6 flex flex-col gap-6">
          <p class="text-14-regular text-text-base">
            {language.t("provider.custom.description.prefix")}
            <Link href="https://opencode.ai/docs/providers/#custom-provider" tabIndex={-1}>
              {language.t("provider.custom.description.link")}
            </Link>
            {language.t("provider.custom.description.suffix")}
          </p>

          <div class="flex flex-col gap-4">
            <TextField
              autofocus
              label={language.t("provider.custom.field.providerID.label")}
              placeholder={language.t("provider.custom.field.providerID.placeholder")}
              description={language.t("provider.custom.field.providerID.description")}
              value={form.providerID}
              onChange={(v) => setField("providerID", v)}
              validationState={form.err.providerID ? "invalid" : undefined}
              error={form.err.providerID}
              readOnly={!!props.providerID}
            />
            <TextField
              label={language.t("provider.custom.field.name.label")}
              placeholder={language.t("provider.custom.field.name.placeholder")}
              value={form.name}
              onChange={(v) => setField("name", v)}
              validationState={form.err.name ? "invalid" : undefined}
              error={form.err.name}
            />
            <TextField
              label={language.t("provider.custom.field.baseURL.label")}
              placeholder={language.t("provider.custom.field.baseURL.placeholder")}
              value={form.baseURL}
              onChange={(v) => setField("baseURL", v)}
              validationState={form.err.baseURL ? "invalid" : undefined}
              error={form.err.baseURL}
            />
            <TextField
              label={language.t("provider.custom.field.apiKey.label")}
              placeholder={language.t("provider.custom.field.apiKey.placeholder")}
              description={language.t("provider.custom.field.apiKey.description")}
              value={form.apiKey}
              onChange={(v) => setField("apiKey", v)}
            />
            <TextField
              label={language.t("provider.custom.field.concurrency.label")}
              placeholder={language.t("provider.custom.field.concurrency.placeholder")}
              description={language.t("provider.custom.field.concurrency.description")}
              value={form.concurrency}
              onChange={(v) => setField("concurrency", v)}
              validationState={form.err.concurrency ? "invalid" : undefined}
              error={form.err.concurrency}
            />
          </div>

          <div class="flex flex-col gap-3">
            <label class="text-12-medium text-text-weak">{language.t("provider.custom.models.label")}</label>
            <For each={form.models}>
              {(m, i) => (
                <div class="flex gap-2 items-start" data-row={m.row}>
                  <div class="flex-1">
                    <TextField
                      label={language.t("provider.custom.models.id.label")}
                      hideLabel
                      placeholder={language.t("provider.custom.models.id.placeholder")}
                      value={m.id}
                      onChange={(v) => setModel(i(), "id", v)}
                      validationState={m.err.id ? "invalid" : undefined}
                      error={m.err.id}
                    />
                  </div>
                  <div class="flex-1">
                    <TextField
                      label={language.t("provider.custom.models.name.label")}
                      hideLabel
                      placeholder={language.t("provider.custom.models.name.placeholder")}
                      value={m.name}
                      onChange={(v) => setModel(i(), "name", v)}
                      validationState={m.err.name ? "invalid" : undefined}
                      error={m.err.name}
                    />
                  </div>
                  <div class="w-24">
                    <TextField
                      label={language.t("provider.custom.models.concurrency.label")}
                      hideLabel
                      placeholder={language.t("provider.custom.models.concurrency.placeholder")}
                      value={m.concurrency}
                      onChange={(v) => setModel(i(), "concurrency", v)}
                      validationState={m.err.concurrency ? "invalid" : undefined}
                      error={m.err.concurrency}
                    />
                  </div>
                  <IconButton
                    type="button"
                    icon="trash"
                    variant="ghost"
                    class="mt-1.5"
                    onClick={() => removeModel(i())}
                    disabled={form.models.length <= 1}
                    aria-label={language.t("provider.custom.models.remove")}
                  />
                </div>
              )}
            </For>
            <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={addModel} class="self-start">
              {language.t("provider.custom.models.add")}
            </Button>
          </div>

          <div class="flex flex-col gap-3">
            <label class="text-12-medium text-text-weak">{language.t("provider.custom.headers.label")}</label>
            <For each={form.headers}>
              {(h, i) => (
                <div class="flex gap-2 items-start" data-row={h.row}>
                  <div class="flex-1">
                    <TextField
                      label={language.t("provider.custom.headers.key.label")}
                      hideLabel
                      placeholder={language.t("provider.custom.headers.key.placeholder")}
                      value={h.key}
                      onChange={(v) => setHeader(i(), "key", v)}
                      validationState={h.err.key ? "invalid" : undefined}
                      error={h.err.key}
                    />
                  </div>
                  <div class="flex-1">
                    <TextField
                      label={language.t("provider.custom.headers.value.label")}
                      hideLabel
                      placeholder={language.t("provider.custom.headers.value.placeholder")}
                      value={h.value}
                      onChange={(v) => setHeader(i(), "value", v)}
                      validationState={h.err.value ? "invalid" : undefined}
                      error={h.err.value}
                    />
                  </div>
                  <IconButton
                    type="button"
                    icon="trash"
                    variant="ghost"
                    class="mt-1.5"
                    onClick={() => removeHeader(i())}
                    disabled={form.headers.length <= 1}
                    aria-label={language.t("provider.custom.headers.remove")}
                  />
                </div>
              )}
            </For>
            <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={addHeader} class="self-start">
              {language.t("provider.custom.headers.add")}
            </Button>
          </div>

          <Button class="w-auto self-start" type="submit" size="large" variant="primary" disabled={form.saving}>
            {form.saving ? language.t("common.saving") : language.t(props.providerID ? "common.save" : "common.submit")}
          </Button>
        </form>
      </div>
    </Dialog>
  )
}
