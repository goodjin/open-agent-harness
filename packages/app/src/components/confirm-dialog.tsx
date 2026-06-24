import { Button } from "@open-agent-harness/ui/button"
import { useDialog } from "@open-agent-harness/ui/context/dialog"
import { Dialog } from "@open-agent-harness/ui/dialog"
import { useLanguage } from "@/context/language"

export type ConfirmDialogInput = {
  title: string
  description: string
  confirmLabel: string
  cancelLabel?: string
}

export function useConfirmDialog() {
  const dialog = useDialog()
  const language = useLanguage()

  return (input: ConfirmDialogInput) =>
    new Promise<boolean>((resolve) => {
      let done = false
      const finish = (value: boolean) => {
        if (done) return
        done = true
        dialog.close()
        resolve(value)
      }

      dialog.show(
        () => (
          <Dialog title={input.title} fit>
            <div class="flex flex-col gap-4 px-5 pb-4 min-w-[360px]">
              <div class="text-12-regular text-text-weak">{input.description}</div>
              <div class="flex justify-end gap-2">
                <Button variant="ghost" size="large" onClick={() => finish(false)}>
                  {input.cancelLabel ?? language.t("common.cancel")}
                </Button>
                <Button variant="primary" size="large" onClick={() => finish(true)}>
                  {input.confirmLabel}
                </Button>
              </div>
            </div>
          </Dialog>
        ),
        () => finish(false),
      )
    })
}
