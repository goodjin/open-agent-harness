import { Component } from "solid-js"
import { Dialog } from "@open-agent-harness/ui/dialog"
import { Button } from "@open-agent-harness/ui/button"
import { Tabs } from "@open-agent-harness/ui/tabs"
import { Icon } from "@open-agent-harness/ui/icon"
import { useDialog } from "@open-agent-harness/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsGeneral } from "./settings-general"
import { SettingsKeybinds } from "./settings-keybinds"
import { SettingsProviders } from "./settings-providers"
import { SettingsModels } from "./settings-models"
import { SettingsAgents } from "./settings-agents"

export const SETTINGS_PANEL_EVENT = "open-agent-harness:settings"

export type SettingsPanelDetail = {
  defaultTab?: string
  agent?: string
}

export function requestSettingsPanel(detail: SettingsPanelDetail = {}) {
  window.dispatchEvent(new CustomEvent<SettingsPanelDetail>(SETTINGS_PANEL_EVENT, { detail }))
}

export const SettingsPanel: Component<SettingsPanelDetail & { onClose: () => void }> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()

  return (
    <div class="flex h-full min-w-0 flex-col bg-background-base">
      <div class="flex h-12 shrink-0 items-center gap-2 border-b border-border-weak-base px-3">
        <Button size="large" variant="ghost" icon="arrow-left" onClick={props.onClose}>
          Back
        </Button>
        <span class="truncate text-14-medium text-text-strong">{language.t("command.settings.open")}</span>
      </div>
      <Tabs
        orientation="vertical"
        variant="settings"
        defaultValue={props.defaultTab ?? "general"}
        class="min-h-0 flex-1 settings-dialog"
      >
        <Tabs.List>
          <div class="flex flex-col justify-between h-full w-full">
            <div class="flex flex-col gap-3 w-full pt-3">
              <div class="flex flex-col gap-3">
                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{language.t("settings.section.desktop")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="general">
                      <Icon name="sliders" />
                      {language.t("settings.tab.general")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="shortcuts">
                      <Icon name="keyboard" />
                      {language.t("settings.tab.shortcuts")}
                    </Tabs.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{language.t("settings.section.server")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="providers">
                      <Icon name="providers" />
                      {language.t("settings.providers.title")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="models">
                      <Icon name="models" />
                      {language.t("settings.models.title")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="agents">
                      <Icon name="brain" />
                      {language.t("settings.agents.title")}
                    </Tabs.Trigger>
                  </div>
                </div>
              </div>
            </div>
            <div class="flex flex-col gap-1 pl-1 py-1 text-12-medium text-text-weak">
              <span>{language.t("app.name.desktop")}</span>
              <span class="text-11-regular">v{platform.version}</span>
            </div>
          </div>
        </Tabs.List>
        <Tabs.Content value="general" class="no-scrollbar">
          <SettingsGeneral />
        </Tabs.Content>
        <Tabs.Content value="shortcuts" class="no-scrollbar">
          <SettingsKeybinds />
        </Tabs.Content>
        <Tabs.Content value="providers" class="no-scrollbar">
          <SettingsProviders />
        </Tabs.Content>
        <Tabs.Content value="models" class="no-scrollbar">
          <SettingsModels />
        </Tabs.Content>
        <Tabs.Content value="agents" class="no-scrollbar">
          <SettingsAgents selected={props.agent} />
        </Tabs.Content>
      </Tabs>
    </div>
  )
}

export const DialogSettings: Component<{ defaultTab?: string; agent?: string }> = (props) => {
  const dialog = useDialog()

  return (
    <Dialog size="x-large" transition>
      <SettingsPanel defaultTab={props.defaultTab} agent={props.agent} onClose={() => dialog.close()} />
    </Dialog>
  )
}
