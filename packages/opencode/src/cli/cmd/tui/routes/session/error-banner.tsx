import { createMemo, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../../context/theme"
import { useSync } from "../../context/sync"
import { useSDK } from "../../context/sdk"
import { useKeyboard } from "@opentui/solid"
import { useKeybind } from "../../context/keybind"
import { useDialog } from "../../ui/dialog"
import { SplitBorder } from "../../component/border"

type SessionStatusInfo =
  | { type: "idle" }
  | { type: "running" }
  | { type: "waiting_permission" }
  | { type: "waiting_user" }
  | { type: "error"; message: string }
  | { type: "retry"; attempt: number; message: string; next: number }

export function ErrorBanner(props: { sessionID: string }) {
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const dialog = useDialog()

  const sessionStatus = createMemo(
    () => (sync.data.session_status[props.sessionID] ?? { type: "idle" }) as SessionStatusInfo,
  )

  const isError = createMemo(() => sessionStatus().type === "error")
  const errorMessage = createMemo(() => {
    const status = sessionStatus()
    return status.type === "error" ? status.message : ""
  })

  const handleDismiss = () => {
    // Reset session status to idle to dismiss the error banner
    sdk.client.session.abort({ sessionID: props.sessionID }).catch(() => {})
  }

  useKeyboard((evt) => {
    if (!isError()) return
    if (dialog.stack.length > 0) return

    // Allow escape or ctrl+c to dismiss
    if (evt.name === "escape" || keybind.match("app_exit", evt) || evt.name === "return") {
      evt.preventDefault()
      handleDismiss()
    }
  })

  return (
    <Show when={isError()}>
      <box
        backgroundColor={theme.backgroundPanel}
        border={["left"]}
        borderColor={theme.error}
        customBorderChars={SplitBorder.customBorderChars}
      >
        <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
          <box flexDirection="row" gap={1} paddingLeft={1} flexShrink={0}>
            <text fg={theme.error}>✗</text>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              Error
            </text>
          </box>
          <box paddingLeft={1} paddingRight={1}>
            <text fg={theme.textMuted}>{errorMessage()}</text>
          </box>
          <box paddingLeft={1} paddingTop={1} flexDirection="row" gap={2}>
            <text fg={theme.text}>
              <text fg={theme.textMuted}>Press </text>
              <text fg={theme.text}>enter</text>
              <text fg={theme.textMuted}> or </text>
              <text fg={theme.text}>esc</text>
              <text fg={theme.textMuted}> to dismiss</text>
            </text>
          </box>
        </box>
      </box>
    </Show>
  )
}
