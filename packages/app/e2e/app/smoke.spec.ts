import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"

test("app boots project session without vite transform overlay", async ({ page, gotoSession }) => {
  const errors: string[] = []

  page.on("pageerror", (err) => {
    errors.push(err.message)
  })
  page.on("console", (msg) => {
    if (!/vite:esbuild|Transform failed|Internal server error/i.test(msg.text())) return
    errors.push(msg.text())
  })

  await gotoSession()

  await expect(page.getByText("[plugin:vite:esbuild]")).toHaveCount(0)
  await expect(page.getByText("Transform failed")).toHaveCount(0)
  await expect(page.locator(promptSelector)).toBeVisible()
  expect(errors).toEqual([])
})
