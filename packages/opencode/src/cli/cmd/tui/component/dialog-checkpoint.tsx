import { createMemo, createResource, onMount } from "solid-js"
import { DialogSelect } from "@tui/ui/dialog-select"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useToast } from "@tui/ui/toast"
import { Locale } from "@/util/locale"

export function DialogCheckpoint(props: { sessionID: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const [items, { refetch }] = createResource(
    () => props.sessionID,
    async (sessionID) => {
      const result = await sdk.client.session.checkpoints({ sessionID })
      return result.data ?? []
    },
    {
      initialValue: [],
    },
  )

  const options = createMemo(() =>
    items()
      .toSorted((a, b) => b.timestamp - a.timestamp)
      .map((item) => ({
        value: item.hash,
        title: Locale.datetime(item.timestamp),
        description: item.hash.slice(0, 12),
        footer: item.partID ? "step" : "message",
      })),
  )

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title="Checkpoints"
      options={options()}
      onFilter={() => refetch()}
      onSelect={async (option) => {
        const ok = await DialogConfirm.show(
          dialog,
          "Restore Checkpoint",
          "Restore workspace files to this checkpoint?",
        )
        if (!ok) return
        const result = await sdk.client.session.restore({
          sessionID: props.sessionID,
          hash: option.value,
        })
        if (result.error) {
          toast.show({
            variant: "error",
            message: "Failed to restore checkpoint",
            duration: 5000,
          })
          return
        }
        toast.show({
          variant: "success",
          message: "Checkpoint restored",
          duration: 3000,
        })
      }}
    />
  )
}
